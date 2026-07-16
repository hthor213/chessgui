use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{Emitter, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Child;
use tokio::sync::mpsc;

use crate::engine_path::engine_command;

/// One running analysis engine process. Spec 900 multi-engine comparison
/// runs two of these side by side, keyed by session id — the main analysis
/// engine is the `default` session (untagged callers), the comparison panel
/// uses its own id, and each session's stdout is emitted on its own event.
struct EngineSession {
    child: Option<Child>,
    stdin_tx: Option<mpsc::Sender<String>>,
}

impl EngineSession {
    /// Synchronous best-effort teardown (see `EngineState::shutdown`).
    fn shutdown(&mut self) {
        self.stdin_tx.take();
        if let Some(mut child) = self.child.take() {
            let _ = child.start_kill();
        }
    }
}

/// UCI engine state managed by Tauri: every live session, keyed by id.
#[derive(Default)]
pub struct EngineState {
    sessions: HashMap<String, EngineSession>,
}

impl EngineState {
    /// Synchronous best-effort teardown of EVERY session for app exit
    /// (spec 011 "Engine process cleaned up on app quit"). Dropping a
    /// session's `stdin_tx` closes the writer task's channel, which closes
    /// the engine's stdin (a well-behaved UCI engine exits on EOF);
    /// `start_kill` then makes sure of it without needing an async context —
    /// the exit handler runs on the main thread, outside a runtime.
    /// `kill_on_drop` on the spawn is the last-resort backstop.
    pub fn shutdown(&mut self) {
        for (_, mut session) in self.sessions.drain() {
            session.shutdown();
        }
    }
}

/// The untagged callers' session (pre-900 single-engine behavior) and its
/// pre-900 event name, kept verbatim so existing listeners stay untouched.
const DEFAULT_SESSION: &str = "default";

/// Resolve the optional frontend session id to a map key, refusing ids that
/// could break out of the per-session event name (Tauri event names only
/// allow alphanumeric + `-` `/` `:` `_`). Mirrored by
/// core/engine-session.ts `isValidEngineSessionId` — keep the rule in sync.
fn session_key(session: Option<&str>) -> Result<String, String> {
    match session {
        None => Ok(DEFAULT_SESSION.to_string()),
        Some("") => Ok(DEFAULT_SESSION.to_string()),
        Some(s)
            if s.len() <= 64
                && s.chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') =>
        {
            Ok(s.to_string())
        }
        Some(s) => Err(format!("Invalid engine session id: {s:?}")),
    }
}

/// Per-session stdout event: the default session keeps the historical
/// `engine-output` name; any other session gets `engine-output:<id>`.
/// Mirrored by core/engine-session.ts `engineOutputEvent`.
fn output_event(session_key: &str) -> String {
    if session_key == DEFAULT_SESSION {
        "engine-output".to_string()
    } else {
        format!("engine-output:{session_key}")
    }
}

#[derive(Serialize, Deserialize)]
pub struct EngineInfo {
    pub name: String,
    pub ready: bool,
}

/// Spec 219 B, layer 2: the defensive engine lockout for active chess.com
/// daily games. Engine commands carry a game-context tag (computed by
/// core/active-game.ts `engineContextTag` — keep the prefix rule in sync
/// with its `isLockedEngineContext`); anything tagged as an active-game
/// context is refused here regardless of what the frontend gate did. An
/// absent tag means an unrestricted caller (engine lab, tournaments, tests):
/// the per-game scoping lives in the use-engine hook, this layer is the
/// guarantee that a tagged request can never reach the engine.
const ACTIVE_GAME_CONTEXT_PREFIX: &str = "active-game";

pub fn context_is_locked(context: Option<&str>) -> bool {
    matches!(context, Some(tag) if tag.starts_with(ACTIVE_GAME_CONTEXT_PREFIX))
}

const ENGINE_LOCKED_ERROR: &str =
    "Engine refused: this game is flagged as an active chess.com daily game (fair play lockout, spec 219)";

/// Start a UCI engine process at the given binary path. `session` (spec 900)
/// selects which engine slot to start — absent means the default session.
#[tauri::command]
pub async fn start_engine(
    path: String,
    context: Option<String>,
    session: Option<String>,
    app: tauri::AppHandle,
    state: State<'_, Mutex<EngineState>>,
) -> Result<EngineInfo, String> {
    if context_is_locked(context.as_deref()) {
        return Err(ENGINE_LOCKED_ERROR.to_string());
    }
    // Validate the session id BEFORE spawning anything.
    let key = session_key(session.as_deref())?;
    let event = output_event(&key);
    // engine_command sets CREATE_NO_WINDOW on Windows (spec 222 quirks
    // ledger: no console flash per engine start). Line handling below is
    // \r\n-tolerant by construction — every read_line result goes through
    // trim(), which strips the \r a Windows engine build emits.
    let mut child = engine_command(&path)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("Failed to start engine: {}", e))?;

    let stdout = child.stdout.take().ok_or("No stdout")?;
    let mut stdin = child.stdin.take().ok_or("No stdin")?;

    // Send UCI init
    stdin
        .write_all(b"uci\n")
        .await
        .map_err(|e| format!("Write error: {}", e))?;
    stdin.flush().await.map_err(|e| format!("Flush error: {}", e))?;

    // Read output until "uciok"
    let mut reader = BufReader::new(stdout);
    let mut engine_name = String::from("Unknown Engine");

    loop {
        let mut line = String::new();
        let bytes = reader
            .read_line(&mut line)
            .await
            .map_err(|e| format!("Read error: {}", e))?;

        if bytes == 0 {
            return Err("Engine closed unexpectedly".to_string());
        }

        let trimmed = line.trim();
        if trimmed.starts_with("id name ") {
            engine_name = trimmed.strip_prefix("id name ").unwrap().to_string();
        }
        if trimmed == "uciok" {
            break;
        }
    }

    // Send isready
    stdin
        .write_all(b"isready\n")
        .await
        .map_err(|e| format!("Write error: {}", e))?;
    stdin.flush().await.map_err(|e| format!("Flush error: {}", e))?;

    loop {
        let mut line = String::new();
        reader
            .read_line(&mut line)
            .await
            .map_err(|e| format!("Read error: {}", e))?;
        if line.trim() == "readyok" {
            break;
        }
    }

    // Spawn a background task to forward engine stdout to frontend events
    let app_clone = app.clone();
    let reader_key = key.clone();
    let reader_event = event.clone();
    tokio::spawn(async move {
        eprintln!("[uci:{reader_key}] stdout reader started");
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line).await {
                Ok(0) => {
                    eprintln!("[uci:{reader_key}] stdout EOF");
                    break;
                }
                Ok(_) => {
                    let trimmed = line.trim().to_string();
                    eprintln!("[uci:{reader_key}] << {}", trimmed);
                    // emit_to targets the main webview directly
                    if let Err(e) = app_clone.emit_to("main", &reader_event, trimmed) {
                        eprintln!("[uci:{reader_key}] emit error: {}", e);
                    }
                }
                Err(e) => {
                    eprintln!("[uci:{reader_key}] stdout error: {}", e);
                    break;
                }
            }
        }
    });

    // Channel for sending commands to engine stdin
    let (tx, mut rx) = mpsc::channel::<String>(128);
    let writer_key = key.clone();
    tokio::spawn(async move {
        eprintln!("[uci:{writer_key}] stdin writer started");
        while let Some(cmd) = rx.recv().await {
            eprintln!("[uci:{writer_key}] >> {}", cmd);
            if let Err(e) = stdin.write_all(cmd.as_bytes()).await {
                eprintln!("[uci:{writer_key}] stdin write error: {}", e);
                break;
            }
            if let Err(e) = stdin.write_all(b"\n").await {
                eprintln!("[uci:{writer_key}] stdin newline error: {}", e);
                break;
            }
            if let Err(e) = stdin.flush().await {
                eprintln!("[uci:{writer_key}] stdin flush error: {}", e);
                break;
            }
        }
        eprintln!("[uci:{writer_key}] stdin writer exited");
    });

    // Store in managed state; a start-over-running on the same session kills
    // the old process explicitly (start_kill; kill_on_drop is the backstop).
    {
        let mut guard = state.lock().map_err(|e| e.to_string())?;
        if let Some(mut old) = guard.sessions.insert(
            key,
            EngineSession {
                child: Some(child),
                stdin_tx: Some(tx),
            },
        ) {
            old.shutdown();
        }
    }

    Ok(EngineInfo {
        name: engine_name,
        ready: true,
    })
}

/// Send a raw UCI command to the running engine of the given session.
#[tauri::command]
pub async fn send_command(
    command: String,
    context: Option<String>,
    session: Option<String>,
    state: State<'_, Mutex<EngineState>>,
) -> Result<(), String> {
    // Checked per command, not just at start: an engine started by an
    // unrestricted context must still refuse commands tagged for an active
    // game (spec 219 B "any evaluation request is refused").
    if context_is_locked(context.as_deref()) {
        return Err(ENGINE_LOCKED_ERROR.to_string());
    }
    let key = session_key(session.as_deref())?;
    let tx = {
        let guard = state.lock().map_err(|e| e.to_string())?;
        guard
            .sessions
            .get(&key)
            .and_then(|s| s.stdin_tx.as_ref())
            .ok_or_else(|| "No engine running".to_string())?
            .clone()
    };
    tx.send(command)
        .await
        .map_err(|e| format!("Send error: {}", e))?;
    Ok(())
}

/// Stop the running engine of the given session (others keep running).
#[tauri::command]
pub async fn stop_engine(
    session: Option<String>,
    state: State<'_, Mutex<EngineState>>,
) -> Result<(), String> {
    let key = session_key(session.as_deref())?;
    let removed = {
        let mut guard = state.lock().map_err(|e| e.to_string())?;
        guard.sessions.remove(&key)
    };
    if let Some(mut sess) = removed {
        if let Some(tx) = sess.stdin_tx.take() {
            let _ = tx.send("quit".to_string()).await;
        }
        if let Some(mut child) = sess.child.take() {
            let _ = child.kill().await;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::process::Command;

    // Spec 219 B: the defensive refusal keys on the active-game tag prefix.
    // The tag values mirror core/active-game.ts engineContextTag.
    #[test]
    fn active_game_contexts_are_locked() {
        assert!(context_is_locked(Some("active-game")));
        assert!(context_is_locked(Some("active-game:unknown")));
        assert!(context_is_locked(Some(
            "active-game:https://www.chess.com/game/daily/123456"
        )));
    }

    #[test]
    fn unrestricted_and_untagged_contexts_are_allowed() {
        // The frontend's tag for puzzles/training/spar/lab and normal games.
        assert!(!context_is_locked(Some("unrestricted")));
        // Untagged = legacy/internal callers (tournament runner, tests):
        // their scoping gate is the use-engine hook, not this layer.
        assert!(!context_is_locked(None));
        assert!(!context_is_locked(Some("")));
        // The prefix must be a prefix, not a substring match.
        assert!(!context_is_locked(Some("not-an-active-game")));
    }

    // Spec 900 session plumbing: absent/empty ids resolve to the default
    // session; explicit ids pass through; anything that couldn't be embedded
    // in a Tauri event name is refused.
    #[test]
    fn session_key_resolves_default_and_explicit_ids() {
        assert_eq!(session_key(None).unwrap(), DEFAULT_SESSION);
        assert_eq!(session_key(Some("")).unwrap(), DEFAULT_SESSION);
        assert_eq!(session_key(Some("compare")).unwrap(), "compare");
        assert_eq!(session_key(Some("engine_2")).unwrap(), "engine_2");
        assert_eq!(session_key(Some("a-b-3")).unwrap(), "a-b-3");
    }

    #[test]
    fn session_key_refuses_ids_unsafe_for_event_names() {
        assert!(session_key(Some("has space")).is_err());
        assert!(session_key(Some("semi;colon")).is_err());
        assert!(session_key(Some("colon:inside")).is_err());
        assert!(session_key(Some(&"x".repeat(65))).is_err());
    }

    // The default session must keep the pre-900 event name verbatim so
    // existing listeners (use-engine's default subscription) stay untouched.
    #[test]
    fn output_event_names_are_per_session() {
        assert_eq!(output_event(DEFAULT_SESSION), "engine-output");
        assert_eq!(output_event("compare"), "engine-output:compare");
    }

    fn sleeper_session() -> (u32, EngineSession) {
        let child = Command::new("/bin/sleep")
            .arg("30")
            .kill_on_drop(true)
            .spawn()
            .expect("spawn sleep");
        let pid = child.id().expect("pid");
        (
            pid,
            EngineSession {
                child: Some(child),
                stdin_tx: None,
            },
        )
    }

    // The exit-handler path: every spawned child in EngineState — across ALL
    // sessions (spec 900) — must be dead after shutdown(). Uses /bin/sleep
    // as a stand-in engine process.
    #[tokio::test]
    async fn shutdown_kills_children_of_all_sessions() {
        let (pid_a, session_a) = sleeper_session();
        let (pid_b, session_b) = sleeper_session();
        let mut state = EngineState::default();
        state.sessions.insert(DEFAULT_SESSION.to_string(), session_a);
        state.sessions.insert("compare".to_string(), session_b);
        state.shutdown();
        assert!(state.sessions.is_empty());
        // start_kill sends SIGKILL immediately; give the OS a moment to reap.
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        // kill(pid, 0) probes existence: ESRCH (Err) once the process is gone.
        for pid in [pid_a, pid_b] {
            let alive = unsafe { libc_kill_probe(pid as i32) };
            assert!(!alive, "engine child (pid {pid}) still alive after shutdown");
        }
    }

    // Minimal existence probe without adding a libc dependency: signal 0.
    unsafe fn libc_kill_probe(pid: i32) -> bool {
        extern "C" {
            fn kill(pid: i32, sig: i32) -> i32;
        }
        kill(pid, 0) == 0
    }
}
