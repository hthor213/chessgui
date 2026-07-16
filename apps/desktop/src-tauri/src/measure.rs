//! Spec 215 Tier 2: the in-app monthly measurement run.
//!
//! Spawns scripts/measure_monthly.py (fetch → engage → analyze → maia →
//! stats) as a child process and streams every output line to the Training
//! tab through an ipc Channel — the progress surface the earlier
//! import-only step was honestly waiting for. The script keeps owning all
//! pipeline logic and writes data/rivals/training_metrics.json; on success
//! this module hands that file's text back so the frontend merges it through
//! the exact same parse/merge path as the manual "Import measurements…"
//! button.
//!
//! Dev-checkout feature: the script and data/rivals live in the repo
//! (resolved from compile-time CARGO_MANIFEST_DIR), never in the app bundle.
//! A bundled app on another machine gets an honest "script not found" error
//! instead of a silent no-op.

use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::ipc::Channel;
use tokio::io::{AsyncBufReadExt, BufReader};

/// pid of the in-flight run — also its process-group id (`process_group(0)`
/// below), so cancel can kill the whole pipeline: the orchestrator python AND
/// whichever stage child (fetch/analyze/lc0) is running. Module-local so
/// lib.rs needs no `.manage()` line; one run at a time by design (the
/// pipeline hammers network + lc0 — two would corrupt the shared work dir).
/// `Some(0)` is the claim placeholder before the child reports a real pid.
static RUNNING: Mutex<Option<u32>> = Mutex::new(None);

/// One output line from the pipeline, stream-tagged (the script announces its
/// stages on stderr as `$ <cmd>` lines — lib/training-measure.ts maps those
/// to human stage labels).
#[derive(Clone, Serialize)]
pub struct MeasureLine {
    /// "stdout" | "stderr"
    pub stream: &'static str,
    pub line: String,
}

/// Final report of a run.
#[derive(Debug, Serialize)]
pub struct MeasureReport {
    /// Process exit code; None means killed by a signal (i.e. cancelled).
    pub exit_code: Option<i32>,
    pub cancelled: bool,
    /// data/rivals/training_metrics.json text after a successful run; the
    /// frontend imports it via the existing parse/merge path. None on
    /// failure, cancellation, or an unreadable file.
    pub metrics_json: Option<String>,
}

/// Repo root: src-tauri → apps/desktop → apps → checkout root.
/// (pub(crate): player_profile.rs runs its pipeline from the same root.)
pub(crate) fn repo_root() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..")
}

/// Homebrew python first — the numpy/python-chess install lives there, and a
/// GUI app's launchd PATH may resolve `python3` to the bare CLT shim — then
/// whatever PATH offers.
pub(crate) fn python_path() -> String {
    for p in ["/opt/homebrew/bin/python3", "/usr/local/bin/python3"] {
        if std::path::Path::new(p).exists() {
            return p.to_string();
        }
    }
    "python3".to_string()
}

/// Spawn `program script args…`, stream both pipes line-by-line into
/// `on_line`, park the child's pid in `slot` (for the cancel command), and on
/// a zero exit read `metrics_file` back. Killed-by-signal is reported as
/// `cancelled`, not an error — the frontend says "cancelled", nothing red.
/// (pub(crate): player_profile.rs reuses this verbatim with its own slot and
/// result file — one pipeline runner, two script wrappers.)
pub(crate) async fn run_pipeline(
    program: &str,
    script: &std::path::Path,
    args: &[String],
    metrics_file: &std::path::Path,
    slot: &Mutex<Option<u32>>,
    on_line: impl Fn(MeasureLine) + Send + Sync + 'static,
) -> Result<MeasureReport, String> {
    let mut cmd = tokio::process::Command::new(program);
    cmd.arg(script)
        .args(args)
        // Python block-buffers stdout when piped — without this, a script
        // narrating on stdout (build_player_profile.py) would dump its whole
        // log at exit instead of streaming it live.
        .env("PYTHONUNBUFFERED", "1")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    // Own process group: the stage children (fetch/analyze/lc0) join it, so
    // one negative-pid SIGTERM in measure_monthly_cancel stops everything —
    // killing only the orchestrator would leave a running lc0 behind.
    #[cfg(unix)]
    cmd.process_group(0);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start {}: {}", program, e))?;
    if let (Ok(mut s), Some(pid)) = (slot.lock(), child.id()) {
        *s = Some(pid);
    }

    let stdout = child.stdout.take().ok_or("No stdout pipe")?;
    let stderr = child.stderr.take().ok_or("No stderr pipe")?;
    let on_line = Arc::new(on_line);

    let cb = on_line.clone();
    let stdout_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            cb(MeasureLine { stream: "stdout", line });
        }
    });
    // stderr (the script's progress narration) drains on this task.
    let mut lines = BufReader::new(stderr).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        on_line(MeasureLine { stream: "stderr", line });
    }

    let status = child
        .wait()
        .await
        .map_err(|e| format!("Wait failed: {}", e))?;
    let _ = stdout_task.await;

    let exit_code = status.code();
    let metrics_json = if status.success() {
        std::fs::read_to_string(metrics_file).ok()
    } else {
        None
    };
    Ok(MeasureReport {
        exit_code,
        cancelled: exit_code.is_none(),
        metrics_json,
    })
}

/// Run the monthly measurement pipeline for `user`, streaming output lines
/// over `on_line`. Resolves with the final report when the pipeline exits;
/// errors are strings the UI shows verbatim (script missing, already
/// running, spawn failure).
#[tauri::command]
pub async fn measure_monthly_run(
    user: String,
    skip_fetch: bool,
    skip_maia: bool,
    on_line: Channel<MeasureLine>,
) -> Result<MeasureReport, String> {
    let user = user.trim().to_string();
    if user.is_empty() {
        return Err("Enter the chess.com username to measure.".to_string());
    }
    let root = repo_root();
    let script = root.join("scripts").join("measure_monthly.py");
    if !script.exists() {
        return Err(format!(
            "measure_monthly.py not found at {} — the monthly pipeline runs from the dev checkout only (it is never bundled).",
            script.display()
        ));
    }

    // Claim the single run slot (placeholder 0 until the child reports a pid).
    {
        let mut slot = RUNNING.lock().map_err(|e| e.to_string())?;
        if slot.is_some() {
            return Err("A measurement run is already in progress.".to_string());
        }
        *slot = Some(0);
    }

    let mut args = vec!["--user".to_string(), user];
    if skip_fetch {
        args.push("--skip-fetch".to_string());
    }
    if skip_maia {
        args.push("--skip-maia".to_string());
    }
    let metrics_file = root.join("data").join("rivals").join("training_metrics.json");

    let result = run_pipeline(
        &python_path(),
        &script,
        &args,
        &metrics_file,
        &RUNNING,
        move |l| {
            let _ = on_line.send(l);
        },
    )
    .await;

    if let Ok(mut slot) = RUNNING.lock() {
        *slot = None;
    }
    result
}

/// Cancel the in-flight run by SIGTERMing its process group (negative pid —
/// takes the current stage child down with the orchestrator). Ok(false) when
/// nothing is running. The run command itself resolves with cancelled=true
/// once the child is reaped.
#[tauri::command]
pub async fn measure_monthly_cancel() -> Result<bool, String> {
    cancel_slot(&RUNNING)
}

/// SIGTERM the process group parked in `slot` (shared with
/// player_profile.rs's cancel command — same claim/kill semantics).
pub(crate) fn cancel_slot(slot: &Mutex<Option<u32>>) -> Result<bool, String> {
    let pid = *slot.lock().map_err(|e| e.to_string())?;
    match pid {
        None => Ok(false),
        // Placeholder claim: pid unknown yet, and `kill -- -0` would signal
        // OUR OWN process group — refuse rather than self-terminate.
        Some(0) => Err("The run is still starting — try again in a moment.".to_string()),
        Some(pid) => {
            #[cfg(unix)]
            {
                let status = std::process::Command::new("kill")
                    .args(["-TERM", "--", &format!("-{pid}")])
                    .status()
                    .map_err(|e| format!("kill failed: {}", e))?;
                Ok(status.success())
            }
            #[cfg(not(unix))]
            {
                let _ = pid;
                Err("Cancelling the pipeline is not supported on this platform.".to_string())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("measure-test-{}-{}", tag, std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn collector() -> (Arc<Mutex<Vec<(&'static str, String)>>>, impl Fn(MeasureLine) + Send + Sync + 'static) {
        let lines: Arc<Mutex<Vec<(&'static str, String)>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = lines.clone();
        (lines, move |l: MeasureLine| sink.lock().unwrap().push((l.stream, l.line)))
    }

    #[tokio::test]
    async fn streams_both_pipes_and_reads_metrics_on_success() {
        let dir = temp_dir("ok");
        let script = dir.join("fake.sh");
        std::fs::write(&script, "echo out1\necho '$ self_maia.py rapid' 1>&2\n").unwrap();
        let metrics = dir.join("metrics.json");
        std::fs::write(&metrics, r#"{"points":[]}"#).unwrap();

        let slot = Mutex::new(None);
        let (lines, on_line) = collector();
        let report = run_pipeline("/bin/sh", &script, &[], &metrics, &slot, on_line)
            .await
            .unwrap();

        assert_eq!(report.exit_code, Some(0));
        assert!(!report.cancelled);
        assert_eq!(report.metrics_json.as_deref(), Some(r#"{"points":[]}"#));
        let got = lines.lock().unwrap();
        assert!(got.iter().any(|(s, l)| *s == "stdout" && l == "out1"));
        assert!(got.iter().any(|(s, l)| *s == "stderr" && l.contains("self_maia.py")));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn nonzero_exit_reports_code_without_metrics() {
        let dir = temp_dir("fail");
        let script = dir.join("fail.sh");
        std::fs::write(&script, "echo boom 1>&2\nexit 3\n").unwrap();
        let metrics = dir.join("metrics.json");
        std::fs::write(&metrics, r#"{"points":[]}"#).unwrap();

        let slot = Mutex::new(None);
        let (lines, on_line) = collector();
        let report = run_pipeline("/bin/sh", &script, &[], &metrics, &slot, on_line)
            .await
            .unwrap();

        assert_eq!(report.exit_code, Some(3));
        assert!(!report.cancelled);
        assert!(report.metrics_json.is_none(), "failed run must not hand back stale metrics");
        assert!(lines.lock().unwrap().iter().any(|(s, l)| *s == "stderr" && l == "boom"));
        std::fs::remove_dir_all(&dir).ok();
    }
}
