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
    let env_path = format!("{home}/Documents/GitHub/ai-dev-framework/.env");
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

const PROMPT: &str = "This image is a screenshot of a chess position on a 2D board. \
Read the position and respond with ONLY a FEN string on a single line — no explanation, \
no code fences. Rules: assume white to move unless the image clearly indicates otherwise; \
grant castling rights only for kings and rooks standing on their standard home squares; \
use '-' for en passant and '0 1' for the move counters. Orientation: use the board \
coordinates if visible; otherwise assume the white pieces are at the bottom.";

#[tauri::command]
pub async fn recognize_fen(image_base64: String, media_type: String) -> Result<String, String> {
    let key = anthropic_api_key()?;
    let body = json!({
        "model": "claude-sonnet-5",
        "max_tokens": 2000,
        "output_config": {"effort": "low"},
        "messages": [{
            "role": "user",
            "content": [
                {"type": "image", "source": {"type": "base64", "media_type": media_type, "data": image_base64}},
                {"type": "text", "text": PROMPT}
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
