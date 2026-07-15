// Maia policy service — an lc0 subprocess speaking UCI, read at the policy head.
//
// Maia (CSSLab, U. Toronto) is a set of per-rating human move models in the
// Leela protobuf format; lc0 runs them. For any position and rating band we ask
// lc0 `go nodes 1` with VerboseMoveStats and read the root policy — the
// probability a rating-R human puts on each legal move. That distribution is the
// raw material for the Elo-conditioned evaluator (spec 213).
//
// Design notes:
//   * `nodes=1` is mandatory. Maia is meant to be read at the policy head; adding
//     search "un-humanizes" it (documented Maia usage).
//   * lc0 exits on stdin EOF mid-search, so each process keeps its pipe open for
//     its whole lifetime — same discipline as uci.rs.
//   * One process per band, lazily spawned, LRU-capped. Slider locality means the
//     current band ± a stop stay warm; warm query is ~13 ms on this machine.
//   * Weights are fetched on first use from the CSSLab release, checksum-verified,
//     and cached under app_data_dir/maia — nothing GPL-encumbered ships in the
//     .dmg. The app is GPL-3.0 anyway, so Maia-1 (GPL-3.0) is compatible.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;

use serde::Serialize;
use tauri::{Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::Mutex as AsyncMutex;

/// Maia-1 rating bands with published nets (100-Elo steps, 1100–1900).
pub const BANDS: [u32; 9] = [1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800, 1900];

/// Warm lc0 processes to keep alive at once. Covers the current slider stop plus
/// its neighbours; each process is ~20 MB RSS so the cap is about restraint, not
/// necessity.
const POOL_CAP: usize = 3;

const RELEASE_BASE: &str =
    "https://github.com/CSSLab/maia-chess/releases/download/v1.0";

/// SHA-256 of the CSSLab `v1.0` release assets, computed from the published
/// files on 2026-07-14. CSSLab publishes no separate checksum manifest, so these
/// are our own record of the bytes we validated the pipeline against; a download
/// that doesn't match is rejected. (Reported honestly: this pins *these* bytes,
/// it is not an upstream-signed digest.)
const CHECKSUMS: [(u32, &str); 9] = [
    (1100, "e1cf1cd0c96b8a4fa6a275f4b9fd54ed1ffebf9fe44641b9fceded310e9619c4"),
    (1200, "ead4ba953f233ae732999ebc1e2b675378148527ebcfad2f0acbc5e4c224d98e"),
    (1300, "36195f87bf4761834baa0bf87472b18509a7261a9d7d6f1a8443261369a733f2"),
    (1400, "d5353ea6766356dad2d28920c6692f37a5f30963767f1a3105d33b4d0af011e8"),
    (1500, "35ab6f20421d59e1df3b17c5a5016947af4c6761368ef84044a9a9c7619a9a00"),
    (1600, "d2c9e5948581acf4b9fc0b1e720c5dc0fe64ce80cfc4a239d3f8a42e1176c876"),
    (1700, "d277eacd792d340a30abb464dc65127254e65cac57abca17facc469889b96478"),
    (1800, "0031ad7c4256b1fd09fbebd28418d644d68b26cd2a45df4967ccf5c7ec9c4965"),
    (1900, "e2f565f42d7cd9f122557e6dc4eb84e5bbaedceda1d404dc485d3611c7c97a12"),
];

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct MaiaMove {
    pub uci: String,
    /// Policy probability in [0, 1] the band assigns to this move.
    pub prob: f64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct MaiaPolicy {
    pub band: u32,
    /// Every legal move with its policy probability, as reported by lc0.
    pub moves: Vec<MaiaMove>,
    /// Root value-head Q (side-to-move POV) if lc0 reported it; a free extra
    /// predictor (design §1.4), not used by tier-0.
    pub value: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MaiaStatus {
    /// Whether an lc0 binary was found. When false the UI hides the feature.
    pub lc0_available: bool,
    pub lc0_path: Option<String>,
    /// Bands with published nets (the queryable slider stops' source range).
    pub bands: Vec<u32>,
    /// Bands whose weight file is already downloaded (no first-use wait).
    pub cached_bands: Vec<u32>,
}

// ---------------------------------------------------------------------------
// lc0 + weight discovery
// ---------------------------------------------------------------------------

pub fn is_valid_band(band: u32) -> bool {
    BANDS.contains(&band)
}

fn checksum_for(band: u32) -> Option<&'static str> {
    CHECKSUMS.iter().find(|(b, _)| *b == band).map(|(_, s)| *s)
}

pub fn weights_filename(band: u32) -> String {
    format!("maia-{band}.pb.gz")
}

pub fn weights_url(band: u32) -> String {
    format!("{RELEASE_BASE}/{}", weights_filename(band))
}

/// Locate an lc0 binary: explicit override, then the usual install locations,
/// then `which`. Returns None when lc0 is not installed (feature degrades).
pub fn resolve_lc0() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("MAIA_LC0_PATH") {
        let pb = PathBuf::from(p);
        if pb.exists() {
            return Some(pb);
        }
    }
    for cand in ["/opt/homebrew/bin/lc0", "/usr/local/bin/lc0", "/usr/bin/lc0"] {
        let pb = PathBuf::from(cand);
        if pb.exists() {
            return Some(pb);
        }
    }
    if let Ok(out) = std::process::Command::new("which").arg("lc0").output() {
        if out.status.success() {
            let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !s.is_empty() {
                let pb = PathBuf::from(&s);
                if pb.exists() {
                    return Some(pb);
                }
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Weight manager
// ---------------------------------------------------------------------------

/// Reject bytes that aren't a gzip and, when we have a pinned digest for the
/// band, that don't match it. `expected` is threaded in (rather than looked up)
/// so tests can drive the verify/cache logic with a fixture and its own digest.
fn verify_download(bytes: &[u8], expected: Option<&str>) -> Result<(), String> {
    if bytes.len() < 2 || bytes[0] != 0x1f || bytes[1] != 0x8b {
        return Err("downloaded Maia weights are not a gzip file".to_string());
    }
    if let Some(expected) = expected {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(bytes);
        let got = hex::encode(hasher.finalize());
        if !got.eq_ignore_ascii_case(expected) {
            return Err(format!(
                "Maia weights checksum mismatch (expected {expected}, got {got})"
            ));
        }
    }
    Ok(())
}

/// Ensure the band's weight file exists in `dir`, downloading via `fetch` on
/// first use. Verifies against `expected` checksum, writes atomically. A cached
/// file that fails verification is re-downloaded. `fetch` is injected so tests
/// never hit the network.
async fn ensure_weights_with<F, Fut>(
    band: u32,
    dir: &Path,
    expected: Option<&str>,
    fetch: F,
) -> Result<PathBuf, String>
where
    F: FnOnce(String) -> Fut,
    Fut: std::future::Future<Output = Result<Vec<u8>, String>>,
{
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let path = dir.join(weights_filename(band));

    if path.exists() {
        match std::fs::read(&path) {
            Ok(bytes) if verify_download(&bytes, expected).is_ok() => return Ok(path),
            _ => { /* corrupt or stale cache — fall through and re-fetch */ }
        }
    }

    let bytes = fetch(weights_url(band)).await?;
    verify_download(&bytes, expected)?;

    let tmp = dir.join(format!("{}.part", weights_filename(band)));
    std::fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(path)
}

/// Production entry point: pinned checksum + real HTTP fetch.
pub async fn ensure_weights(band: u32, dir: &Path) -> Result<PathBuf, String> {
    if !is_valid_band(band) {
        return Err(format!(
            "no Maia-1 net for band {band} (available: 1100–1900)"
        ));
    }
    ensure_weights_with(band, dir, checksum_for(band), http_download).await
}

async fn http_download(url: String) -> Result<Vec<u8>, String> {
    let resp = reqwest::get(&url)
        .await
        .map_err(|e| format!("Maia weight download failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "Maia weight download failed: HTTP {} for {url}",
            resp.status()
        ));
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("Maia weight download read failed: {e}"))?;
    Ok(bytes.to_vec())
}

// ---------------------------------------------------------------------------
// Policy parsing
// ---------------------------------------------------------------------------

fn is_uci_move(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 4 && b.len() != 5 {
        return false;
    }
    let file = |c: u8| (b'a'..=b'h').contains(&c);
    let rank = |c: u8| (b'1'..=b'8').contains(&c);
    file(b[0])
        && rank(b[1])
        && file(b[2])
        && rank(b[3])
        && (b.len() == 4 || matches!(b[4], b'q' | b'r' | b'b' | b'n'))
}

/// Extract a `(KEY value)` numeric field from a VerboseMoveStats line, e.g.
/// `(P:  50.22%)` -> 50.22, `(Q:  0.03821)` -> 0.03821. Trailing '%' is stripped.
fn paren_field(line: &str, key: &str) -> Option<f64> {
    let needle = format!("({key}");
    let start = line.find(&needle)? + needle.len();
    let end = line[start..].find(')')? + start;
    line[start..end]
        .trim()
        .trim_end_matches('%')
        .trim()
        .parse::<f64>()
        .ok()
}

/// Parse one `info string ...` body (the text after "info string "). A move line
/// contributes a `MaiaMove`; the summary `node` line contributes the root value.
fn parse_verbose_line(body: &str, moves: &mut Vec<MaiaMove>, value: &mut Option<f64>) {
    let Some(token) = body.split_whitespace().next() else {
        return;
    };
    if is_uci_move(token) {
        if let Some(pct) = paren_field(body, "P:") {
            moves.push(MaiaMove {
                uci: token.to_string(),
                prob: pct / 100.0,
            });
        }
    } else if token == "node" {
        // Root node summary carries the value head (Q, side-to-move POV).
        if value.is_none() {
            *value = paren_field(body, "Q:");
        }
    }
}

/// Assemble a policy from a full block of engine output lines (as raw lines,
/// with or without the `info string ` prefix stripped). Pure, for testing.
fn parse_policy(band: u32, lines: &[&str]) -> MaiaPolicy {
    let mut moves = Vec::new();
    let mut value = None;
    for line in lines {
        let t = line.trim();
        if let Some(body) = t.strip_prefix("info string ") {
            parse_verbose_line(body, &mut moves, &mut value);
        }
    }
    MaiaPolicy { band, moves, value }
}

// ---------------------------------------------------------------------------
// lc0 process
// ---------------------------------------------------------------------------

struct MaiaIo {
    _child: Child,
    stdin: ChildStdin,
    reader: BufReader<ChildStdout>,
}

/// One warm lc0 process bound to a single band. Queries serialize on `io`.
pub struct MaiaProcess {
    band: u32,
    io: AsyncMutex<MaiaIo>,
}

impl MaiaProcess {
    async fn spawn(lc0: &Path, weights: &Path, band: u32) -> Result<Self, String> {
        let mut child = Command::new(lc0)
            .arg(format!("--weights={}", weights.display()))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("failed to start lc0: {e}"))?;

        let stdout = child.stdout.take().ok_or("lc0: no stdout")?;
        let mut stdin = child.stdin.take().ok_or("lc0: no stdin")?;
        let mut reader = BufReader::new(stdout);

        // UCI handshake; capture the id-name for a version sanity check.
        write_line(&mut stdin, "uci").await?;
        let mut id_name = String::new();
        loop {
            let mut line = String::new();
            let n = reader
                .read_line(&mut line)
                .await
                .map_err(|e| format!("lc0 read error: {e}"))?;
            if n == 0 {
                return Err("lc0 exited during handshake".to_string());
            }
            let t = line.trim();
            if let Some(name) = t.strip_prefix("id name ") {
                id_name = name.to_string();
            }
            if t == "uciok" {
                break;
            }
        }
        if !id_name.to_lowercase().contains("lc0") {
            return Err(format!(
                "engine at {} does not identify as lc0 (id name: {id_name:?})",
                lc0.display()
            ));
        }

        write_line(&mut stdin, "setoption name VerboseMoveStats value true").await?;
        write_line(&mut stdin, "isready").await?;
        loop {
            let mut line = String::new();
            let n = reader
                .read_line(&mut line)
                .await
                .map_err(|e| format!("lc0 read error: {e}"))?;
            if n == 0 {
                return Err("lc0 exited before readyok".to_string());
            }
            if line.trim() == "readyok" {
                break;
            }
        }

        Ok(Self {
            band,
            io: AsyncMutex::new(MaiaIo {
                _child: child,
                stdin,
                reader,
            }),
        })
    }

    /// Query the root policy for `fen`. Serialized per process.
    pub async fn query(&self, fen: &str) -> Result<MaiaPolicy, String> {
        let fen = fen.trim();
        if fen.is_empty() || fen.contains('\n') || fen.contains('\r') {
            return Err("invalid FEN".to_string());
        }

        let mut io = self.io.lock().await;
        write_line(&mut io.stdin, &format!("position fen {fen}")).await?;
        write_line(&mut io.stdin, "go nodes 1").await?;

        let mut moves = Vec::new();
        let mut value = None;
        let mut line = String::new();
        loop {
            line.clear();
            let n = io
                .reader
                .read_line(&mut line)
                .await
                .map_err(|e| format!("lc0 read error: {e}"))?;
            if n == 0 {
                return Err("lc0 exited during query".to_string());
            }
            let t = line.trim();
            if t.starts_with("bestmove") {
                break;
            }
            if let Some(body) = t.strip_prefix("info string ") {
                parse_verbose_line(body, &mut moves, &mut value);
            }
        }

        if moves.is_empty() {
            return Err("lc0 returned no policy (position may be terminal)".to_string());
        }
        Ok(MaiaPolicy {
            band: self.band,
            moves,
            value,
        })
    }
}

async fn write_line(stdin: &mut ChildStdin, cmd: &str) -> Result<(), String> {
    stdin
        .write_all(cmd.as_bytes())
        .await
        .map_err(|e| format!("lc0 write error: {e}"))?;
    stdin
        .write_all(b"\n")
        .await
        .map_err(|e| format!("lc0 write error: {e}"))?;
    stdin
        .flush()
        .await
        .map_err(|e| format!("lc0 flush error: {e}"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Process pool (Tauri-managed state)
// ---------------------------------------------------------------------------

#[derive(Default)]
struct Pool {
    procs: HashMap<u32, Arc<MaiaProcess>>,
    /// LRU order, most-recently-used last.
    order: Vec<u32>,
}

impl Pool {
    fn touch(&mut self, band: u32) {
        self.order.retain(|b| *b != band);
        self.order.push(band);
    }
}

#[derive(Default)]
pub struct MaiaState {
    pool: AsyncMutex<Pool>,
}

impl MaiaState {
    async fn get_or_spawn(
        &self,
        band: u32,
        lc0: &Path,
        weights: &Path,
    ) -> Result<Arc<MaiaProcess>, String> {
        let mut pool = self.pool.lock().await;
        if let Some(p) = pool.procs.get(&band).cloned() {
            pool.touch(band);
            return Ok(p);
        }
        let proc = Arc::new(MaiaProcess::spawn(lc0, weights, band).await?);
        pool.procs.insert(band, proc.clone());
        pool.touch(band);
        // Evict least-recently-used beyond the cap. Dropping the Arc kills the
        // process (kill_on_drop) once any in-flight query releases its clone.
        while pool.order.len() > POOL_CAP {
            let evicted = pool.order.remove(0);
            pool.procs.remove(&evicted);
        }
        Ok(proc)
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

fn maia_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("maia");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Report lc0 availability and which band weights are already cached. The UI
/// uses this to hide the feature (no lc0) or to show a first-use download hint.
#[tauri::command]
pub async fn maia_status(app: tauri::AppHandle) -> Result<MaiaStatus, String> {
    let lc0 = resolve_lc0();
    let cached_bands = match maia_dir(&app) {
        Ok(dir) => BANDS
            .iter()
            .copied()
            .filter(|b| dir.join(weights_filename(*b)).exists())
            .collect(),
        Err(_) => Vec::new(),
    };
    Ok(MaiaStatus {
        lc0_available: lc0.is_some(),
        lc0_path: lc0.map(|p| p.display().to_string()),
        bands: BANDS.to_vec(),
        cached_bands,
    })
}

/// Resolve lc0, ensure the band's weights, warm its process, and read the root
/// policy for `fen`. The shared core behind the `maia_policy` command and the
/// persona `maia_move` sampler (spec 214) so both take the exact same path into
/// the pool. Errors are strings so callers can degrade without crashing.
pub async fn query_policy(
    app: &tauri::AppHandle,
    state: &MaiaState,
    fen: &str,
    band: u32,
) -> Result<MaiaPolicy, String> {
    if !is_valid_band(band) {
        return Err(format!(
            "no Maia-1 net for band {band} (available: 1100–1900)"
        ));
    }
    let lc0 = resolve_lc0().ok_or("lc0 not found — install it with: brew install lc0")?;
    let dir = maia_dir(app)?;
    let weights = ensure_weights(band, &dir).await?;
    let proc = state.get_or_spawn(band, &lc0, &weights).await?;
    proc.query(fen).await
}

/// Root policy for `fen` at rating `band`: `Vec<(uci, prob)>` plus the value
/// head. Spawns/warms the band's lc0 process and downloads its weights on first
/// use. Errors (no lc0, download failure, terminal position) are returned as
/// strings so the caller can degrade without crashing the analysis flow.
#[tauri::command]
pub async fn maia_policy(
    app: tauri::AppHandle,
    state: State<'_, MaiaState>,
    fen: String,
    band: u32,
) -> Result<MaiaPolicy, String> {
    query_policy(&app, state.inner(), &fen, band).await
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    const STARTPOS: &str = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

    // Real VerboseMoveStats output captured from lc0 0.31.2 + maia-1500 on the
    // start position (2026-07-14). Abridged; enough to exercise the parser.
    const SAMPLE: &[&str] = &[
        "info string b1a3  (34  ) N:       0 (+ 0) (P:  0.04%) (WL:  -.-----) (D: -.---) (M:  -.-) (Q:  0.04017) (U: 0.00075) (S:  0.04092) (V:  -.----) ",
        "info string d2d4  (293 ) N:       0 (+ 0) (P: 23.34%) (WL:  -.-----) (D: -.---) (M:  -.-) (Q:  0.04017) (U: 0.40730) (S:  0.44747) (V:  -.----) ",
        "info string e2e4  (322 ) N:       0 (+ 0) (P: 50.22%) (WL:  -.-----) (D: -.---) (M:  -.-) (Q:  0.04017) (U: 0.87639) (S:  0.91655) (V:  -.----) ",
        "info string g1f3  (159 ) N:       0 (+ 0) (P:  4.35%) (WL:  -.-----) (D: -.---) (M:  -.-) (Q:  0.04017) (U: 0.07597) (S:  0.11614) (V:  -.----) ",
        "info string node  (  20) N:       1 (+ 0) (P:  0.00%) (WL:  0.03821) (D: 0.038) (M:  0.0) (Q:  0.03821) (V:  0.0402) ",
    ];

    #[test]
    fn parses_moves_and_value_from_verbose_stats() {
        let policy = parse_policy(1500, SAMPLE);
        assert_eq!(policy.band, 1500);
        // 4 legal moves in the sample; the `node` summary is not a move.
        assert_eq!(policy.moves.len(), 4);

        let mass = |uci: &str| {
            policy
                .moves
                .iter()
                .find(|m| m.uci == uci)
                .map(|m| m.prob)
                .unwrap_or(0.0)
        };
        assert!((mass("e2e4") - 0.5022).abs() < 1e-4);
        assert!((mass("d2d4") - 0.2334).abs() < 1e-4);
        // Value head captured from the node line's Q.
        assert!((policy.value.unwrap() - 0.03821).abs() < 1e-6);
    }

    #[test]
    fn rejects_non_uci_and_missing_bands() {
        assert!(is_uci_move("e2e4"));
        assert!(is_uci_move("e7e8q"));
        assert!(!is_uci_move("node"));
        assert!(!is_uci_move("e2e9"));
        assert!(is_valid_band(1500));
        assert!(!is_valid_band(2100));
        assert!(!is_valid_band(1550));
    }

    #[test]
    fn paren_field_extracts_numbers() {
        let line = "e2e4 (322 ) (P: 50.22%) (Q:  -0.12345)";
        assert!((paren_field(line, "P:").unwrap() - 50.22).abs() < 1e-9);
        assert!((paren_field(line, "Q:").unwrap() + 0.12345).abs() < 1e-9);
        assert!(paren_field(line, "Z:").is_none());
    }

    #[tokio::test]
    async fn weight_manager_downloads_verifies_and_caches() {
        // A fixture "net": gzip magic + payload. Its own digest is the expected
        // checksum, so no network and no dependence on the real assets.
        let fixture: Vec<u8> = {
            let mut v = vec![0x1f, 0x8b];
            v.extend_from_slice(b"fixture maia weights payload");
            v
        };
        let digest = {
            use sha2::{Digest, Sha256};
            let mut h = Sha256::new();
            h.update(&fixture);
            hex::encode(h.finalize())
        };

        let dir = std::env::temp_dir().join(format!("maia-wm-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);

        // First call downloads (fetch invoked once) and writes the file.
        let calls = std::sync::atomic::AtomicUsize::new(0);
        let fetch = |_url: String| {
            calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let bytes = fixture.clone();
            async move { Ok(bytes) }
        };
        let path = ensure_weights_with(1500, &dir, Some(&digest), fetch)
            .await
            .expect("first ensure_weights should succeed");
        assert!(path.exists());
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);

        // Second call is served from cache — fetch must NOT be invoked again.
        let fetch2 = |_url: String| async move {
            Err::<Vec<u8>, String>("network must not be hit on cache hit".to_string())
        };
        let path2 = ensure_weights_with(1500, &dir, Some(&digest), fetch2)
            .await
            .expect("cached ensure_weights should succeed");
        assert_eq!(path, path2);

        // A checksum mismatch is rejected.
        let bad = ensure_weights_with(1600, &dir, Some(&digest), |_url: String| async move {
            Ok(vec![0x1f, 0x8b, 0x00]) // valid gzip magic, wrong digest
        })
        .await;
        assert!(bad.is_err(), "checksum mismatch should error");

        // Non-gzip bytes are rejected.
        let not_gz = ensure_weights_with(1700, &dir, None, |_url: String| async move {
            Ok(b"not a gzip".to_vec())
        })
        .await;
        assert!(not_gz.is_err(), "non-gzip should error");

        let _ = std::fs::remove_dir_all(&dir);
    }

    // Real lc0 + real weights. Skips gracefully (prints and returns) when lc0 is
    // absent or the net can't be fetched, so `cargo test` stays green offline.
    // Weights are cached under target/ so the download happens at most once.
    #[tokio::test]
    async fn real_lc0_startpos_policy_band_1500() {
        let Some(lc0) = resolve_lc0() else {
            eprintln!("SKIP real_lc0: lc0 not installed");
            return;
        };
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("maia-test-cache");
        let weights = match ensure_weights(1500, &dir).await {
            Ok(p) => p,
            Err(e) => {
                eprintln!("SKIP real_lc0: could not obtain weights ({e})");
                return;
            }
        };

        let proc = MaiaProcess::spawn(&lc0, &weights, 1500)
            .await
            .expect("spawn lc0 with maia-1500");

        let t0 = std::time::Instant::now();
        let policy = proc.query(STARTPOS).await.expect("policy query");
        let warm = {
            let t1 = std::time::Instant::now();
            let _ = proc.query(STARTPOS).await.expect("warm policy query");
            t1.elapsed()
        };
        eprintln!(
            "real_lc0: cold {:?}, warm {:?}, {} moves",
            t0.elapsed(),
            warm,
            policy.moves.len()
        );

        // Distribution over legal moves, summing to ~1.
        assert!(policy.moves.len() >= 20, "startpos has 20 legal moves");
        let sum: f64 = policy.moves.iter().map(|m| m.prob).sum();
        assert!((sum - 1.0).abs() < 0.02, "policy should sum to ~1, got {sum}");

        // e2e4/d2d4 are the prominent human first moves at 1500.
        let mass = |uci: &str| {
            policy
                .moves
                .iter()
                .find(|m| m.uci == uci)
                .map(|m| m.prob)
                .unwrap_or(0.0)
        };
        assert!(
            mass("e2e4") > 0.15 || mass("d2d4") > 0.15,
            "expected e2e4/d2d4 prominent, got e4={} d4={}",
            mass("e2e4"),
            mass("d2d4")
        );
    }
}
