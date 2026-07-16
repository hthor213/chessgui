use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{Emitter, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::mpsc;

/// UCI engine state managed by Tauri
pub struct EngineState {
    child: Option<Child>,
    stdin_tx: Option<mpsc::Sender<String>>,
}

impl Default for EngineState {
    fn default() -> Self {
        Self {
            child: None,
            stdin_tx: None,
        }
    }
}

impl EngineState {
    /// Synchronous best-effort teardown for app exit (spec 011 "Engine process
    /// cleaned up on app quit"). Dropping `stdin_tx` closes the writer task's
    /// channel, which closes the engine's stdin (a well-behaved UCI engine
    /// exits on EOF); `start_kill` then makes sure of it without needing an
    /// async context — the exit handler runs on the main thread, outside a
    /// runtime. `kill_on_drop` on the spawn is the last-resort backstop.
    pub fn shutdown(&mut self) {
        self.stdin_tx.take();
        if let Some(mut child) = self.child.take() {
            let _ = child.start_kill();
        }
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

/// Start a UCI engine process at the given binary path.
#[tauri::command]
pub async fn start_engine(
    path: String,
    context: Option<String>,
    app: tauri::AppHandle,
    state: State<'_, Mutex<EngineState>>,
) -> Result<EngineInfo, String> {
    if context_is_locked(context.as_deref()) {
        return Err(ENGINE_LOCKED_ERROR.to_string());
    }
    let mut child = Command::new(&path)
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
    tokio::spawn(async move {
        eprintln!("[uci] stdout reader started");
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line).await {
                Ok(0) => {
                    eprintln!("[uci] stdout EOF");
                    break;
                }
                Ok(_) => {
                    let trimmed = line.trim().to_string();
                    eprintln!("[uci] << {}", trimmed);
                    // emit_to targets the main webview directly
                    if let Err(e) = app_clone.emit_to("main", "engine-output", trimmed) {
                        eprintln!("[uci] emit error: {}", e);
                    }
                }
                Err(e) => {
                    eprintln!("[uci] stdout error: {}", e);
                    break;
                }
            }
        }
    });

    // Channel for sending commands to engine stdin
    let (tx, mut rx) = mpsc::channel::<String>(128);
    tokio::spawn(async move {
        eprintln!("[uci] stdin writer started");
        while let Some(cmd) = rx.recv().await {
            eprintln!("[uci] >> {}", cmd);
            if let Err(e) = stdin.write_all(cmd.as_bytes()).await {
                eprintln!("[uci] stdin write error: {}", e);
                break;
            }
            if let Err(e) = stdin.write_all(b"\n").await {
                eprintln!("[uci] stdin newline error: {}", e);
                break;
            }
            if let Err(e) = stdin.flush().await {
                eprintln!("[uci] stdin flush error: {}", e);
                break;
            }
        }
        eprintln!("[uci] stdin writer exited");
    });

    // Store in managed state
    {
        let mut guard = state.lock().map_err(|e| e.to_string())?;
        guard.child = Some(child);
        guard.stdin_tx = Some(tx);
    }

    Ok(EngineInfo {
        name: engine_name,
        ready: true,
    })
}

/// Send a raw UCI command to the running engine.
#[tauri::command]
pub async fn send_command(
    command: String,
    context: Option<String>,
    state: State<'_, Mutex<EngineState>>,
) -> Result<(), String> {
    // Checked per command, not just at start: an engine started by an
    // unrestricted context must still refuse commands tagged for an active
    // game (spec 219 B "any evaluation request is refused").
    if context_is_locked(context.as_deref()) {
        return Err(ENGINE_LOCKED_ERROR.to_string());
    }
    let tx = {
        let guard = state.lock().map_err(|e| e.to_string())?;
        guard
            .stdin_tx
            .as_ref()
            .ok_or_else(|| "No engine running".to_string())?
            .clone()
    };
    tx.send(command)
        .await
        .map_err(|e| format!("Send error: {}", e))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

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

    // The exit-handler path: a spawned child put into EngineState must be dead
    // after shutdown(). Uses /bin/sleep as a stand-in engine process.
    #[tokio::test]
    async fn shutdown_kills_child() {
        let child = Command::new("/bin/sleep")
            .arg("30")
            .kill_on_drop(true)
            .spawn()
            .expect("spawn sleep");
        let pid = child.id().expect("pid");
        let mut state = EngineState {
            child: Some(child),
            stdin_tx: None,
        };
        state.shutdown();
        assert!(state.child.is_none() && state.stdin_tx.is_none());
        // start_kill sends SIGKILL immediately; give the OS a moment to reap.
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        // kill(pid, 0) probes existence: ESRCH (Err) once the process is gone.
        let alive = unsafe { libc_kill_probe(pid as i32) };
        assert!(!alive, "engine child (pid {pid}) still alive after shutdown");
    }

    // Minimal existence probe without adding a libc dependency: signal 0.
    unsafe fn libc_kill_probe(pid: i32) -> bool {
        extern "C" {
            fn kill(pid: i32, sig: i32) -> i32;
        }
        kill(pid, 0) == 0
    }
}

/// Stop the running engine.
#[tauri::command]
pub async fn stop_engine(state: State<'_, Mutex<EngineState>>) -> Result<(), String> {
    let (tx, child) = {
        let mut guard = state.lock().map_err(|e| e.to_string())?;
        (guard.stdin_tx.take(), guard.child.take())
    };
    if let Some(tx) = tx {
        let _ = tx.send("quit".to_string()).await;
    }
    if let Some(mut child) = child {
        let _ = child.kill().await;
    }
    Ok(())
}
