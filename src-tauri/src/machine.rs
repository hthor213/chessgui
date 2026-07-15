//! Machine speed profile (spec 216, Tier 0).
//!
//! Answer "how fast is the engine on *this* machine?" once and record it, so the
//! time-compression Elo model (216) can turn a search budget on this box into an
//! honest strength label. We never weaken the engine — we *characterize* the
//! machine: run the engine's built-in `bench` and capture nodes/second. The
//! profile is a local fact about a local machine (the laptop and the homeserver
//! each keep their own), stored in `<app_data_dir>/machine_profile.json`. A null
//! `curve` means the literature prior is still in effect; the Tier-1 time-odds
//! ladder overwrites it once it has measured `b(t)` here.

use std::path::PathBuf;
use std::process::Stdio;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::Manager;
use tokio::process::Command;
use tokio::time::timeout;

/// Default Stockfish binary (Homebrew, Apple Silicon), matching the rest of the app.
const DEFAULT_STOCKFISH: &str = "/opt/homebrew/bin/stockfish";

/// Upper bound on one bench run. Stockfish's default bench is a few seconds on
/// modern hardware; 120s leaves generous headroom for a slow box.
const BENCH_TIMEOUT: Duration = Duration::from_secs(120);

/// Threads the bench runs with. Plain `<engine> bench` uses the engine default
/// (single-threaded), which is more stable and reproducible than a multi-thread
/// figure — noted in the stored profile.
const BENCH_THREADS: usize = 1;

/// The bench measurement returned to the caller. Persisted (minus `duration_ms`)
/// as part of the machine profile.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BenchResult {
    /// Nodes/second from the engine's own bench summary.
    pub nps: u64,
    /// Threads the bench ran with (see `BENCH_THREADS`).
    pub threads: usize,
    /// Engine `id name` (e.g. "Stockfish 16.1").
    pub engine_name: String,
    /// Wall-clock the bench subprocess took, milliseconds.
    pub duration_ms: u64,
}

/// The persisted per-machine profile.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MachineProfile {
    pub hostname: String,
    pub engine_name: String,
    pub engine_path: String,
    pub nps: u64,
    pub threads: usize,
    /// ISO-8601 UTC timestamp of the measurement.
    pub measured_at: String,
    /// Measured `b(t)` speed→Elo curve, or null while the literature prior is in
    /// effect. Filled by the Tier-1 ladder; opaque here (`serde_json::Value`) so
    /// this Tier-0 code needn't know the fitted shape.
    pub curve: Option<serde_json::Value>,
}

/// `Nodes/second` from an engine `bench` summary. Scans every line for the field
/// (Stockfish prints it to stderr at the end of each run) and returns the last
/// one, so a multi-run bench yields its final figure. Whitespace- and
/// case-tolerant around the `Nodes/second : <n>` label.
fn parse_nps(output: &str) -> Option<u64> {
    let mut last = None;
    for line in output.lines() {
        let lower = line.to_ascii_lowercase();
        if let Some((_, rest)) = lower.split_once("nodes/second") {
            let after = rest.trim_start_matches(|c: char| c == ':' || c.is_whitespace());
            let digits: String = after.chars().take_while(|c| c.is_ascii_digit()).collect();
            if let Ok(n) = digits.parse::<u64>() {
                last = Some(n);
            }
        }
    }
    last
}

/// Run `<engine> bench`, capturing both stdout and stderr (the summary lands on
/// stderr), and parse out nodes/second. The engine name comes from a quick UCI
/// handshake so it matches what the rest of the app reports.
async fn run_bench(path: &str) -> Result<BenchResult, String> {
    let engine_name = crate::match_runner::engine_id(path.to_string())
        .await
        .unwrap_or_else(|_| "Unknown Engine".to_string());

    let started = Instant::now();
    let output = timeout(
        BENCH_TIMEOUT,
        Command::new(path)
            .arg("bench")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| format!("bench timed out after {}s", BENCH_TIMEOUT.as_secs()))?
    .map_err(|e| format!("failed to run '{path} bench': {e}"))?;
    let duration_ms = started.elapsed().as_millis() as u64;

    let mut combined = String::from_utf8_lossy(&output.stdout).into_owned();
    combined.push('\n');
    combined.push_str(&String::from_utf8_lossy(&output.stderr));

    let nps = parse_nps(&combined)
        .ok_or_else(|| "no 'Nodes/second' line in bench output".to_string())?;

    Ok(BenchResult {
        nps,
        threads: BENCH_THREADS,
        engine_name,
        duration_ms,
    })
}

/// `<app_data_dir>/machine_profile.json`, creating the dir if absent.
fn profile_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("machine_profile.json"))
}

/// This machine's hostname. Shells out to `hostname` — present on macOS and
/// Linux, the two places this app runs — rather than pull a crate for one
/// string; falls back to "unknown" if it isn't available.
fn hostname() -> String {
    std::process::Command::new("hostname")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "unknown".to_string())
}

/// ISO-8601 UTC timestamp ("2026-07-14T22:13:20Z") for `secs` since the Unix
/// epoch, computed by hand (Howard Hinnant's civil-from-days algorithm) to avoid
/// a date-crate dependency — the codebase hand-rolls its time helpers.
fn iso_from_secs(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (hh, mm, ss) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}Z")
}

/// ISO-8601 UTC timestamp for now.
fn now_iso() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    iso_from_secs(secs)
}

// ---------------------------------------------------------------------------
// Tauri command layer
// ---------------------------------------------------------------------------

/// Benchmark the engine on this machine, persist a fresh machine profile to
/// `<app_data_dir>/machine_profile.json`, and return the bench result. The new
/// profile starts with `curve: null` (literature prior in effect).
#[tauri::command]
pub async fn machine_bench(
    app: tauri::AppHandle,
    engine_path: Option<String>,
) -> Result<BenchResult, String> {
    let path = engine_path
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_STOCKFISH.to_string());

    let bench = run_bench(&path).await?;

    let profile = MachineProfile {
        hostname: hostname(),
        engine_name: bench.engine_name.clone(),
        engine_path: path,
        nps: bench.nps,
        threads: bench.threads,
        measured_at: now_iso(),
        curve: None,
    };

    let file = profile_path(&app)?;
    let json = serde_json::to_string_pretty(&profile).map_err(|e| e.to_string())?;
    std::fs::write(&file, json).map_err(|e| format!("writing {file:?}: {e}"))?;

    Ok(bench)
}

/// The stored machine profile, or null if none has been measured yet.
#[tauri::command]
pub fn machine_profile_get(app: tauri::AppHandle) -> Result<Option<MachineProfile>, String> {
    let file = profile_path(&app)?;
    match std::fs::read_to_string(&file) {
        Ok(text) => serde_json::from_str(&text)
            .map(Some)
            .map_err(|e| format!("parsing {file:?}: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("reading {file:?}: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The canned tail of a Stockfish `bench` summary.
    #[test]
    fn parse_nps_reads_the_summary() {
        let tail = "\
===========================
Total time (ms) : 2518
Nodes searched  : 4667079
Nodes/second    : 1853879
";
        assert_eq!(parse_nps(tail), Some(1_853_879));
    }

    #[test]
    fn parse_nps_tolerates_spacing_and_case() {
        assert_eq!(parse_nps("Nodes/second: 42"), Some(42));
        assert_eq!(parse_nps("nodes/second   :   1000"), Some(1000));
    }

    /// A multi-run bench prints the field once per summary; keep the final one.
    #[test]
    fn parse_nps_takes_the_last_figure() {
        let out = "Nodes/second    : 100\n(more work)\nNodes/second    : 200\n";
        assert_eq!(parse_nps(out), Some(200));
    }

    #[test]
    fn parse_nps_none_when_absent() {
        assert_eq!(parse_nps("no summary here\nbestmove e2e4\n"), None);
    }

    /// A known epoch second maps to its ISO-8601 UTC string.
    #[test]
    fn iso_from_known_epoch() {
        assert_eq!(iso_from_secs(1_700_000_000), "2023-11-14T22:13:20Z");
        assert_eq!(iso_from_secs(0), "1970-01-01T00:00:00Z");
    }
}
