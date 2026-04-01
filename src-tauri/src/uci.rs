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

#[derive(Serialize, Deserialize)]
pub struct EngineInfo {
    pub name: String,
    pub ready: bool,
}

/// Start a UCI engine process at the given binary path.
#[tauri::command]
pub async fn start_engine(
    path: String,
    app: tauri::AppHandle,
    state: State<'_, Mutex<EngineState>>,
) -> Result<EngineInfo, String> {
    let mut child = Command::new(&path)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
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
    let (tx, mut rx) = mpsc::channel::<String>(32);
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
    state: State<'_, Mutex<EngineState>>,
) -> Result<(), String> {
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
