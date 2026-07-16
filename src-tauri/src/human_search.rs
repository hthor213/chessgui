// Spec 213 Phase 3 — Tier 1 "human-visible tree" search: Eval_R.
//
// Eval_R is defined, not vibed: the minimax value of the position when only
// the moves that rating-R humans actually consider exist on the board.
// Concretely:
//
//   * RESTRICTION — at every interior node the move set is the top-p nucleus
//     of the Maia-R policy: sort legal moves by policy probability descending
//     (ties broken by UCI string, so ordering is total and stable), take the
//     smallest prefix whose cumulative mass reaches `top_p`, then clamp the
//     set to [1, max_candidates]. BOTH sides are restricted — the opponent is
//     a rating-R human too. A refutation outside the nucleus does not exist
//     for this eval; that is the +1.2 → +3.1 jump semantics.
//   * BACKUP — negamax: value(node) = max over visible candidates of
//     −value(child), all values side-to-move POV centipawns. Terminal nodes
//     short-circuit: checkmate = −(MATE_CP − ply) (prefers faster mates),
//     stalemate / insufficient material = 0.
//   * LEAVES — nodes at depth 0 or past the node budget are scored by
//     Stockfish at a FIXED depth (reproducible per SF build, same determinism
//     claim as persona.rs verify_candidates). `ucinewgame` is sent before
//     every leaf so hash carry-over can't make results order-dependent.
//   * TRANSPOSITION CACHE — keyed (EPD, band, knobs); an entry stores the
//     depth it was searched to and is reused when that depth ≥ the remaining
//     depth. Leaf evals are cached at depth 0, so slider revisits and the
//     future background sweep (Phase-3 follow-up) reuse work across
//     invocations. The cache persists in Tauri state for the app session.
//   * DETERMINISM — there is no sampling anywhere: candidate selection is a
//     stable sort + deterministic cutoff, and leaves are fixed-depth on a
//     single-threaded SF process. Same (fen, band, config, SF build) ⇒ same
//     result, no seed required.
//
// Policy access and leaf evaluation are injected (`PolicySource` /
// `LeafEvaluator`) so the search math is provable on synthetic hand-built
// policies with known minimax answers — the spec's named unit tests.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::process::Stdio;

use serde::Serialize;
use shakmaty::fen::{Epd, Fen};
use shakmaty::{CastlingMode, Chess, Color, EnPassantMode, Position};
use tauri::State;
use tokio::io::BufReader;
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::Mutex as AsyncMutex;

use crate::maia::{self, MaiaMove, MaiaState};
use crate::persona::{fen_after, parse_score_cp, read_until, resolve_stockfish, sf_send, MATE_CP};

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/// Defaults sized for the spec's 1–4 s/stop tier-1 budget on this machine:
/// ≤ max_candidates^depth ≈ 64 leaves × (~15 ms warm policy + ~20 ms SF d10).
pub const DEFAULT_TOP_P: f64 = 0.80;
pub const DEFAULT_MAX_CANDIDATES: usize = 4;
pub const DEFAULT_DEPTH: u32 = 3;
pub const DEFAULT_MAX_NODES: usize = 300;
pub const DEFAULT_LEAF_DEPTH: u32 = 10;

/// Session transposition-cache size bound; cleared wholesale when exceeded
/// (crude but sufficient — entries are tiny and a clear only costs re-search).
const TT_CAP: usize = 20_000;

#[derive(Debug, Clone)]
pub struct HumanSearchConfig {
    /// Maia rating band R (the policy that defines "visible").
    pub band: u32,
    /// Cumulative policy mass a node's candidate set must reach.
    pub top_p: f64,
    /// Hard cap on candidates per node (breadth bound).
    pub max_candidates: usize,
    /// Search depth in plies (depth bound).
    pub depth: u32,
    /// Total node budget; nodes past it are scored as leaves (cost bound).
    pub max_nodes: usize,
    /// Fixed Stockfish depth for leaf evals.
    pub leaf_depth: u32,
}

impl HumanSearchConfig {
    pub fn new(band: u32) -> Self {
        Self {
            band,
            top_p: DEFAULT_TOP_P,
            max_candidates: DEFAULT_MAX_CANDIDATES,
            depth: DEFAULT_DEPTH,
            max_nodes: DEFAULT_MAX_NODES,
            leaf_depth: DEFAULT_LEAF_DEPTH,
        }
    }
}

// ---------------------------------------------------------------------------
// Injectable dependencies
// ---------------------------------------------------------------------------

pub type BoxFut<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Source of the rating-R move distribution for a position. Production wraps
/// maia::query_policy; tests use hand-built tables.
pub trait PolicySource: Send + Sync {
    fn policy<'a>(&'a self, fen: &'a str) -> BoxFut<'a, Result<Vec<MaiaMove>, String>>;
}

/// Fixed-depth leaf scorer, side-to-move POV centipawns. Production is a warm
/// Stockfish process; tests use tables with known values.
pub trait LeafEvaluator: Send {
    fn eval_cp<'a>(&'a mut self, fen: &'a str) -> BoxFut<'a, Result<i64, String>>;
}

// ---------------------------------------------------------------------------
// Candidate restriction (the "human-visible" rule)
// ---------------------------------------------------------------------------

/// Top-p nucleus: sort by prob desc (ties by UCI asc — total, stable order),
/// take the smallest prefix with cumulative mass ≥ `top_p`, clamp to
/// [1, max_candidates]. Pure, unit-tested directly.
pub fn restrict_candidates(
    moves: &[MaiaMove],
    top_p: f64,
    max_candidates: usize,
) -> Vec<MaiaMove> {
    let mut sorted = moves.to_vec();
    sorted.sort_by(|a, b| {
        b.prob
            .partial_cmp(&a.prob)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.uci.cmp(&b.uci))
    });
    let cap = max_candidates.max(1);
    let mut out: Vec<MaiaMove> = Vec::new();
    let mut mass = 0.0;
    for m in sorted {
        if out.len() >= cap || (!out.is_empty() && mass >= top_p) {
            break;
        }
        mass += m.prob;
        out.push(m);
    }
    out
}

// ---------------------------------------------------------------------------
// Transposition cache
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub struct TtEntry {
    /// Depth this value was searched to (0 = raw leaf eval). An entry
    /// satisfies a lookup only when its depth ≥ the remaining search depth.
    pub depth: u32,
    /// Side-to-move POV centipawns.
    pub cp: i64,
    /// Best visible move (UCI) for PV reconstruction; None at leaves.
    pub best: Option<String>,
}

pub type TranspositionTable = HashMap<String, TtEntry>;

/// EPD (FEN minus the move counters) — two positions equal-for-eval share a
/// key even when reached at different move numbers.
pub fn epd_key(fen: &str) -> Result<String, String> {
    let pos: Chess = Fen::from_ascii(fen.as_bytes())
        .map_err(|e| format!("bad FEN: {e}"))?
        .into_position(CastlingMode::Standard)
        .map_err(|e| format!("illegal position: {e}"))?;
    Ok(Epd::from_position(&pos, EnPassantMode::Legal).to_string())
}

/// Cache key: position + every knob that changes the value (band, leaf depth,
/// nucleus shape). Search depth is NOT in the key — reuse is depth-aware via
/// `TtEntry::depth` instead, so a deep entry serves shallower lookups.
fn tt_key(epd: &str, cfg: &HumanSearchConfig) -> String {
    format!(
        "{epd}|{}|{}|{:.3}|{}",
        cfg.band, cfg.leaf_depth, cfg.top_p, cfg.max_candidates
    )
}

// ---------------------------------------------------------------------------
// The search
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct HumanSearchResult {
    pub band: u32,
    /// Eval_R, White-POV centipawns (mates collapsed to ~±MATE_CP).
    pub cp_white: i64,
    /// Eval_R in White-POV pawns (cp_white / 100).
    pub pawns: f64,
    /// Search depth used (plies).
    pub depth: u32,
    /// Nodes visited (interior + leaf, excluding TT hits).
    pub nodes: usize,
    /// Stockfish leaf evaluations performed this invocation.
    pub leaf_evals: usize,
    /// Transposition-cache hits this invocation.
    pub tt_hits: usize,
    /// Best human-visible line from the root, UCI.
    pub pv: Vec<String>,
}

struct Searcher<'s> {
    cfg: &'s HumanSearchConfig,
    policy: &'s dyn PolicySource,
    leaf: &'s mut dyn LeafEvaluator,
    tt: &'s mut TranspositionTable,
    nodes: usize,
    leaf_evals: usize,
    tt_hits: usize,
}

impl<'s> Searcher<'s> {
    /// Negamax over the human-visible tree. Returns (side-to-move POV cp, pv).
    fn search<'a>(
        &'a mut self,
        fen: String,
        depth: u32,
        ply: u32,
    ) -> BoxFut<'a, Result<(i64, Vec<String>), String>> {
        Box::pin(async move {
            let pos: Chess = Fen::from_ascii(fen.as_bytes())
                .map_err(|e| format!("bad FEN: {e}"))?
                .into_position(CastlingMode::Standard)
                .map_err(|e| format!("illegal position: {e}"))?;

            // Terminal nodes need no policy and no engine.
            let legal = pos.legal_moves();
            if legal.is_empty() {
                let cp = if pos.is_checkmate() {
                    -(MATE_CP - ply as i64)
                } else {
                    0 // stalemate
                };
                return Ok((cp, Vec::new()));
            }
            if pos.is_insufficient_material() {
                return Ok((0, Vec::new()));
            }

            let key = tt_key(&Epd::from_position(&pos, EnPassantMode::Legal).to_string(), self.cfg);
            if let Some(e) = self.tt.get(&key) {
                if e.depth >= depth {
                    self.tt_hits += 1;
                    let cp = e.cp;
                    let pv = self.reconstruct_pv(&fen, depth);
                    return Ok((cp, pv));
                }
            }

            self.nodes += 1;

            // Leaf: depth exhausted or node budget spent.
            if depth == 0 || self.nodes > self.cfg.max_nodes {
                let cp = self.leaf.eval_cp(&fen).await?;
                self.leaf_evals += 1;
                self.tt.insert(key, TtEntry { depth: 0, cp, best: None });
                return Ok((cp, Vec::new()));
            }

            // Interior: restrict to the rating-R nucleus. lc0 policies only
            // list legal moves; the legality filter guards synthetic tables
            // and any upstream anomaly.
            let policy = self.policy.policy(&fen).await?;
            let legal_ucis: HashSet<String> = legal
                .iter()
                .map(|m| m.to_uci(CastlingMode::Standard).to_string())
                .collect();
            let legal_policy: Vec<MaiaMove> = policy
                .into_iter()
                .filter(|m| legal_ucis.contains(&m.uci))
                .collect();
            let visible =
                restrict_candidates(&legal_policy, self.cfg.top_p, self.cfg.max_candidates);
            if visible.is_empty() {
                // Policy carried no legal move (synthetic-table gap / lc0
                // anomaly): score the node as a leaf rather than fail the run.
                let cp = self.leaf.eval_cp(&fen).await?;
                self.leaf_evals += 1;
                self.tt.insert(key, TtEntry { depth: 0, cp, best: None });
                return Ok((cp, Vec::new()));
            }

            let mut best_cp = i64::MIN;
            let mut best_pv: Vec<String> = Vec::new();
            let mut best_move = String::new();
            for m in &visible {
                let child = fen_after(&fen, &m.uci)?;
                let (child_cp, child_pv) = self.search(child, depth - 1, ply + 1).await?;
                let v = -child_cp;
                if v > best_cp {
                    best_cp = v;
                    best_move = m.uci.clone();
                    best_pv = std::iter::once(m.uci.clone()).chain(child_pv).collect();
                }
            }

            self.tt.insert(
                key,
                TtEntry {
                    depth,
                    cp: best_cp,
                    best: Some(best_move),
                },
            );
            Ok((best_cp, best_pv))
        })
    }

    /// Rebuild a PV from cached best moves after a TT hit; stops at the first
    /// gap. Bounded by `depth` so a cache cycle can't loop.
    fn reconstruct_pv(&self, fen: &str, depth: u32) -> Vec<String> {
        let mut pv = Vec::new();
        let mut cur = fen.to_string();
        for _ in 0..depth {
            let Ok(epd) = epd_key(&cur) else { break };
            let Some(entry) = self.tt.get(&tt_key(&epd, self.cfg)) else {
                break;
            };
            let Some(best) = entry.best.clone() else { break };
            let Ok(next) = fen_after(&cur, &best) else { break };
            pv.push(best);
            cur = next;
        }
        pv
    }
}

/// Run the restricted search from `fen`. `tt` may be shared across calls —
/// that's the session cache. Result is White-POV like every eval in the app.
pub async fn search_root(
    cfg: &HumanSearchConfig,
    policy: &dyn PolicySource,
    leaf: &mut dyn LeafEvaluator,
    tt: &mut TranspositionTable,
    fen: &str,
) -> Result<HumanSearchResult, String> {
    let pos: Chess = Fen::from_ascii(fen.as_bytes())
        .map_err(|e| format!("bad FEN: {e}"))?
        .into_position(CastlingMode::Standard)
        .map_err(|e| format!("illegal position: {e}"))?;
    let white_to_move = pos.turn() == Color::White;

    let mut s = Searcher {
        cfg,
        policy,
        leaf,
        tt,
        nodes: 0,
        leaf_evals: 0,
        tt_hits: 0,
    };
    let (cp_mover, pv) = s.search(fen.to_string(), cfg.depth, 0).await?;
    let (nodes, leaf_evals, tt_hits) = (s.nodes, s.leaf_evals, s.tt_hits);

    let cp_white = if white_to_move { cp_mover } else { -cp_mover };
    Ok(HumanSearchResult {
        band: cfg.band,
        cp_white,
        pawns: cp_white as f64 / 100.0,
        depth: cfg.depth,
        nodes,
        leaf_evals,
        tt_hits,
        pv,
    })
}

// ---------------------------------------------------------------------------
// Production leaf evaluator — one warm single-threaded Stockfish
// ---------------------------------------------------------------------------

pub struct SfLeaf {
    _child: Child,
    stdin: ChildStdin,
    reader: BufReader<ChildStdout>,
    depth: u32,
}

impl SfLeaf {
    pub async fn spawn(sf: &Path, depth: u32) -> Result<Self, String> {
        let mut child = Command::new(sf)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("failed to start stockfish: {e}"))?;
        let mut stdin = child.stdin.take().ok_or("stockfish: no stdin")?;
        let mut reader = BufReader::new(child.stdout.take().ok_or("stockfish: no stdout")?);

        sf_send(&mut stdin, "uci").await?;
        read_until(&mut reader, |l| l == "uciok").await?;
        // Single thread: fixed-depth results stay reproducible per SF build.
        sf_send(&mut stdin, "setoption name Threads value 1").await?;
        sf_send(&mut stdin, "isready").await?;
        read_until(&mut reader, |l| l == "readyok").await?;

        Ok(Self {
            _child: child,
            stdin,
            reader,
            depth: depth.max(1),
        })
    }
}

impl LeafEvaluator for SfLeaf {
    fn eval_cp<'a>(&'a mut self, fen: &'a str) -> BoxFut<'a, Result<i64, String>> {
        Box::pin(async move {
            // Fresh game per leaf: hash carry-over between leaves would make
            // fixed-depth scores depend on visit order, breaking determinism.
            sf_send(&mut self.stdin, "ucinewgame").await?;
            sf_send(&mut self.stdin, "isready").await?;
            read_until(&mut self.reader, |l| l == "readyok").await?;

            sf_send(&mut self.stdin, &format!("position fen {fen}")).await?;
            sf_send(&mut self.stdin, &format!("go depth {}", self.depth)).await?;
            let mut last: Option<i64> = None;
            read_until(&mut self.reader, |line| {
                if line.starts_with("info ") {
                    if let Some(cp) = parse_score_cp(line) {
                        last = Some(cp);
                    }
                }
                line.starts_with("bestmove")
            })
            .await?;
            Ok(last.unwrap_or(0))
        })
    }
}

// ---------------------------------------------------------------------------
// Production policy source — the warm Maia pool
// ---------------------------------------------------------------------------

struct MaiaPolicySource<'a> {
    app: &'a tauri::AppHandle,
    state: &'a MaiaState,
    band: u32,
}

impl PolicySource for MaiaPolicySource<'_> {
    fn policy<'a>(&'a self, fen: &'a str) -> BoxFut<'a, Result<Vec<MaiaMove>, String>> {
        Box::pin(async move {
            maia::query_policy(self.app, self.state, fen, self.band)
                .await
                .map(|p| p.moves)
        })
    }
}

// ---------------------------------------------------------------------------
// Tauri command + session cache state
// ---------------------------------------------------------------------------

/// Session-lived transposition cache (spec: "transposition cache keyed
/// (fen, R)"). Also serializes concurrent tree searches — one slider, one
/// search at a time is the intended shape.
#[derive(Default)]
pub struct HumanTreeState {
    tt: AsyncMutex<TranspositionTable>,
}

/// Tier-1 Eval_R for `fen` at rating `band` (spec 213 Phase 3). All knobs
/// optional; defaults sized for the 1–4 s/stop budget. Deterministic for a
/// given (fen, band, knobs, Stockfish build).
#[tauri::command]
pub async fn human_eval_tree(
    app: tauri::AppHandle,
    maia_state: State<'_, MaiaState>,
    tree_state: State<'_, HumanTreeState>,
    fen: String,
    band: u32,
    depth: Option<u32>,
    top_p: Option<f64>,
    max_candidates: Option<usize>,
    max_nodes: Option<usize>,
    leaf_depth: Option<u32>,
) -> Result<HumanSearchResult, String> {
    if !maia::is_valid_band(band) {
        return Err(format!(
            "no Maia-1 net for band {band} (available: 1100–1900)"
        ));
    }
    let cfg = HumanSearchConfig {
        band,
        top_p: top_p.unwrap_or(DEFAULT_TOP_P).clamp(0.05, 1.0),
        max_candidates: max_candidates.unwrap_or(DEFAULT_MAX_CANDIDATES).clamp(1, 8),
        depth: depth.unwrap_or(DEFAULT_DEPTH).clamp(1, 6),
        max_nodes: max_nodes.unwrap_or(DEFAULT_MAX_NODES).clamp(1, 5_000),
        leaf_depth: leaf_depth.unwrap_or(DEFAULT_LEAF_DEPTH).clamp(1, 20),
    };

    let sf = resolve_stockfish()
        .ok_or("stockfish not found — install it with: brew install stockfish")?;
    let mut leaf = SfLeaf::spawn(&sf, cfg.leaf_depth).await?;
    let policy = MaiaPolicySource {
        app: &app,
        state: maia_state.inner(),
        band,
    };

    let mut tt = tree_state.tt.lock().await;
    if tt.len() > TT_CAP {
        tt.clear();
    }
    search_root(&cfg, &policy, &mut leaf, &mut tt, &fen).await
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    const STARTPOS: &str = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

    fn mv(uci: &str, prob: f64) -> MaiaMove {
        MaiaMove {
            uci: uci.to_string(),
            prob,
        }
    }

    /// Hand-built policy table keyed by EPD — the spec's synthetic policies.
    struct TablePolicy(HashMap<String, Vec<MaiaMove>>);

    impl TablePolicy {
        fn new() -> Self {
            Self(HashMap::new())
        }
        fn set(&mut self, fen: &str, moves: Vec<MaiaMove>) {
            self.0.insert(epd_key(fen).unwrap(), moves);
        }
    }

    impl PolicySource for TablePolicy {
        fn policy<'a>(&'a self, fen: &'a str) -> BoxFut<'a, Result<Vec<MaiaMove>, String>> {
            Box::pin(async move {
                let epd = epd_key(fen)?;
                self.0
                    .get(&epd)
                    .cloned()
                    .ok_or(format!("test policy table has no entry for {epd}"))
            })
        }
    }

    /// Leaf table keyed by EPD, values side-to-move POV cp. Counts calls so
    /// tests can assert cache behaviour. Missing entries fail loudly.
    struct TableLeaf {
        vals: HashMap<String, i64>,
        calls: usize,
    }

    impl TableLeaf {
        fn new() -> Self {
            Self {
                vals: HashMap::new(),
                calls: 0,
            }
        }
        fn set(&mut self, fen: &str, cp: i64) {
            self.vals.insert(epd_key(fen).unwrap(), cp);
        }
    }

    impl LeafEvaluator for TableLeaf {
        fn eval_cp<'a>(&'a mut self, fen: &'a str) -> BoxFut<'a, Result<i64, String>> {
            Box::pin(async move {
                self.calls += 1;
                let epd = epd_key(fen)?;
                self.vals
                    .get(&epd)
                    .copied()
                    .ok_or(format!("test leaf table has no entry for {epd}"))
            })
        }
    }

    fn after(fen: &str, ucis: &[&str]) -> String {
        let mut cur = fen.to_string();
        for u in ucis {
            cur = fen_after(&cur, u).unwrap();
        }
        cur
    }

    fn cfg(band: u32, top_p: f64, depth: u32) -> HumanSearchConfig {
        HumanSearchConfig {
            band,
            top_p,
            max_candidates: 4,
            depth,
            max_nodes: 300,
            leaf_depth: 1, // unused by TableLeaf
        }
    }

    // -- Restriction rule ---------------------------------------------------

    #[test]
    fn top_p_takes_smallest_prefix_reaching_the_mass() {
        let moves = vec![
            mv("a2a3", 0.05),
            mv("e2e4", 0.50),
            mv("d2d4", 0.30),
            mv("g1f3", 0.15),
        ];
        // 0.5 + 0.3 = 0.8 ≥ 0.8 → exactly two candidates.
        let r = restrict_candidates(&moves, 0.80, 4);
        assert_eq!(
            r.iter().map(|m| m.uci.as_str()).collect::<Vec<_>>(),
            vec!["e2e4", "d2d4"]
        );
        // 0.8 < 0.81 → the third enters.
        let r = restrict_candidates(&moves, 0.81, 4);
        assert_eq!(r.len(), 3);
        assert_eq!(r[2].uci, "g1f3");
    }

    #[test]
    fn restriction_clamps_to_min_one_and_max_candidates() {
        let moves = vec![mv("e2e4", 0.4), mv("d2d4", 0.35), mv("g1f3", 0.25)];
        // top_p 0 still yields the single most likely move.
        let r = restrict_candidates(&moves, 0.0, 4);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].uci, "e2e4");
        // The cap wins over the mass target.
        let r = restrict_candidates(&moves, 1.0, 2);
        assert_eq!(r.len(), 2);
        // Empty input stays empty (handled by the caller).
        assert!(restrict_candidates(&[], 0.8, 4).is_empty());
    }

    #[test]
    fn restriction_tie_break_is_stable_by_uci() {
        let moves = vec![mv("d2d4", 0.5), mv("e2e4", 0.5)];
        let r = restrict_candidates(&moves, 0.4, 4);
        assert_eq!(r[0].uci, "d2d4", "equal probs order by UCI ascending");
    }

    // -- The spec's named test: resource in/out of the nucleus flips Eval_R --

    #[tokio::test]
    async fn resource_outside_the_candidate_set_flips_the_eval() {
        // Root (White): e2e4 is the only visible move. Black's reply policy
        // puts 0.70 on the "obvious" e7e5 and 0.29 on b8a6 — the stand-in for
        // the refutation resource. Leaves (side-to-move = White POV):
        //   after e4 e5   → +50   (fine for White)
        //   after e4 Na6  → −300  (the resource refutes)
        //
        // Hand minimax: with the resource INVISIBLE (top_p=0.70 → only e5):
        //   value(after e4, Black POV) = max(−(+50)) = −50 → root = +50.
        // With it VISIBLE (top_p=0.99 → both replies):
        //   value(after e4) = max(−50, +300) = +300 → root = −300.
        let root = STARTPOS;
        let after_e4 = after(root, &["e2e4"]);

        let mut policy = TablePolicy::new();
        policy.set(root, vec![mv("e2e4", 1.0)]);
        policy.set(&after_e4, vec![mv("e7e5", 0.70), mv("b8a6", 0.29)]);

        let mut leaf = TableLeaf::new();
        leaf.set(&after(root, &["e2e4", "e7e5"]), 50);
        leaf.set(&after(root, &["e2e4", "b8a6"]), -300);

        // Resource invisible at rating R.
        let mut tt = TranspositionTable::new();
        let blind = search_root(&cfg(1500, 0.70, 2), &policy, &mut leaf, &mut tt, root)
            .await
            .unwrap();
        assert_eq!(blind.cp_white, 50);
        assert_eq!(blind.pv, vec!["e2e4", "e7e5"]);

        // Resource visible (wider nucleus): the eval flips.
        let mut tt = TranspositionTable::new();
        let sighted = search_root(&cfg(1500, 0.99, 2), &policy, &mut leaf, &mut tt, root)
            .await
            .unwrap();
        assert_eq!(sighted.cp_white, -300);
        assert_eq!(sighted.pv, vec!["e2e4", "b8a6"]);
    }

    // -- Exact minimax arithmetic over a 2×2 synthetic tree ------------------

    /// Depth-2 fixture: root {e4, d4}; replies {e5, c5} / {d5, Nf6}; leaves
    /// (White POV): e4e5=+120, e4c5=−80, d4d5=+30, d4Nf6=+10.
    /// Hand minimax: e4-node = max(−120, +80) = +80; d4-node = max(−30, −10)
    /// = −10; root = max(−80, +10) = +10 via d4 Nf6.
    fn minimax_fixture() -> (TablePolicy, TableLeaf) {
        let root = STARTPOS;
        let mut policy = TablePolicy::new();
        policy.set(root, vec![mv("e2e4", 0.5), mv("d2d4", 0.5)]);
        policy.set(
            &after(root, &["e2e4"]),
            vec![mv("e7e5", 0.6), mv("c7c5", 0.4)],
        );
        policy.set(
            &after(root, &["d2d4"]),
            vec![mv("d7d5", 0.6), mv("g8f6", 0.4)],
        );

        let mut leaf = TableLeaf::new();
        leaf.set(&after(root, &["e2e4", "e7e5"]), 120);
        leaf.set(&after(root, &["e2e4", "c7c5"]), -80);
        leaf.set(&after(root, &["d2d4", "d7d5"]), 30);
        leaf.set(&after(root, &["d2d4", "g8f6"]), 10);
        (policy, leaf)
    }

    #[tokio::test]
    async fn minimax_backup_is_exact_on_a_synthetic_tree() {
        let (policy, mut leaf) = minimax_fixture();
        let mut tt = TranspositionTable::new();
        let r = search_root(&cfg(1500, 1.0, 2), &policy, &mut leaf, &mut tt, STARTPOS)
            .await
            .unwrap();
        assert_eq!(r.cp_white, 10);
        assert_eq!(r.pv, vec!["d2d4", "g8f6"]);
        assert_eq!(r.leaf_evals, 4, "four leaves, each scored once");
        assert_eq!(r.nodes, 7, "root + 2 interior + 4 leaves");
        assert_eq!(r.tt_hits, 0);
        assert!((r.pawns - 0.10).abs() < 1e-9);
    }

    // -- Transposition cache --------------------------------------------------

    #[tokio::test]
    async fn repeat_search_is_served_entirely_from_the_cache() {
        let (policy, mut leaf) = minimax_fixture();
        let mut tt = TranspositionTable::new();
        let c = cfg(1500, 1.0, 2);
        let first = search_root(&c, &policy, &mut leaf, &mut tt, STARTPOS)
            .await
            .unwrap();
        let second = search_root(&c, &policy, &mut leaf, &mut tt, STARTPOS)
            .await
            .unwrap();
        assert_eq!(second.cp_white, first.cp_white);
        assert_eq!(second.pv, first.pv, "PV reconstructed from cached best moves");
        assert_eq!(second.leaf_evals, 0, "no leaf re-evaluated");
        assert_eq!(second.tt_hits, 1, "root answered by the cache");
        assert_eq!(leaf.calls, 4, "engine consulted only in the first search");
    }

    #[tokio::test]
    async fn subtree_searched_earlier_is_reused_via_transposition() {
        // Search the after-e4 node first (depth 1), then the root at depth 2:
        // the e4 subtree must come from the cache (its entry depth 1 satisfies
        // the remaining depth 1), leaving only the d4 branch to evaluate.
        let (policy, mut leaf) = minimax_fixture();
        let mut tt = TranspositionTable::new();
        let c = cfg(1500, 1.0, 2);
        let sub_cfg = HumanSearchConfig { depth: 1, ..c.clone() };
        let after_e4 = after(STARTPOS, &["e2e4"]);
        let sub = search_root(&sub_cfg, &policy, &mut leaf, &mut tt, &after_e4)
            .await
            .unwrap();
        // Black to move: mover POV +80 → White POV −80.
        assert_eq!(sub.cp_white, -80);
        assert_eq!(sub.leaf_evals, 2);

        let root = search_root(&c, &policy, &mut leaf, &mut tt, STARTPOS)
            .await
            .unwrap();
        assert_eq!(root.cp_white, 10, "value identical to the cold search");
        assert_eq!(root.tt_hits, 1, "e4 subtree served by the cache");
        assert_eq!(root.leaf_evals, 2, "only the d4 branch hit the engine");
    }

    // -- Budgets ----------------------------------------------------------------

    #[tokio::test]
    async fn node_budget_degrades_to_shallower_leaves_not_failure() {
        // max_nodes=1: the root expands, but both children are scored as
        // leaves (depth-1 semantics). Leaf values for the depth-1 horizon are
        // the mover-POV values of the interior nodes: +80 (after e4, Black
        // POV) and −10 (after d4) → root = max(−80, +10) = +10.
        let (policy, mut leaf) = minimax_fixture();
        leaf.set(&after(STARTPOS, &["e2e4"]), 80);
        leaf.set(&after(STARTPOS, &["d2d4"]), -10);

        let mut tt = TranspositionTable::new();
        let c = HumanSearchConfig {
            max_nodes: 1,
            ..cfg(1500, 1.0, 2)
        };
        let r = search_root(&c, &policy, &mut leaf, &mut tt, STARTPOS)
            .await
            .unwrap();
        assert_eq!(r.cp_white, 10);
        assert_eq!(r.leaf_evals, 2, "children scored as leaves under budget");
        assert_eq!(r.nodes, 3);
    }

    // -- Terminal positions -------------------------------------------------------

    #[tokio::test]
    async fn checkmate_stalemate_and_mate_in_tree_score_correctly() {
        let policy = TablePolicy::new();
        let mut leaf = TableLeaf::new();
        let mut tt = TranspositionTable::new();

        // Fool's mate final position: White to move, mated → −MATE_CP.
        let mated = "rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3";
        let r = search_root(&cfg(1500, 0.8, 2), &policy, &mut leaf, &mut tt, mated)
            .await
            .unwrap();
        assert_eq!(r.cp_white, -MATE_CP);

        // Stalemate: Black to move, no moves, not in check → 0.
        let stale = "7k/5Q2/6K1/8/8/8/8/8 b - - 0 1";
        let r = search_root(&cfg(1500, 0.8, 2), &policy, &mut leaf, &mut tt, stale)
            .await
            .unwrap();
        assert_eq!(r.cp_white, 0);

        // Mate delivered inside the visible tree: Ra8# at depth 1 backs up as
        // MATE_CP − 1 (ply-adjusted, prefers faster mates).
        let pre_mate = "6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1";
        let mut policy = TablePolicy::new();
        policy.set(pre_mate, vec![mv("a1a8", 1.0)]);
        let r = search_root(&cfg(1500, 0.8, 1), &policy, &mut leaf, &mut tt, pre_mate)
            .await
            .unwrap();
        assert_eq!(r.cp_white, MATE_CP - 1);
        assert_eq!(r.pv, vec!["a1a8"]);
    }

    // -- Determinism -----------------------------------------------------------

    #[tokio::test]
    async fn search_is_deterministic_by_construction() {
        let (policy, mut leaf) = minimax_fixture();
        let c = cfg(1500, 1.0, 2);
        let mut tt1 = TranspositionTable::new();
        let a = search_root(&c, &policy, &mut leaf, &mut tt1, STARTPOS)
            .await
            .unwrap();
        let mut tt2 = TranspositionTable::new();
        let b = search_root(&c, &policy, &mut leaf, &mut tt2, STARTPOS)
            .await
            .unwrap();
        assert_eq!(a, b, "no sampling anywhere: identical runs, identical results");
    }

    // -- Real engines (gated; skips cleanly when lc0/stockfish are absent) ------

    #[tokio::test]
    async fn real_tree_startpos_band_1500() {
        let Some(lc0) = maia::resolve_lc0() else {
            eprintln!("SKIP real_tree: lc0 not installed");
            return;
        };
        let Some(sf) = resolve_stockfish() else {
            eprintln!("SKIP real_tree: stockfish not installed");
            return;
        };
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("maia-test-cache");
        let weights = match maia::ensure_weights(1500, &dir).await {
            Ok(p) => p,
            Err(e) => {
                eprintln!("SKIP real_tree: could not obtain weights ({e})");
                return;
            }
        };

        struct ProcPolicy(maia::MaiaProcess);
        impl PolicySource for ProcPolicy {
            fn policy<'a>(&'a self, fen: &'a str) -> BoxFut<'a, Result<Vec<MaiaMove>, String>> {
                Box::pin(async move { self.0.query(fen).await.map(|p| p.moves) })
            }
        }

        let policy = ProcPolicy(
            maia::MaiaProcess::spawn(&lc0, &weights, 1500)
                .await
                .expect("spawn lc0"),
        );
        let mut leaf = SfLeaf::spawn(&sf, 8).await.expect("spawn stockfish");

        let c = HumanSearchConfig {
            band: 1500,
            top_p: 0.80,
            max_candidates: 3,
            depth: 2,
            max_nodes: 100,
            leaf_depth: 8,
        };
        let t0 = std::time::Instant::now();
        let mut tt = TranspositionTable::new();
        let a = search_root(&c, &policy, &mut leaf, &mut tt, STARTPOS)
            .await
            .expect("real tree search");
        let elapsed = t0.elapsed();
        eprintln!(
            "real_tree: {:?}, cp_white={} nodes={} leaves={} pv={:?}",
            elapsed, a.cp_white, a.nodes, a.leaf_evals, a.pv
        );
        assert!(
            a.cp_white.abs() < 300,
            "startpos Eval_R should be near equality, got {}",
            a.cp_white
        );
        assert!(a.leaf_evals > 0 && a.nodes > 0);
        assert_eq!(a.pv.len(), 2, "depth-2 PV");

        // Determinism against a fresh cache (single-threaded fixed-depth SF).
        let mut tt2 = TranspositionTable::new();
        let b = search_root(&c, &policy, &mut leaf, &mut tt2, STARTPOS)
            .await
            .expect("second real tree search");
        assert_eq!(a.cp_white, b.cp_white, "fixed-depth runs must agree");
        assert_eq!(a.pv, b.pv);
    }
}
