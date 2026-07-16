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

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::Manager;
use tokio::time::timeout;

// Default engine: resolved per-OS by engine_path (sidecar → PATH → macOS
// Homebrew), spec 222 — the old /opt/homebrew constant lives there now.

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

/// One engine's speed measurement on this machine (spec 216 Tier 2
/// "per-engine curves": Reckless and Stockfish differ in nps AND in `b(t)`,
/// so each gets its own entry). Every field has a serde default so a
/// partially-written entry — e.g. `fit_curve.py` landing a curve for an
/// engine before it has been benched here — still parses.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct EngineSpeed {
    #[serde(default)]
    pub engine_path: String,
    #[serde(default)]
    pub nps: u64,
    #[serde(default)]
    pub threads: usize,
    /// ISO-8601 UTC timestamp of this engine's bench.
    #[serde(default)]
    pub measured_at: String,
    /// This engine's measured `b(t)` curve, or null while the prior applies.
    #[serde(default)]
    pub curve: Option<serde_json::Value>,
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
    /// Fingerprint of the hardware the bench ran on (see
    /// `hardware_fingerprint`). Empty on profiles that predate fingerprinting;
    /// `machine_profile_get` stamps those in place. A mismatch against the live
    /// machine means the nps (and any measured curve) describe different
    /// silicon, so the frontend auto re-benches (spec 216 Tier 2).
    #[serde(default)]
    pub hw_fingerprint: String,
    /// Measured `b(t)` speed→Elo curve, or null while the literature prior is in
    /// effect. Filled by the Tier-1 ladder; opaque here (`serde_json::Value`) so
    /// this Tier-0 code needn't know the fitted shape.
    pub curve: Option<serde_json::Value>,
    /// Per-engine measurements keyed by engine `id name` (spec 216 Tier 2
    /// "per-engine curves"). The top-level engine_name/nps/curve stay the
    /// most recent bench for legacy consumers; this map keeps every engine's
    /// figures side by side. Empty on profiles that predate it —
    /// `machine_profile_get` seeds it from the top-level fields.
    #[serde(default)]
    pub engines: BTreeMap<String, EngineSpeed>,
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
        crate::engine_path::engine_command(path)
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

/// The stored profile, or None if the file doesn't exist yet.
fn read_profile(file: &PathBuf) -> Result<Option<MachineProfile>, String> {
    match std::fs::read_to_string(file) {
        Ok(text) => serde_json::from_str(&text)
            .map(Some)
            .map_err(|e| format!("parsing {file:?}: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("reading {file:?}: {e}")),
    }
}

fn write_profile(file: &PathBuf, profile: &MachineProfile) -> Result<(), String> {
    let json = serde_json::to_string_pretty(profile).map_err(|e| e.to_string())?;
    std::fs::write(file, json).map_err(|e| format!("writing {file:?}: {e}"))
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

/// One `sysctl -n <key>` value (macOS) — same shell-out idiom as `hostname()`.
#[cfg(target_os = "macos")]
fn sysctl(key: &str) -> Option<String> {
    std::process::Command::new("sysctl")
        .args(["-n", key])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// CPU model and total physical memory, the two hardware facts (besides core
/// count) that make bench numbers comparable.
#[cfg(target_os = "macos")]
fn cpu_and_memory() -> (String, String) {
    (
        sysctl("machdep.cpu.brand_string").unwrap_or_else(|| "unknown-cpu".to_string()),
        sysctl("hw.memsize").unwrap_or_else(|| "0".to_string()),
    )
}

/// Linux (the other place this app runs): `/proc/cpuinfo` "model name" and
/// `/proc/meminfo` "MemTotal".
#[cfg(not(target_os = "macos"))]
fn cpu_and_memory() -> (String, String) {
    fn field(path: &str, label: &str) -> Option<String> {
        std::fs::read_to_string(path).ok().and_then(|text| {
            text.lines()
                .find(|l| l.starts_with(label))
                .and_then(|l| l.split_once(':').map(|(_, v)| v.trim().to_string()))
                .filter(|s| !s.is_empty())
        })
    }
    (
        field("/proc/cpuinfo", "model name").unwrap_or_else(|| "unknown-cpu".to_string()),
        field("/proc/meminfo", "MemTotal").unwrap_or_else(|| "0".to_string()),
    )
}

/// The live hardware fingerprint: CPU model, logical core count, physical
/// memory. Hostname is deliberately excluded — it changes with the network,
/// not the silicon — and the format is opaque to callers, who only ever
/// compare fingerprints for equality.
fn hardware_fingerprint() -> String {
    let cores = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(0);
    let (cpu, mem) = cpu_and_memory();
    format!("{cpu} | {cores} cores | {mem}")
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

/// Fold a fresh bench into the previous profile (pure, so it's testable).
/// Measured curves — top-level and per-engine — survive only while the old
/// profile still describes this hardware: a same-fingerprint re-bench keeps
/// MEASURED (and the other engines' entries), a hardware change drops the
/// whole per-engine map, since every stored nps/curve is a fact about the
/// old silicon (spec 216 Tier 2). The benched engine's entry is upserted;
/// its own curve is kept from the previous entry (a bench remeasures speed,
/// not the ladder's b(t)).
fn merge_bench(
    prev: Option<MachineProfile>,
    bench: &BenchResult,
    path: &str,
    fingerprint: &str,
    hostname: String,
    measured_at: String,
) -> MachineProfile {
    let same_hw = prev
        .as_ref()
        .is_some_and(|p| !p.hw_fingerprint.is_empty() && p.hw_fingerprint == fingerprint);
    let (curve, mut engines) = match prev {
        Some(p) if same_hw => (p.curve, p.engines),
        _ => (None, BTreeMap::new()),
    };

    let engine_curve = engines
        .get(&bench.engine_name)
        .and_then(|e| e.curve.clone());
    engines.insert(
        bench.engine_name.clone(),
        EngineSpeed {
            engine_path: path.to_string(),
            nps: bench.nps,
            threads: bench.threads,
            measured_at: measured_at.clone(),
            curve: engine_curve,
        },
    );

    MachineProfile {
        hostname,
        engine_name: bench.engine_name.clone(),
        engine_path: path.to_string(),
        nps: bench.nps,
        threads: bench.threads,
        measured_at,
        hw_fingerprint: fingerprint.to_string(),
        curve,
        engines,
    }
}

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
        .unwrap_or_else(crate::engine_path::resolve_default_engine_path);

    let bench = run_bench(&path).await?;
    let file = profile_path(&app)?;

    let prev = read_profile(&file).ok().flatten();
    let profile = merge_bench(
        prev,
        &bench,
        &path,
        &hardware_fingerprint(),
        hostname(),
        now_iso(),
    );

    write_profile(&file, &profile)?;

    Ok(bench)
}

/// The top-level fields are one engine's figures; seed/backfill that engine's
/// per-engine map entry so per-engine consumers (spec 216 Tier 2) see the same
/// measurement. Covers both pre-map profiles (no entry at all) and curve-only
/// entries fit_curve.py landed before a bench filled in nps. Returns true when
/// the profile changed (caller persists it).
fn seed_engine_entry(profile: &mut MachineProfile) -> bool {
    if profile.nps == 0 {
        return false;
    }
    let engine_name = profile.engine_name.clone();
    let entry = profile.engines.entry(engine_name).or_default();
    if entry.nps != 0 {
        return false;
    }
    entry.engine_path = profile.engine_path.clone();
    entry.nps = profile.nps;
    entry.threads = profile.threads;
    entry.measured_at = profile.measured_at.clone();
    if entry.curve.is_none() {
        entry.curve = profile.curve.clone();
    }
    true
}

/// The stored machine profile, or null if none has been measured yet.
#[tauri::command]
pub fn machine_profile_get(app: tauri::AppHandle) -> Result<Option<MachineProfile>, String> {
    let file = profile_path(&app)?;
    let mut profile = match read_profile(&file)? {
        Some(p) => p,
        None => return Ok(None),
    };
    let mut dirty = false;
    // Profiles that predate fingerprinting were measured on this machine, so
    // stamp the current fingerprint in place instead of forcing a re-bench
    // that would wipe a measured curve back to PRIOR.
    if profile.hw_fingerprint.is_empty() {
        profile.hw_fingerprint = hardware_fingerprint();
        dirty = true;
    }
    if seed_engine_entry(&mut profile) {
        dirty = true;
    }
    if dirty {
        write_profile(&file, &profile)?;
    }
    Ok(Some(profile))
}

/// The live hardware fingerprint, for comparing against the stored profile's
/// `hw_fingerprint`. Opaque — callers only test equality.
#[tauri::command]
pub fn machine_fingerprint() -> String {
    hardware_fingerprint()
}

// ---------------------------------------------------------------------------
// Imported remote profiles (spec 216 Tier 2 — cross-machine equivalence)
// ---------------------------------------------------------------------------
//
// Other machines' profiles (the homeserver's, dad's PC per spec:000) are the
// same `machine_profile.json` documents this module writes, carried over by
// hand and imported here. They live one-per-hostname under
// `<app_data_dir>/machine_profiles/` — separate from this machine's own
// profile, which stays the single `machine_profile.json` the bench owns.

/// `<app_data_dir>/machine_profiles/`, creating it if absent.
fn profiles_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("machine_profiles");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// A hostname reduced to a safe filename stem: alphanumerics, `-`, `_`, `.`
/// pass through; everything else becomes `_`. Never empty (falls back to
/// "unnamed"), never a dotfile.
fn hostname_filename(hostname: &str) -> String {
    let stem: String = hostname
        .trim()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '_' })
        .collect();
    let stem = stem.trim_matches('.').to_string();
    if stem.is_empty() {
        "unnamed".to_string()
    } else {
        stem
    }
}

/// Gate on an imported profile: it must carry the two facts equivalence needs
/// (a hostname to label it and a positive nps to compare with), and it must
/// not be THIS machine wearing a different hostname — same silicon means the
/// bench, not an import, is the honest source.
fn validate_import(profile: &MachineProfile, live_fingerprint: &str) -> Result<(), String> {
    if profile.hostname.trim().is_empty() {
        return Err("profile has no hostname".to_string());
    }
    if profile.nps == 0 {
        return Err("profile has no nps — bench that machine first".to_string());
    }
    if !profile.hw_fingerprint.is_empty() && profile.hw_fingerprint == live_fingerprint {
        return Err(
            "that profile was measured on THIS machine — use \"Bench this machine\" instead"
                .to_string(),
        );
    }
    Ok(())
}

/// Import another machine's profile JSON (the `machine_profile.json` that
/// machine's own bench wrote). Validates, then persists it under
/// `machine_profiles/<hostname>.json` — re-importing the same hostname
/// replaces the previous copy. Returns the parsed profile.
#[tauri::command]
pub fn machine_profile_import(
    app: tauri::AppHandle,
    json: String,
) -> Result<MachineProfile, String> {
    let profile: MachineProfile =
        serde_json::from_str(&json).map_err(|e| format!("not a machine profile: {e}"))?;
    validate_import(&profile, &hardware_fingerprint())?;
    let file = profiles_dir(&app)?.join(format!("{}.json", hostname_filename(&profile.hostname)));
    write_profile(&file, &profile)?;
    Ok(profile)
}

/// All imported remote profiles, sorted by hostname. Files that no longer
/// parse are skipped (one corrupt import must not hide the rest), as is
/// anything that isn't a `.json` file.
#[tauri::command]
pub fn machine_profiles_list(app: tauri::AppHandle) -> Result<Vec<MachineProfile>, String> {
    let dir = profiles_dir(&app)?;
    let entries = std::fs::read_dir(&dir).map_err(|e| format!("reading {dir:?}: {e}"))?;
    let mut profiles: Vec<MachineProfile> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|ext| ext == "json"))
        .filter_map(|p| read_profile(&p).ok().flatten())
        .collect();
    profiles.sort_by(|a, b| a.hostname.cmp(&b.hostname));
    Ok(profiles)
}

/// Remove an imported profile by hostname. Removing one that isn't there is
/// a no-op, so a stale UI row can't error its way into being permanent.
#[tauri::command]
pub fn machine_profile_remove(app: tauri::AppHandle, hostname: String) -> Result<(), String> {
    let file = profiles_dir(&app)?.join(format!("{}.json", hostname_filename(&hostname)));
    match std::fs::remove_file(&file) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("removing {file:?}: {e}")),
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

    /// The fingerprint is a stable, non-degenerate fact about this machine —
    /// two reads agree, and at least the core count resolved.
    #[test]
    fn hardware_fingerprint_is_stable() {
        let fp = hardware_fingerprint();
        assert_eq!(fp, hardware_fingerprint());
        assert!(!fp.starts_with("unknown-cpu | 0 cores"), "fingerprint fully degenerate: {fp}");
    }

    fn sample_profile() -> MachineProfile {
        MachineProfile {
            hostname: "homeserver".to_string(),
            engine_name: "Stockfish 17".to_string(),
            engine_path: "/usr/bin/stockfish".to_string(),
            nps: 4_000_000,
            threads: 1,
            measured_at: "2026-07-15T00:00:00Z".to_string(),
            hw_fingerprint: "AMD Ryzen | 16 cores | 32G".to_string(),
            curve: None,
            engines: BTreeMap::new(),
        }
    }

    /// A healthy remote profile passes; the three gates each reject.
    #[test]
    fn validate_import_gates() {
        let live = hardware_fingerprint();
        assert!(validate_import(&sample_profile(), &live).is_ok());

        let mut no_host = sample_profile();
        no_host.hostname = "  ".to_string();
        assert!(validate_import(&no_host, &live).unwrap_err().contains("hostname"));

        let mut no_nps = sample_profile();
        no_nps.nps = 0;
        assert!(validate_import(&no_nps, &live).unwrap_err().contains("nps"));

        // Same fingerprint as the live machine = it IS this machine.
        let mut same_hw = sample_profile();
        same_hw.hw_fingerprint = live.clone();
        assert!(validate_import(&same_hw, &live).unwrap_err().contains("THIS machine"));

        // A legacy profile without a fingerprint can't be identity-checked;
        // it imports (the nps is still a usable fact).
        let mut legacy = sample_profile();
        legacy.hw_fingerprint = String::new();
        assert!(validate_import(&legacy, &live).is_ok());
    }

    /// Hostnames become safe filename stems; degenerate ones don't vanish.
    #[test]
    fn hostname_filename_sanitizes() {
        assert_eq!(hostname_filename("homeserver"), "homeserver");
        assert_eq!(hostname_filename("Mac.localdomain"), "Mac.localdomain");
        assert_eq!(hostname_filename("dad's PC/#1"), "dad_s_PC__1");
        assert_eq!(hostname_filename("  "), "unnamed");
        assert_eq!(hostname_filename("..."), "unnamed");
    }

    /// A profile written before fingerprinting (no `hw_fingerprint` key) still
    /// parses — serde default gives the empty string that marks it for stamping.
    /// Same for the per-engine map (spec 216 Tier 2): absent = empty, and
    /// `machine_profile_get` seeds it from the top-level fields.
    #[test]
    fn legacy_profile_parses_without_fingerprint() {
        let legacy = r#"{
            "hostname": "old-mac",
            "engine_name": "Stockfish 16.1",
            "engine_path": "/opt/homebrew/bin/stockfish",
            "nps": 1853879,
            "threads": 1,
            "measured_at": "2026-07-14T22:13:20Z",
            "curve": null
        }"#;
        let profile: MachineProfile = serde_json::from_str(legacy).unwrap();
        assert_eq!(profile.hw_fingerprint, "");
        assert!(profile.engines.is_empty());
    }

    /// A per-engine entry written by fit_curve.py before that engine was
    /// benched (curve only, no nps) still parses via the field defaults.
    #[test]
    fn partial_engine_entry_parses() {
        let entry: EngineSpeed =
            serde_json::from_str(r#"{"curve": {"source": "measured", "b": 70}}"#).unwrap();
        assert_eq!(entry.nps, 0);
        assert!(entry.curve.is_some());
    }

    fn bench_result(engine_name: &str, nps: u64) -> BenchResult {
        BenchResult {
            nps,
            threads: 1,
            engine_name: engine_name.to_string(),
            duration_ms: 1000,
        }
    }

    fn merge(prev: Option<MachineProfile>, bench: &BenchResult, fp: &str) -> MachineProfile {
        merge_bench(
            prev,
            bench,
            "/tmp/engine",
            fp,
            "test-host".to_string(),
            "2026-07-15T12:00:00Z".to_string(),
        )
    }

    /// Benching a second engine adds its entry beside the first and keeps
    /// both curves; the top-level fields track the newest bench.
    #[test]
    fn merge_bench_keeps_other_engines_on_same_hw() {
        let fp = "fp-A";
        let sf_curve = serde_json::json!({"source": "measured", "b": 70});
        let mut prev = sample_profile();
        prev.hw_fingerprint = fp.to_string();
        prev.curve = Some(sf_curve.clone());
        prev.engines.insert(
            "Stockfish 17".to_string(),
            EngineSpeed {
                engine_path: "/usr/bin/stockfish".to_string(),
                nps: 4_000_000,
                threads: 1,
                measured_at: "2026-07-15T00:00:00Z".to_string(),
                curve: Some(sf_curve.clone()),
            },
        );

        let merged = merge(Some(prev), &bench_result("Reckless 0.9", 2_000_000), fp);
        assert_eq!(merged.engine_name, "Reckless 0.9");
        assert_eq!(merged.nps, 2_000_000);
        assert_eq!(merged.curve, Some(sf_curve.clone())); // top-level survives
        assert_eq!(merged.engines.len(), 2);
        assert_eq!(merged.engines["Stockfish 17"].curve, Some(sf_curve));
        assert!(merged.engines["Reckless 0.9"].curve.is_none());
    }

    /// Re-benching the SAME engine on the same hardware refreshes its nps but
    /// keeps its ladder-measured curve.
    #[test]
    fn merge_bench_rebench_keeps_engine_curve() {
        let fp = "fp-A";
        let curve = serde_json::json!({"source": "measured", "b": 70});
        let mut prev = sample_profile();
        prev.hw_fingerprint = fp.to_string();
        prev.engines.insert(
            "Stockfish 17".to_string(),
            EngineSpeed {
                curve: Some(curve.clone()),
                ..EngineSpeed::default()
            },
        );

        let merged = merge(Some(prev), &bench_result("Stockfish 17", 5_000_000), fp);
        assert_eq!(merged.engines["Stockfish 17"].nps, 5_000_000);
        assert_eq!(merged.engines["Stockfish 17"].curve, Some(curve));
    }

    /// Legacy profiles (no per-engine map) get their top-level figures seeded
    /// into an entry; a curve-only entry (fit_curve.py before a bench) gets
    /// the speed fields backfilled but keeps its own curve; a complete entry
    /// is left alone.
    #[test]
    fn seed_engine_entry_backfills() {
        // Legacy: no entry at all -> full seed, including the top-level curve.
        let mut legacy = sample_profile();
        legacy.curve = Some(serde_json::json!({"source": "measured", "b": 70}));
        assert!(seed_engine_entry(&mut legacy));
        let entry = &legacy.engines["Stockfish 17"];
        assert_eq!(entry.nps, 4_000_000);
        assert_eq!(entry.curve, legacy.curve);
        // Second call: nothing left to do.
        assert!(!seed_engine_entry(&mut legacy));

        // Curve-only entry: speed fields backfill, its own curve wins.
        let own_curve = serde_json::json!({"source": "measured", "b": 50});
        let mut partial = sample_profile();
        partial.engines.insert(
            "Stockfish 17".to_string(),
            EngineSpeed {
                curve: Some(own_curve.clone()),
                ..EngineSpeed::default()
            },
        );
        assert!(seed_engine_entry(&mut partial));
        let entry = &partial.engines["Stockfish 17"];
        assert_eq!(entry.nps, 4_000_000);
        assert_eq!(entry.curve, Some(own_curve));

        // Never-benched machine (nps 0): no seeding.
        let mut unbenched = sample_profile();
        unbenched.nps = 0;
        assert!(!seed_engine_entry(&mut unbenched));
        assert!(unbenched.engines.is_empty());
    }

    /// A hardware change invalidates every stored nps and curve: the whole
    /// per-engine map (and the top-level curve) reset — back to PRIOR until
    /// the ladder reruns on the new silicon.
    #[test]
    fn merge_bench_hw_change_drops_curves_and_engines() {
        let curve = serde_json::json!({"source": "measured", "b": 70});
        let mut prev = sample_profile();
        prev.hw_fingerprint = "fp-OLD".to_string();
        prev.curve = Some(curve.clone());
        prev.engines.insert(
            "Stockfish 17".to_string(),
            EngineSpeed {
                curve: Some(curve),
                ..EngineSpeed::default()
            },
        );

        let merged = merge(Some(prev), &bench_result("Stockfish 17", 3_000_000), "fp-NEW");
        assert!(merged.curve.is_none());
        assert_eq!(merged.engines.len(), 1);
        assert!(merged.engines["Stockfish 17"].curve.is_none());
        assert_eq!(merged.hw_fingerprint, "fp-NEW");
    }
}
