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
//   * PHASE CONDITIONING — skill is a phase vector, not a scalar (spec 213
//     §1.5): the band that defines "visible" is chosen PER NODE from
//     R⃗ = (R_opening, R_middlegame, R_endgame) by the node's game phase,
//     using the calibration.rs heuristic (non-pawn weight ≤ 8 = endgame;
//     else ply < 16 = opening), as ported to persona.rs. A middlegame line
//     that trades down mid-line switches to the endgame band at the boundary
//     — "good for you *if* you can play the resulting endgame". The scalar
//     slider is the linked special case (all three bands equal).
//   * TRANSPOSITION CACHE — interior entries keyed (EPD, band vector, knobs);
//     an entry stores the depth it was searched to and is reused when that
//     depth ≥ the remaining depth. Leaf evals are keyed (EPD, leaf_depth)
//     only — a leaf is pure Stockfish, band-independent — so slider revisits
//     AND the background sweep's stops share leaves across bands. The cache
//     persists in Tauri state for the app session.
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
use std::sync::atomic::{AtomicU64, Ordering};

use serde::Serialize;
use shakmaty::fen::{Epd, Fen};
use shakmaty::{CastlingMode, Chess, Color, EnPassantMode, Position};
use tauri::ipc::Channel;
use tauri::State;
use tokio::io::BufReader;
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::{Mutex as AsyncMutex, Semaphore, SemaphorePermit};

use crate::maia::{self, MaiaMove, MaiaState};
use crate::persona::{
    fen_after, parse_score_cp, phase_for, phase_weight_of, read_until, resolve_stockfish, sf_send,
    Phase, MATE_CP, OPENING_MAX_PLY,
};

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

/// R⃗ = (R_opening, R_middlegame, R_endgame) — spec 213 §1.5's phase vector.
/// The scalar rating slider is the linked special case (all three equal).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BandVector {
    pub opening: u32,
    pub middlegame: u32,
    pub endgame: u32,
}

impl BandVector {
    /// Linked scalar: one slider sets all three phase ratings.
    pub fn linked(band: u32) -> Self {
        Self {
            opening: band,
            middlegame: band,
            endgame: band,
        }
    }

    pub fn for_phase(&self, phase: Phase) -> u32 {
        match phase {
            Phase::Opening => self.opening,
            Phase::Middlegame => self.middlegame,
            Phase::Endgame => self.endgame,
        }
    }

    /// Ply enters a node's band choice only through the opening-vs-middlegame
    /// test (endgame is material-only, already captured by the EPD), so a
    /// subtree's value can depend on the game ply iff those two bands differ.
    fn ply_sensitive(&self) -> bool {
        self.opening != self.middlegame
    }
}

#[derive(Debug, Clone)]
pub struct HumanSearchConfig {
    /// Maia rating bands per game phase (the policy that defines "visible" —
    /// chosen per node by the node's phase).
    pub bands: BandVector,
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
            bands: BandVector::linked(band),
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

/// Source of the rating-R move distribution for a position. `band` is chosen
/// per node by the node's phase. Production wraps maia::query_policy (whose
/// LRU pool holds up to 3 warm bands — exactly R⃗'s size); tests use
/// hand-built tables.
pub trait PolicySource: Send + Sync {
    fn policy<'a>(&'a self, fen: &'a str, band: u32) -> BoxFut<'a, Result<Vec<MaiaMove>, String>>;
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

fn parse_fen(fen: &str) -> Result<Chess, String> {
    Fen::from_ascii(fen.as_bytes())
        .map_err(|e| format!("bad FEN: {e}"))?
        .into_position(CastlingMode::Standard)
        .map_err(|e| format!("illegal position: {e}"))
}

/// EPD (FEN minus the move counters) — two positions equal-for-eval share a
/// key even when reached at different move numbers.
pub fn epd_key(fen: &str) -> Result<String, String> {
    let pos = parse_fen(fen)?;
    Ok(Epd::from_position(&pos, EnPassantMode::Legal).to_string())
}

/// Game ply (0 = the starting position) from the FEN's move counters — the
/// ply input to the phase heuristic. Distinct from the SEARCH ply: child FENs
/// carry their own advanced counters, so each node's phase is its own.
fn game_ply_of(pos: &Chess) -> u32 {
    2 * (pos.fullmoves().get() - 1) + u32::from(pos.turn() == Color::Black)
}

/// The rating band that defines "visible" at this node: R⃗ indexed by the
/// node's phase (calibration.rs heuristic via persona::phase_for).
fn node_band(bands: &BandVector, pos: &Chess) -> u32 {
    bands.for_phase(phase_for(phase_weight_of(pos), game_ply_of(pos)))
}

/// Cache key: position + every knob that changes the value (band vector, leaf
/// depth, nucleus shape). Search depth is NOT in the key — reuse is
/// depth-aware via `TtEntry::depth` instead, so a deep entry serves shallower
/// lookups. When opening and middlegame bands differ the subtree value also
/// depends on the game ply (the opening boundary can fall inside the
/// subtree); the ply is clamped to the boundary so every post-opening node
/// still shares entries across move numbers.
fn tt_key(epd: &str, game_ply: u32, cfg: &HumanSearchConfig) -> String {
    let b = &cfg.bands;
    let ply_part = if b.ply_sensitive() {
        format!("|p{}", game_ply.min(OPENING_MAX_PLY))
    } else {
        String::new()
    };
    format!(
        "{epd}|{}-{}-{}|{}|{:.3}|{}{}",
        b.opening, b.middlegame, b.endgame, cfg.leaf_depth, cfg.top_p, cfg.max_candidates, ply_part
    )
}

/// Leaf-eval cache key. A leaf is pure fixed-depth Stockfish — no band, no
/// nucleus knobs — so entries are shared across every band that reaches the
/// position: the background sweep's stops mostly re-score each other's
/// leaves from the cache instead of the engine.
fn leaf_tt_key(epd: &str, leaf_depth: u32) -> String {
    format!("{epd}|leaf|{leaf_depth}")
}

// ---------------------------------------------------------------------------
// The search
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct HumanSearchResult {
    /// The middlegame (reference-phase) band; equals the slider band for the
    /// linked scalar case, kept for back-compat with the tier-1 readout.
    pub band: u32,
    /// The full R⃗ actually used: [opening, middlegame, endgame].
    pub bands: [u32; 3],
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

/// Error string a cancelled search/sweep surfaces (same literal as
/// match_runner's batch cancellation — callers match on it, never display it).
pub const CANCELLED: &str = "cancelled";

struct Searcher<'s> {
    cfg: &'s HumanSearchConfig,
    policy: &'s dyn PolicySource,
    leaf: &'s mut dyn LeafEvaluator,
    tt: &'s mut TranspositionTable,
    /// Polled at every node (~tens of ms apart), so a cancelled sweep releases
    /// the shared TT lock promptly instead of finishing a multi-second stop.
    cancel: &'s (dyn Fn() -> bool + Send + Sync),
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
            if (self.cancel)() {
                return Err(CANCELLED.to_string());
            }
            let pos = parse_fen(&fen)?;

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

            let epd = Epd::from_position(&pos, EnPassantMode::Legal).to_string();
            let key = tt_key(&epd, game_ply_of(&pos), self.cfg);
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
                return self.leaf_value(&fen, &epd).await;
            }

            // Interior: restrict to the rating-R nucleus, R chosen by THIS
            // node's phase — a line that trades into an endgame switches to
            // the endgame band at the boundary. lc0 policies only list legal
            // moves; the legality filter guards synthetic tables and any
            // upstream anomaly.
            let band = node_band(&self.cfg.bands, &pos);
            let policy = self.policy.policy(&fen, band).await?;
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
                return self.leaf_value(&fen, &epd).await;
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

    /// Score a node as a leaf, through the band-free leaf cache: any earlier
    /// search that reached this position as a leaf — same slider stop or not
    /// — already paid the Stockfish call.
    async fn leaf_value(&mut self, fen: &str, epd: &str) -> Result<(i64, Vec<String>), String> {
        let lkey = leaf_tt_key(epd, self.cfg.leaf_depth);
        if let Some(e) = self.tt.get(&lkey) {
            self.tt_hits += 1;
            return Ok((e.cp, Vec::new()));
        }
        let cp = self.leaf.eval_cp(fen).await?;
        self.leaf_evals += 1;
        self.tt.insert(lkey, TtEntry { depth: 0, cp, best: None });
        Ok((cp, Vec::new()))
    }

    /// Rebuild a PV from cached best moves after a TT hit; stops at the first
    /// gap. Bounded by `depth` so a cache cycle can't loop.
    fn reconstruct_pv(&self, fen: &str, depth: u32) -> Vec<String> {
        let mut pv = Vec::new();
        let mut cur = fen.to_string();
        for _ in 0..depth {
            let Ok(pos) = parse_fen(&cur) else { break };
            let epd = Epd::from_position(&pos, EnPassantMode::Legal).to_string();
            let Some(entry) = self.tt.get(&tt_key(&epd, game_ply_of(&pos), self.cfg)) else {
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
    search_root_cancellable(cfg, policy, leaf, tt, fen, &|| false).await
}

/// `search_root` with a cancellation probe, polled per node. On cancellation
/// the search aborts with `Err(CANCELLED)`; every TT entry already written is
/// a completed subtree value, so a restarted search reuses the partial work.
pub async fn search_root_cancellable(
    cfg: &HumanSearchConfig,
    policy: &dyn PolicySource,
    leaf: &mut dyn LeafEvaluator,
    tt: &mut TranspositionTable,
    fen: &str,
    cancel: &(dyn Fn() -> bool + Send + Sync),
) -> Result<HumanSearchResult, String> {
    let pos = parse_fen(fen)?;
    let white_to_move = pos.turn() == Color::White;

    let mut s = Searcher {
        cfg,
        policy,
        leaf,
        tt,
        cancel,
        nodes: 0,
        leaf_evals: 0,
        tt_hits: 0,
    };
    let (cp_mover, pv) = s.search(fen.to_string(), cfg.depth, 0).await?;
    let (nodes, leaf_evals, tt_hits) = (s.nodes, s.leaf_evals, s.tt_hits);

    let cp_white = if white_to_move { cp_mover } else { -cp_mover };
    Ok(HumanSearchResult {
        band: cfg.bands.middlegame,
        bands: [cfg.bands.opening, cfg.bands.middlegame, cfg.bands.endgame],
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
// Background sweep — the perception curve (spec 213's flagship visual)
// ---------------------------------------------------------------------------

/// A finished (or cancelled-partway) sweep across slider stops. `points` holds
/// one HumanSearchResult per completed band, in sweep order.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct HumanSweepResult {
    pub points: Vec<HumanSearchResult>,
    pub cancelled: bool,
}

/// Eval_R at every band in `bands` for one position — the perception curve's
/// data. One linked-R⃗ search per stop, all stops sharing `tt`, so the curve
/// costs far less than bands × cold searches (leaves reached through moves
/// both bands consider are scored once). `on_point` fires as each stop lands
/// (progressive chart fill); `cancel` is polled per node, and cancellation
/// returns the points already computed rather than an error.
pub async fn sweep_bands(
    base: &HumanSearchConfig,
    bands: &[u32],
    policy: &dyn PolicySource,
    leaf: &mut dyn LeafEvaluator,
    tt: &mut TranspositionTable,
    fen: &str,
    cancel: &(dyn Fn() -> bool + Send + Sync),
    on_point: &mut (dyn FnMut(&HumanSearchResult) + Send),
) -> Result<HumanSweepResult, String> {
    let mut points: Vec<HumanSearchResult> = Vec::with_capacity(bands.len());
    for &band in bands {
        let cfg = HumanSearchConfig {
            bands: BandVector::linked(band),
            ..base.clone()
        };
        match search_root_cancellable(&cfg, policy, leaf, tt, fen, cancel).await {
            Ok(r) => {
                on_point(&r);
                points.push(r);
            }
            Err(e) if e == CANCELLED => {
                return Ok(HumanSweepResult {
                    points,
                    cancelled: true,
                })
            }
            Err(e) => return Err(e),
        }
    }
    Ok(HumanSweepResult {
        points,
        cancelled: false,
    })
}

// ---------------------------------------------------------------------------
// "Visible from ~R" — spec 213 Phase 4 (tournament error report)
// ---------------------------------------------------------------------------

/// True swings below this (cp) are noise, not a mistake a band could "see" —
/// no visible-from verdict is computed for them.
pub const VISIBLE_MIN_SWING_CP: i64 = 60;

/// Whether Eval_R at one band registers the mistake: the band's eval has
/// moved from the pre-mistake belief toward the true post-mistake eval in the
/// right direction AND covered at least half the swing. Half is deliberately
/// coarse — Eval_R's restricted tree is an estimate, and the badge is labeled
/// experimental — but it separates "still believes the old eval" from "sees
/// the refutation" without tuning a threshold per position.
pub fn band_sees(point_cp: i64, before_cp: i64, after_cp: i64) -> bool {
    let swing = after_cp - before_cp;
    let moved = point_cp - before_cp;
    moved.signum() == swing.signum() && 2 * moved.abs() >= swing.abs()
}

/// Lowest band whose Eval_R registers the mistake, from (band, cp_white)
/// sweep points over the AFTER-mistake position. `before_cp` is the neutral
/// eval before the mistake, `after_cp` the true eval after it (both
/// White-POV cp). None = no band sees it (refutation deeper than every
/// swept nucleus) or the swing is too small to judge.
pub fn visible_from(points: &[(u32, i64)], before_cp: i64, after_cp: i64) -> Option<u32> {
    if (after_cp - before_cp).abs() < VISIBLE_MIN_SWING_CP {
        return None;
    }
    points
        .iter()
        .filter(|&&(_, cp)| band_sees(cp, before_cp, after_cp))
        .map(|&(band, _)| band)
        .min()
}

/// One mistake's visible-from verdict plus the Eval_R points that produced it.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct VisibleFromResult {
    /// Lowest band that sees the swing; None = not visible at any swept band
    /// (or cancelled before one was found — check `cancelled`).
    pub visible_from: Option<u32>,
    /// Points actually computed, ascending band order. The scan stops at the
    /// first band that sees the swing, so higher bands may be absent.
    pub points: Vec<HumanSearchResult>,
    pub cancelled: bool,
}

/// Eval_R scan over `bands` (sorted ascending internally) on the
/// after-mistake position, stopping at the first band that sees the swing —
/// "visible from" is a lower bound, so higher bands need not be searched.
/// A too-small swing returns immediately without touching the engine.
pub async fn visible_from_scan(
    base: &HumanSearchConfig,
    bands: &[u32],
    policy: &dyn PolicySource,
    leaf: &mut dyn LeafEvaluator,
    tt: &mut TranspositionTable,
    fen: &str,
    before_cp: i64,
    after_cp: i64,
    cancel: &(dyn Fn() -> bool + Send + Sync),
) -> Result<VisibleFromResult, String> {
    if (after_cp - before_cp).abs() < VISIBLE_MIN_SWING_CP {
        return Ok(VisibleFromResult {
            visible_from: None,
            points: Vec::new(),
            cancelled: false,
        });
    }
    let mut sorted: Vec<u32> = bands.to_vec();
    sorted.sort_unstable();
    sorted.dedup();

    let mut points: Vec<HumanSearchResult> = Vec::new();
    for &band in &sorted {
        let cfg = HumanSearchConfig {
            bands: BandVector::linked(band),
            ..base.clone()
        };
        match search_root_cancellable(&cfg, policy, leaf, tt, fen, cancel).await {
            Ok(r) => {
                let sees = band_sees(r.cp_white, before_cp, after_cp);
                points.push(r);
                if sees {
                    break;
                }
            }
            Err(e) if e == CANCELLED => {
                let pairs: Vec<(u32, i64)> = points.iter().map(|p| (p.band, p.cp_white)).collect();
                return Ok(VisibleFromResult {
                    visible_from: visible_from(&pairs, before_cp, after_cp),
                    points,
                    cancelled: true,
                });
            }
            Err(e) => return Err(e),
        }
    }
    let pairs: Vec<(u32, i64)> = points.iter().map(|p| (p.band, p.cp_white)).collect();
    Ok(VisibleFromResult {
        visible_from: visible_from(&pairs, before_cp, after_cp),
        points,
        cancelled: false,
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
        // Resource box (spec 213): the leaf engine must never starve the
        // user's analysis engine or tournament players. Threads=1 pins it to
        // one core (and keeps fixed-depth results reproducible per SF build);
        // Hash=16 MB caps memory (fixed value, so the reproducibility claim
        // still holds). Time is bounded too: eval_cp only ever issues
        // `go depth N` (N = leaf_depth, clamped 1..=20 by the Tauri commands,
        // default 10 ≈ tens of ms/leaf) — never `go infinite` or movetime.
        sf_send(&mut stdin, "setoption name Threads value 1").await?;
        sf_send(&mut stdin, "setoption name Hash value 16").await?;
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
}

impl PolicySource for MaiaPolicySource<'_> {
    fn policy<'a>(&'a self, fen: &'a str, band: u32) -> BoxFut<'a, Result<Vec<MaiaMove>, String>> {
        Box::pin(async move {
            maia::query_policy(self.app, self.state, fen, band)
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
/// search at a time is the intended shape. `sweep_gen` is the sweep
/// cancellation token: a sweep records the generation it started under and
/// aborts (per node) once any later sweep or an explicit cancel bumps it —
/// so a stale sweep can never hold the TT lock hostage for seconds.
pub struct HumanTreeState {
    tt: AsyncMutex<TranspositionTable>,
    sweep_gen: AtomicU64,
    /// One-permit guard: at most one Eval_R Stockfish leaf process exists per
    /// app instance (spec 213 resource isolation). Commands hold the permit
    /// for the SfLeaf's whole lifetime, so overlapping tree/sweep invocations
    /// queue instead of multiplying engines under the user's analysis engine
    /// or a running tournament. Queueing is safe: sweeps in flight see the
    /// generation bump and abort within ~one node.
    leaf_slot: Semaphore,
}

impl Default for HumanTreeState {
    fn default() -> Self {
        Self {
            tt: AsyncMutex::new(TranspositionTable::new()),
            sweep_gen: AtomicU64::new(0),
            leaf_slot: Semaphore::new(1),
        }
    }
}

impl HumanTreeState {
    /// Wait for the single leaf-engine slot. Must be held across
    /// `SfLeaf::spawn` and dropped only after the SfLeaf (kill_on_drop) is.
    async fn acquire_leaf_slot(&self) -> SemaphorePermit<'_> {
        self.leaf_slot
            .acquire()
            .await
            .expect("leaf_slot semaphore is never closed")
    }
}

/// Tier-1 Eval_R for `fen` at rating `band` (spec 213 Phase 3). `band` is the
/// scalar slider = linked R⃗; the optional per-phase overrides
/// (`band_opening`/`band_middlegame`/`band_endgame`) unlink it — the band is
/// chosen per node by the node's phase either way. All knobs optional;
/// defaults sized for the 1–4 s/stop budget. Deterministic for a given
/// (fen, bands, knobs, Stockfish build).
#[tauri::command]
pub async fn human_eval_tree(
    app: tauri::AppHandle,
    maia_state: State<'_, MaiaState>,
    tree_state: State<'_, HumanTreeState>,
    fen: String,
    band: u32,
    band_opening: Option<u32>,
    band_middlegame: Option<u32>,
    band_endgame: Option<u32>,
    depth: Option<u32>,
    top_p: Option<f64>,
    max_candidates: Option<usize>,
    max_nodes: Option<usize>,
    leaf_depth: Option<u32>,
) -> Result<HumanSearchResult, String> {
    let bands = BandVector {
        opening: band_opening.unwrap_or(band),
        middlegame: band_middlegame.unwrap_or(band),
        endgame: band_endgame.unwrap_or(band),
    };
    for b in [band, bands.opening, bands.middlegame, bands.endgame] {
        if !maia::is_valid_band(b) {
            return Err(format!("no Maia-1 net for band {b} (available: 1100–1900)"));
        }
    }
    let cfg = HumanSearchConfig {
        bands,
        top_p: top_p.unwrap_or(DEFAULT_TOP_P).clamp(0.05, 1.0),
        max_candidates: max_candidates.unwrap_or(DEFAULT_MAX_CANDIDATES).clamp(1, 8),
        depth: depth.unwrap_or(DEFAULT_DEPTH).clamp(1, 6),
        max_nodes: max_nodes.unwrap_or(DEFAULT_MAX_NODES).clamp(1, 5_000),
        leaf_depth: leaf_depth.unwrap_or(DEFAULT_LEAF_DEPTH).clamp(1, 20),
    };

    let sf = resolve_stockfish()
        .ok_or("stockfish not found — install it with: brew install stockfish")?;
    // Declared before `leaf` so it drops after the engine dies: the slot is
    // free only once no SfLeaf process is alive.
    let _leaf_slot = tree_state.acquire_leaf_slot().await;
    let mut leaf = SfLeaf::spawn(&sf, cfg.leaf_depth).await?;
    let policy = MaiaPolicySource {
        app: &app,
        state: maia_state.inner(),
    };

    let mut tt = tree_state.tt.lock().await;
    if tt.len() > TT_CAP {
        tt.clear();
    }
    search_root(&cfg, &policy, &mut leaf, &mut tt, &fen).await
}

/// Background sweep across slider stops → the perception curve (spec 213
/// Phase 3). Runs tier-1 Eval_R at every band in `bands` (the frontend passes
/// the slider's stops), streaming each point over `on_point` as it lands and
/// returning the full set. Shares the session TT with `human_eval_tree` —
/// the current band's stop is usually already cached when the sweep starts.
/// Starting a new sweep cancels any sweep still in flight; a cancelled sweep
/// returns its partial points with `cancelled: true`, never an error.
#[tauri::command]
pub async fn human_eval_sweep(
    app: tauri::AppHandle,
    maia_state: State<'_, MaiaState>,
    tree_state: State<'_, HumanTreeState>,
    fen: String,
    bands: Vec<u32>,
    depth: Option<u32>,
    top_p: Option<f64>,
    max_candidates: Option<usize>,
    max_nodes: Option<usize>,
    leaf_depth: Option<u32>,
    on_point: Channel<HumanSearchResult>,
) -> Result<HumanSweepResult, String> {
    if bands.is_empty() {
        return Err("sweep needs at least one band".to_string());
    }
    for &b in &bands {
        if !maia::is_valid_band(b) {
            return Err(format!("no Maia-1 net for band {b} (available: 1100–1900)"));
        }
    }
    let base = HumanSearchConfig {
        bands: BandVector::linked(bands[0]), // overwritten per stop by sweep_bands
        top_p: top_p.unwrap_or(DEFAULT_TOP_P).clamp(0.05, 1.0),
        max_candidates: max_candidates.unwrap_or(DEFAULT_MAX_CANDIDATES).clamp(1, 8),
        depth: depth.unwrap_or(DEFAULT_DEPTH).clamp(1, 6),
        max_nodes: max_nodes.unwrap_or(DEFAULT_MAX_NODES).clamp(1, 5_000),
        leaf_depth: leaf_depth.unwrap_or(DEFAULT_LEAF_DEPTH).clamp(1, 20),
    };

    // Claim the generation BEFORE waiting on the leaf slot or the TT lock:
    // the sweep holding them sees the bump at its next node and releases
    // both within ~one node's work.
    let my_gen = tree_state.sweep_gen.fetch_add(1, Ordering::SeqCst) + 1;

    let sf = resolve_stockfish()
        .ok_or("stockfish not found — install it with: brew install stockfish")?;
    // Declared before `leaf` so it drops after the engine dies: the slot is
    // free only once no SfLeaf process is alive.
    let _leaf_slot = tree_state.acquire_leaf_slot().await;
    let mut leaf = SfLeaf::spawn(&sf, base.leaf_depth).await?;
    let policy = MaiaPolicySource {
        app: &app,
        state: maia_state.inner(),
    };

    let mut tt = tree_state.tt.lock().await;
    if tt.len() > TT_CAP {
        tt.clear();
    }
    let gen = &tree_state.sweep_gen;
    let cancel = move || gen.load(Ordering::SeqCst) != my_gen;
    let mut emit = |r: &HumanSearchResult| {
        let _ = on_point.send(r.clone());
    };
    sweep_bands(&base, &bands, &policy, &mut leaf, &mut tt, &fen, &cancel, &mut emit).await
}

/// Cancel any in-flight perception-curve sweep (position changed, tree mode
/// toggled off, panel unmounted). Deliberately does not touch the TT lock,
/// so it returns immediately even while a sweep is mid-search.
#[tauri::command]
pub async fn human_eval_sweep_cancel(
    tree_state: State<'_, HumanTreeState>,
) -> Result<(), String> {
    tree_state.sweep_gen.fetch_add(1, Ordering::SeqCst);
    Ok(())
}

/// "Visible from ~R" for one tournament mistake (spec 213 Phase 4): Eval_R
/// scan over `bands` on the AFTER-mistake position, returning the lowest band
/// whose restricted tree registers the swing from `before_cp` to `after_cp`
/// (White-POV cp; the frontend collapses mates to a bounded pawn-equivalent).
///
/// Deliberately the OPPOSITE priority of `human_eval_sweep`: this background
/// pass does NOT claim a new sweep generation — it records the current one
/// and yields (returns `cancelled: true`) as soon as any live slider sweep or
/// explicit cancel bumps it. Sharing the session TT mutex serializes it
/// behind live searches, and its Stockfish is a private single-threaded
/// process, so it never competes with the tournament's playing engines.
#[tauri::command]
pub async fn visible_from_sweep(
    app: tauri::AppHandle,
    maia_state: State<'_, MaiaState>,
    tree_state: State<'_, HumanTreeState>,
    fen: String,
    before_cp: i64,
    after_cp: i64,
    bands: Vec<u32>,
    depth: Option<u32>,
    top_p: Option<f64>,
    max_candidates: Option<usize>,
    max_nodes: Option<usize>,
    leaf_depth: Option<u32>,
) -> Result<VisibleFromResult, String> {
    if bands.is_empty() {
        return Err("visible-from scan needs at least one band".to_string());
    }
    for &b in &bands {
        if !maia::is_valid_band(b) {
            return Err(format!("no Maia-1 net for band {b} (available: 1100–1900)"));
        }
    }
    let base = HumanSearchConfig {
        bands: BandVector::linked(bands[0]), // overwritten per band by the scan
        top_p: top_p.unwrap_or(DEFAULT_TOP_P).clamp(0.05, 1.0),
        max_candidates: max_candidates.unwrap_or(DEFAULT_MAX_CANDIDATES).clamp(1, 8),
        depth: depth.unwrap_or(DEFAULT_DEPTH).clamp(1, 6),
        max_nodes: max_nodes.unwrap_or(DEFAULT_MAX_NODES).clamp(1, 5_000),
        leaf_depth: leaf_depth.unwrap_or(DEFAULT_LEAF_DEPTH).clamp(1, 20),
    };

    // Record — don't bump — the generation: live sweeps preempt this pass.
    let my_gen = tree_state.sweep_gen.load(Ordering::SeqCst);

    let sf = resolve_stockfish()
        .ok_or("stockfish not found — install it with: brew install stockfish")?;
    let mut leaf = SfLeaf::spawn(&sf, base.leaf_depth).await?;
    let policy = MaiaPolicySource {
        app: &app,
        state: maia_state.inner(),
    };

    let mut tt = tree_state.tt.lock().await;
    if tt.len() > TT_CAP {
        tt.clear();
    }
    let gen = &tree_state.sweep_gen;
    let cancel = move || gen.load(Ordering::SeqCst) != my_gen;
    visible_from_scan(
        &base, &bands, &policy, &mut leaf, &mut tt, &fen, before_cp, after_cp, &cancel,
    )
    .await
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
    /// `set` installs a band-agnostic policy; `set_for_band` a band-specific
    /// one (looked up first), so tests can prove WHICH band a node consulted.
    struct TablePolicy {
        any: HashMap<String, Vec<MaiaMove>>,
        by_band: HashMap<(String, u32), Vec<MaiaMove>>,
    }

    impl TablePolicy {
        fn new() -> Self {
            Self {
                any: HashMap::new(),
                by_band: HashMap::new(),
            }
        }
        fn set(&mut self, fen: &str, moves: Vec<MaiaMove>) {
            self.any.insert(epd_key(fen).unwrap(), moves);
        }
        fn set_for_band(&mut self, fen: &str, band: u32, moves: Vec<MaiaMove>) {
            self.by_band.insert((epd_key(fen).unwrap(), band), moves);
        }
    }

    impl PolicySource for TablePolicy {
        fn policy<'a>(
            &'a self,
            fen: &'a str,
            band: u32,
        ) -> BoxFut<'a, Result<Vec<MaiaMove>, String>> {
            Box::pin(async move {
                let epd = epd_key(fen)?;
                self.by_band
                    .get(&(epd.clone(), band))
                    .or_else(|| self.any.get(&epd))
                    .cloned()
                    .ok_or(format!("test policy table has no entry for {epd} @ {band}"))
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
            bands: BandVector::linked(band),
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

    // -- Per-node phase conditioning (spec 213: band chosen by the node's phase) --

    /// Same starting board, move counter advanced past the opening boundary
    /// (ply 16 = 2×(9−1)) — same EPD, different phase.
    const STARTPOS_MOVE_9: &str = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 9";

    #[test]
    fn game_ply_derives_from_the_fen_move_counters() {
        assert_eq!(game_ply_of(&parse_fen(STARTPOS).unwrap()), 0);
        let after_e4 = after(STARTPOS, &["e2e4"]);
        assert_eq!(game_ply_of(&parse_fen(&after_e4).unwrap()), 1);
        let after_e4_e5 = after(STARTPOS, &["e2e4", "e7e5"]);
        assert_eq!(game_ply_of(&parse_fen(&after_e4_e5).unwrap()), 2);
        assert_eq!(game_ply_of(&parse_fen(STARTPOS_MOVE_9).unwrap()), 16);
    }

    #[test]
    fn node_band_follows_the_calibration_phase_heuristic() {
        let bands = BandVector {
            opening: 1100,
            middlegame: 1500,
            endgame: 1900,
        };
        // Full material, ply 0 → opening.
        assert_eq!(node_band(&bands, &parse_fen(STARTPOS).unwrap()), 1100);
        // Same board out of the opening (ply 16) → middlegame.
        assert_eq!(node_band(&bands, &parse_fen(STARTPOS_MOVE_9).unwrap()), 1500);
        // Q+R vs bare king (non-pawn weight 6 ≤ 8) at ply 3: endgame wins
        // over the ply test — an early trade-down IS an endgame.
        let early_endgame = "6k1/8/3Q4/8/8/8/8/R5K1 b - - 0 2";
        assert_eq!(node_band(&bands, &parse_fen(early_endgame).unwrap()), 1900);
        // Linked scalar: one band regardless of phase.
        let linked = BandVector::linked(1700);
        assert_eq!(node_band(&linked, &parse_fen(STARTPOS).unwrap()), 1700);
        assert_eq!(node_band(&linked, &parse_fen(early_endgame).unwrap()), 1700);
    }

    /// The spec's named synthetic case — phase differs root vs leaf side of
    /// the line. Root (move 20, ply 38): White Qd4+Ra1 vs Black Qd6, non-pawn
    /// weight 10 → MIDDLEGAME. White's only visible move trades queens
    /// (Qxd6), dropping the weight to 6 → the reply node is an ENDGAME and
    /// must consult the endgame band, mid-line. The two bands' policies pick
    /// different king moves with opposite leaf evals, so which band was
    /// consulted is visible in the eval itself.
    #[tokio::test]
    async fn band_switches_mid_line_when_the_line_trades_into_an_endgame() {
        let root = "6k1/8/3q4/8/3Q4/8/8/R5K1 w - - 0 20";
        let after_trade = after(root, &["d4d6"]);

        let mut policy = TablePolicy::new();
        policy.set_for_band(root, 1500, vec![mv("d4d6", 1.0)]);
        // Endgame-band human steps toward the center; middlegame-band human
        // hides in the corner. Only one of these policies may be consulted.
        policy.set_for_band(&after_trade, 1100, vec![mv("g8f7", 1.0)]);
        policy.set_for_band(&after_trade, 1500, vec![mv("g8h8", 1.0)]);

        let mut leaf = TableLeaf::new();
        leaf.set(&after(root, &["d4d6", "g8f7"]), 100);
        leaf.set(&after(root, &["d4d6", "g8h8"]), -500);

        // Unlinked R⃗: middlegame 1500, endgame 1100 — the reply node is past
        // the phase boundary and switches to 1100.
        let mut tt = TranspositionTable::new();
        let unlinked = HumanSearchConfig {
            bands: BandVector {
                opening: 1500,
                middlegame: 1500,
                endgame: 1100,
            },
            ..cfg(1500, 1.0, 2)
        };
        let r = search_root(&unlinked, &policy, &mut leaf, &mut tt, root)
            .await
            .unwrap();
        assert_eq!(r.pv, vec!["d4d6", "g8f7"], "reply came from the endgame band");
        assert_eq!(r.cp_white, 100);
        assert_eq!(r.bands, [1500, 1500, 1100]);

        // Linked scalar: the same node consults 1500 and the eval flips.
        let mut tt = TranspositionTable::new();
        let r = search_root(&cfg(1500, 1.0, 2), &policy, &mut leaf, &mut tt, root)
            .await
            .unwrap();
        assert_eq!(r.pv, vec!["d4d6", "g8h8"], "linked R⃗ never switches band");
        assert_eq!(r.cp_white, -500);
        assert_eq!(r.band, 1500, "back-compat scalar band field");
    }

    /// Opening conditioning + cache hygiene: the same EPD on either side of
    /// the ply-16 boundary picks different bands, so with an unlinked
    /// opening band the TT must NOT serve one from the other.
    #[tokio::test]
    async fn opening_band_applies_below_ply_16_and_does_not_pollute_the_cache() {
        let mut policy = TablePolicy::new();
        policy.set_for_band(STARTPOS, 1100, vec![mv("e2e4", 1.0)]);
        policy.set_for_band(STARTPOS, 1900, vec![mv("d2d4", 1.0)]);

        let mut leaf = TableLeaf::new();
        // Leaves are Black to move: mover-POV −30/−70 ⇒ White-POV +30/+70.
        leaf.set(&after(STARTPOS, &["e2e4"]), -30);
        leaf.set(&after(STARTPOS, &["d2d4"]), -70);

        let unlinked = HumanSearchConfig {
            bands: BandVector {
                opening: 1100,
                middlegame: 1900,
                endgame: 1900,
            },
            ..cfg(1900, 1.0, 1)
        };
        let mut tt = TranspositionTable::new();
        let opening = search_root(&unlinked, &policy, &mut leaf, &mut tt, STARTPOS)
            .await
            .unwrap();
        assert_eq!(opening.pv, vec!["e2e4"], "ply 0 consults the opening band");
        assert_eq!(opening.cp_white, 30);

        // Same EPD at ply 16, SAME tt: middlegame band, distinct cache entry.
        let mid = search_root(&unlinked, &policy, &mut leaf, &mut tt, STARTPOS_MOVE_9)
            .await
            .unwrap();
        assert_eq!(mid.pv, vec!["d2d4"], "ply 16 consults the middlegame band");
        assert_eq!(mid.cp_white, 70);
        assert_eq!(mid.tt_hits, 0, "opening-phase entry must not answer a middlegame node");
    }

    /// Regression: with a LINKED R⃗ the ply plays no part in the band choice,
    /// so the same EPD at a different move number is a pure cache hit.
    #[tokio::test]
    async fn linked_bands_share_cache_entries_across_move_numbers() {
        let (policy, mut leaf) = minimax_fixture();
        let mut tt = TranspositionTable::new();
        let c = cfg(1500, 1.0, 2);
        let first = search_root(&c, &policy, &mut leaf, &mut tt, STARTPOS)
            .await
            .unwrap();
        let second = search_root(&c, &policy, &mut leaf, &mut tt, STARTPOS_MOVE_9)
            .await
            .unwrap();
        assert_eq!(second.cp_white, first.cp_white);
        assert_eq!(second.tt_hits, 1, "root answered by the ply-0 search's entry");
        assert_eq!(second.leaf_evals, 0);
    }

    // -- Background sweep → perception curve (spec 213 Phase 3) -----------------

    /// Perception-curve fixture: the refutation resource (b8a6, White POV
    /// −300 after e4) is inside the 1900 nucleus but outside the 1100 one —
    /// the +0.5 → −3.0 jump between stops IS the flagship visual's semantics.
    fn perception_fixture() -> (TablePolicy, TableLeaf) {
        let root = STARTPOS;
        let after_e4 = after(root, &["e2e4"]);
        let mut policy = TablePolicy::new();
        policy.set(root, vec![mv("e2e4", 1.0)]);
        // 1100 nucleus at top_p 0.8: e7e5 alone reaches the mass. 1900 puts
        // real weight on the resource, so both replies are visible.
        policy.set_for_band(&after_e4, 1100, vec![mv("e7e5", 0.90), mv("b8a6", 0.09)]);
        policy.set_for_band(&after_e4, 1900, vec![mv("e7e5", 0.55), mv("b8a6", 0.44)]);

        let mut leaf = TableLeaf::new();
        leaf.set(&after(root, &["e2e4", "e7e5"]), 50);
        leaf.set(&after(root, &["e2e4", "b8a6"]), -300);
        (policy, leaf)
    }

    #[tokio::test]
    async fn sweep_produces_one_point_per_band_and_the_curve_jumps() {
        let (policy, mut leaf) = perception_fixture();
        let mut tt = TranspositionTable::new();
        let mut streamed: Vec<u32> = Vec::new();
        let r = sweep_bands(
            &cfg(1100, 0.80, 2),
            &[1100, 1900],
            &policy,
            &mut leaf,
            &mut tt,
            STARTPOS,
            &|| false,
            &mut |p| streamed.push(p.band),
        )
        .await
        .unwrap();

        assert!(!r.cancelled);
        assert_eq!(streamed, vec![1100, 1900], "one point streamed per stop, in order");
        assert_eq!(r.points.len(), 2);
        assert_eq!(r.points[0].band, 1100);
        assert_eq!(r.points[0].cp_white, 50, "1100 doesn't see the resource");
        assert_eq!(r.points[1].band, 1900);
        assert_eq!(r.points[1].cp_white, -300, "the resource enters sight at 1900");
    }

    #[tokio::test]
    async fn sweep_stops_share_the_tt_and_reruns_are_free() {
        let (policy, mut leaf) = perception_fixture();
        let mut tt = TranspositionTable::new();
        let base = cfg(1100, 0.80, 2);
        let first = sweep_bands(
            &base, &[1100, 1900], &policy, &mut leaf, &mut tt, STARTPOS, &|| false, &mut |_| {},
        )
        .await
        .unwrap();
        // The e4·e5 leaf lies inside both bands' trees but hits the engine
        // once — leaf entries are band-free: 1100 sees {e5} → 1 eval; 1900
        // sees {e5, Na6} → e5 from the cache, Na6 evaluated. 2 calls total.
        assert_eq!(leaf.calls, 2, "shared leaf scored once across the stops");

        let rerun = sweep_bands(
            &base, &[1100, 1900], &policy, &mut leaf, &mut tt, STARTPOS, &|| false, &mut |_| {},
        )
        .await
        .unwrap();
        // Same curve (values + PVs); the per-invocation counters legitimately
        // differ — the rerun is all cache hits.
        let curve = |r: &HumanSweepResult| -> Vec<(u32, i64, Vec<String>)> {
            r.points.iter().map(|p| (p.band, p.cp_white, p.pv.clone())).collect()
        };
        assert_eq!(curve(&rerun), curve(&first), "same TT, same curve");
        assert_eq!(leaf.calls, 2, "rerun served entirely from the cache");
        assert!(rerun.points.iter().all(|p| p.leaf_evals == 0));
    }

    #[tokio::test]
    async fn cancelled_sweep_returns_partial_points_not_an_error() {
        let (policy, mut leaf) = perception_fixture();
        let mut tt = TranspositionTable::new();
        // Cancel as soon as the first point has landed.
        let done = std::sync::atomic::AtomicBool::new(false);
        let cancel = || done.load(std::sync::atomic::Ordering::SeqCst);
        let mut on_point = |_: &HumanSearchResult| {
            done.store(true, std::sync::atomic::Ordering::SeqCst);
        };
        let r = sweep_bands(
            &cfg(1100, 0.80, 2),
            &[1100, 1900],
            &policy,
            &mut leaf,
            &mut tt,
            STARTPOS,
            &cancel,
            &mut on_point,
        )
        .await
        .unwrap();
        assert!(r.cancelled);
        assert_eq!(r.points.len(), 1, "only the first stop completed");
        assert_eq!(r.points[0].band, 1100);
    }

    #[tokio::test]
    async fn sweep_cancelled_before_the_first_node_computes_nothing() {
        let (policy, mut leaf) = perception_fixture();
        let mut tt = TranspositionTable::new();
        let r = sweep_bands(
            &cfg(1100, 0.80, 2),
            &[1100, 1900],
            &policy,
            &mut leaf,
            &mut tt,
            STARTPOS,
            &|| true,
            &mut |_| panic!("no point should stream"),
        )
        .await
        .unwrap();
        assert!(r.cancelled);
        assert!(r.points.is_empty());
        assert_eq!(leaf.calls, 0, "the engine was never consulted");
    }

    // -- Resource isolation (spec 213): one leaf engine per app instance --------

    #[tokio::test]
    async fn leaf_slot_admits_at_most_one_holder_at_a_time() {
        let state = HumanTreeState::default();
        let permit = state.acquire_leaf_slot().await;
        assert!(
            state.leaf_slot.try_acquire().is_err(),
            "a second Eval_R engine slot must not open while one is held"
        );
        drop(permit);
        let again = state.leaf_slot.try_acquire();
        assert!(again.is_ok(), "slot reopens once the holder drops");
    }

    #[tokio::test]
    async fn leaf_slot_serializes_concurrent_sweep_style_holders() {
        use std::sync::atomic::AtomicUsize;
        use std::sync::Arc;

        // N tasks each hold the slot briefly; the observed concurrent-holder
        // count must never exceed 1 (the "at most one SfLeaf process" claim).
        let state = Arc::new(HumanTreeState::default());
        let live = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let mut tasks = Vec::new();
        for _ in 0..8 {
            let (state, live, peak) = (state.clone(), live.clone(), peak.clone());
            tasks.push(tokio::spawn(async move {
                let _slot = state.acquire_leaf_slot().await;
                let now = live.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(now, Ordering::SeqCst);
                tokio::task::yield_now().await; // give overlap a chance to show
                live.fetch_sub(1, Ordering::SeqCst);
            }));
        }
        for t in tasks {
            t.await.unwrap();
        }
        assert_eq!(peak.load(Ordering::SeqCst), 1, "holders never overlap");
    }

    // -- "Visible from ~R" (spec 213 Phase 4: tournament error report) ----------

    #[test]
    fn visible_from_picks_the_lowest_band_covering_half_the_swing() {
        // Mistake: White-POV +120 before, −300 after (swing −420). Bands 1100
        // and 1300 still believe the old eval; 1500 has crossed the midpoint
        // (moved −270 of −420); 1900 all but agrees with the truth.
        let points = [(1100, 100), (1300, 80), (1500, -150), (1900, -290)];
        assert_eq!(visible_from(&points, 120, -300), Some(1500));
        // Point order must not matter — "lowest band", not "first point".
        let shuffled = [(1900, -290), (1500, -150), (1300, 80), (1100, 100)];
        assert_eq!(visible_from(&shuffled, 120, -300), Some(1500));
    }

    #[test]
    fn visible_from_is_none_when_no_band_sees_it_or_the_swing_is_noise() {
        // Every band still sits near the pre-mistake eval → not visible.
        let blind = [(1100, 110), (1500, 130), (1900, 90)];
        assert_eq!(visible_from(&blind, 120, -300), None);
        // Movement in the WRONG direction never counts as seeing.
        let wrong_way = [(1900, 400)];
        assert_eq!(visible_from(&wrong_way, 120, -300), None);
        // Swing below the noise floor → no verdict even on a perfect match.
        let tiny = [(1100, -20)];
        assert_eq!(visible_from(&tiny, 20, -20), None);
        // No points → no verdict.
        assert_eq!(visible_from(&[], 120, -300), None);
    }

    #[test]
    fn band_sees_requires_direction_and_half_coverage() {
        // Swing +200 (Black's mistake): +100 is exactly half — visible.
        assert!(band_sees(100, 0, 200));
        assert!(!band_sees(99, 0, 200), "just under half stays blind");
        assert!(!band_sees(-150, 0, 200), "wrong direction stays blind");
        assert!(!band_sees(0, 0, 200), "no movement stays blind");
    }

    #[tokio::test]
    async fn scan_stops_at_the_first_band_that_sees_the_swing() {
        // After-mistake position = after_e4 from the perception fixture: the
        // refutation (b8a6, −300) is outside the 1100 nucleus, inside 1500's
        // and 1900's. Pre-mistake belief +50, truth −300.
        let root = STARTPOS;
        let after_e4 = after(root, &["e2e4"]);
        let mut policy = TablePolicy::new();
        policy.set_for_band(&after_e4, 1100, vec![mv("e7e5", 0.90), mv("b8a6", 0.09)]);
        policy.set_for_band(&after_e4, 1500, vec![mv("e7e5", 0.55), mv("b8a6", 0.44)]);
        policy.set_for_band(&after_e4, 1900, vec![mv("e7e5", 0.55), mv("b8a6", 0.44)]);
        let mut leaf = TableLeaf::new();
        leaf.set(&after(root, &["e2e4", "e7e5"]), 50);
        leaf.set(&after(root, &["e2e4", "b8a6"]), -300);

        let mut tt = TranspositionTable::new();
        let r = visible_from_scan(
            &cfg(1100, 0.80, 1),
            // Descending on purpose: the scan must sort ascending itself.
            &[1900, 1500, 1100],
            &policy,
            &mut leaf,
            &mut tt,
            &after_e4,
            50,
            -300,
            &|| false,
        )
        .await
        .unwrap();
        assert_eq!(r.visible_from, Some(1500));
        assert!(!r.cancelled);
        assert_eq!(r.points.len(), 2, "1900 never searched — 1500 already saw it");
        assert_eq!(r.points[0].band, 1100);
        assert_eq!(r.points[0].cp_white, 50, "1100 still believes the old eval");
        assert_eq!(r.points[1].band, 1500);
        assert_eq!(r.points[1].cp_white, -300);
    }

    #[tokio::test]
    async fn scan_skips_the_engine_entirely_on_a_noise_swing() {
        let policy = TablePolicy::new();
        let mut leaf = TableLeaf::new();
        let mut tt = TranspositionTable::new();
        let r = visible_from_scan(
            &cfg(1100, 0.80, 1),
            &[1100, 1900],
            &policy,
            &mut leaf,
            &mut tt,
            STARTPOS,
            10,
            -10, // |swing| 20 < VISIBLE_MIN_SWING_CP
            &|| false,
        )
        .await
        .unwrap();
        assert_eq!(r.visible_from, None);
        assert!(r.points.is_empty());
        assert_eq!(leaf.calls, 0, "no engine work for a non-mistake");
    }

    #[tokio::test]
    async fn cancelled_scan_returns_partial_points_with_the_flag() {
        let root = STARTPOS;
        let after_e4 = after(root, &["e2e4"]);
        let mut policy = TablePolicy::new();
        // 1100 stays blind (only e7e5 in the nucleus), so the scan wants to
        // continue to 1900 — the cancel flag, armed by 1100's search reaching
        // its leaf, must stop it between the bands with a partial result.
        policy.set_for_band(&after_e4, 1100, vec![mv("e7e5", 0.90), mv("b8a6", 0.09)]);
        policy.set_for_band(&after_e4, 1900, vec![mv("e7e5", 0.55), mv("b8a6", 0.44)]);
        let mut leaf = TableLeaf::new();
        leaf.set(&after(root, &["e2e4", "e7e5"]), 50);
        leaf.set(&after(root, &["e2e4", "b8a6"]), -300);

        // Depth-1 band-1100 search visits root + 1 leaf = 2 nodes; the probe
        // fires once per node, so cancelling from the 3rd probe on lets the
        // first band finish and kills the second before its first node.
        let probes = std::sync::atomic::AtomicUsize::new(0);
        let cancel = move || probes.fetch_add(1, std::sync::atomic::Ordering::SeqCst) >= 2;

        let mut tt = TranspositionTable::new();
        let r = visible_from_scan(
            &cfg(1100, 0.80, 1),
            &[1100, 1900],
            &policy,
            &mut leaf,
            &mut tt,
            &after_e4,
            50,
            -300,
            &cancel,
        )
        .await
        .unwrap();
        assert!(r.cancelled);
        assert_eq!(r.points.len(), 1, "only the 1100 point completed");
        assert_eq!(r.points[0].band, 1100);
        assert_eq!(r.visible_from, None, "1100 alone doesn't see it");
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
            // One warm 1500 process; the linked config only ever asks for it.
            fn policy<'a>(
                &'a self,
                fen: &'a str,
                _band: u32,
            ) -> BoxFut<'a, Result<Vec<MaiaMove>, String>> {
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
            bands: BandVector::linked(1500),
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
