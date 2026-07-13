//! Screenshot → FEN via the Anthropic API (Claude Sonnet vision).
//!
//! The frontend sends a base64-encoded image of a chessboard; we ask the
//! model for the FEN and return its raw text answer. FEN extraction and
//! validation happen on the frontend (chessops).

use serde_json::json;

/// Resolve the Anthropic API key: environment first, then the ai-dev-framework
/// .env on this machine. The key is read at call time and never stored.
fn anthropic_api_key() -> Result<String, String> {
    if let Ok(k) = std::env::var("ANTHROPIC_API_KEY") {
        let k = k.trim().to_string();
        if !k.is_empty() {
            return Ok(k);
        }
    }
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    let env_path = format!("{home}/github/ai-dev-framework/.env");
    let content = std::fs::read_to_string(&env_path).map_err(|e| {
        format!("ANTHROPIC_API_KEY not in environment and couldn't read {env_path}: {e}")
    })?;
    for line in content.lines() {
        if let Some(v) = line.strip_prefix("ANTHROPIC_API_KEY=") {
            let v = v.trim().trim_matches('"').trim_matches('\'');
            if !v.is_empty() {
                return Ok(v.to_string());
            }
        }
    }
    Err(format!("ANTHROPIC_API_KEY not found in {env_path}"))
}

const PROMPT: &str = "This image is a screenshot of a chess position on a 2D board. Transcribe it exactly.\n\
Important: do NOT assume a standard starting arrangement — the position may be mid-game \
or Chess960, with pieces on unusual squares. Read each square individually.\n\
Step 1 — ranks: work rank by rank from rank 8 down to rank 1, using the board coordinates \
if visible (otherwise assume white plays up the board). For each rank, list files a through \
h — empty, or the exact piece and color you SEE on that square.\n\
Step 2 — cross-check: now read the board again column by column (file a from rank 8 down to \
rank 1, then file b, and so on). Where the column reading disagrees with your rank reading, \
look at that square again carefully and correct it.\n\
Step 3 — turn: if a last move is highlighted, use it to decide whose turn it is; otherwise \
assume white to move.\n\
Finish your reply with a single last line in exactly this form:\n\
FEN: <piece placement> <w or b> - - 0 1";

#[tauri::command]
pub async fn recognize_fen(
    image_base64: String,
    media_type: String,
    prompt: Option<String>,
) -> Result<String, String> {
    let key = anthropic_api_key()?;
    let prompt_text = prompt.unwrap_or_else(|| PROMPT.to_string());
    let body = json!({
        // Opus reads boards far more reliably than smaller models — a
        // misrecognized position is worthless, so pay the ~4¢.
        "model": "claude-opus-4-8",
        "max_tokens": 8000,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "image", "source": {"type": "base64", "media_type": media_type, "data": image_base64}},
                {"type": "text", "text": prompt_text}
            ]
        }]
    });

    let client = reqwest::Client::new();
    let resp = client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Anthropic request failed: {e}"))?;

    let status = resp.status();
    let v: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Bad response from Anthropic API: {e}"))?;

    if !status.is_success() {
        let msg = v["error"]["message"].as_str().unwrap_or("unknown error");
        return Err(format!("Anthropic API {status}: {msg}"));
    }
    if v["stop_reason"] == "refusal" {
        return Err("The model declined to read this image".to_string());
    }

    let text = v["content"]
        .as_array()
        .and_then(|blocks| {
            blocks
                .iter()
                .find(|b| b["type"] == "text")
                .and_then(|b| b["text"].as_str())
        })
        .ok_or("No text in model response")?;

    Ok(text.trim().to_string())
}
