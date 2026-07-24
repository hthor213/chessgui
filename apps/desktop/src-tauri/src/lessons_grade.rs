//! OPTIONAL assist-grading for Concept Lessons free-text (spec 227 D6).
//!
//! A LATER-TIER, OFF-BY-DEFAULT convenience: when the user has explicitly turned
//! on lesson assist-grading, the module player can send a student's typed prose
//! (with the study question's OWN revealed model answer + rubric, already baked
//! into `prompt` by the pure core builder `buildAssistPrompt`) to Claude and get
//! back a short graded note. The self-grade control remains the source of truth;
//! this only pre-selects a tier the user can override.
//!
//! This command is a DELIBERATELY THIN passthrough — it reuses the existing AI
//! plumbing (`vision::anthropic_api_key` + `coach::call_api`) and does not invent
//! new infra. The prompt is built and the reply parsed in pure, unit-tested TS
//! core (`packages/core/src/lesson-assist.ts`), so this Rust side just moves the
//! text: prompt in, assistant text out. Errors are returned as strings so the UI
//! degrades to a one-line hint and the lesson still completes via self-grade.
//!
//! Fair-play (spec 227 D5): the `prompt` carries only the study question's model
//! answer/rubric and the user's prose — never a live FEN, never engine/game
//! state — so this stays on the study surface. Model is `claude-opus-4-8`
//! (accuracy over cost; do not downgrade).

use serde_json::json;

use crate::coach::call_api;
use crate::vision::anthropic_api_key;

/// Model for assist grading. Keep Opus — accuracy over cost for AI features.
const MODEL: &str = "claude-opus-4-8";

/// Anchors the grader's role. The strict VERDICT:/FEEDBACK: output contract that
/// the TS parser reads back lives in the caller-supplied `prompt` (built by
/// `buildAssistPrompt`), so this system text stays minimal and general.
const SYSTEM: &str = "You are a chess study coach grading a student's written answer against a \
provided model answer and rubric. Judge only how well their prose matches the model answer and \
the rubric points — never invent board facts or bring in outside analysis. Follow the exact reply \
format the user's message asks for.";

// ---------------------------------------------------------------------------
// Request building + response parsing (pure — unit-tested without the network)
// ---------------------------------------------------------------------------

/// Build the Anthropic Messages API request body. Plain-text reply (no tool
/// call): the caller's `prompt` already specifies the VERDICT:/FEEDBACK: format,
/// and the TS parser tolerates a malformed reply, so a forced tool call buys
/// nothing here. No temperature/thinking params (would 400 on Opus 4.8).
fn build_request(prompt: &str) -> serde_json::Value {
    json!({
        "model": MODEL,
        "max_tokens": 512,
        "system": SYSTEM,
        "messages": [{ "role": "user", "content": prompt }]
    })
}

/// Extract the assistant's plain text from a response body. A refusal or an
/// empty reply is an error string (the UI degrades to a hint).
fn parse_text_response(v: &serde_json::Value) -> Result<String, String> {
    if v["stop_reason"] == "refusal" {
        return Err("The model declined to grade this answer".to_string());
    }
    let blocks = v["content"].as_array().ok_or("No content in model response")?;
    let text = blocks
        .iter()
        .find(|b| b["type"] == "text")
        .and_then(|b| b["text"].as_str())
        .ok_or("No text in model response")?;
    let text = text.trim();
    if text.is_empty() {
        return Err("Empty reply from model".to_string());
    }
    Ok(text.to_string())
}

// ---------------------------------------------------------------------------
// Tauri command
// ---------------------------------------------------------------------------

/// Grade one free-text lesson answer. `prompt` is the fully-assembled grader
/// prompt from the pure core builder; the resolved assistant text is returned
/// verbatim for the core parser to turn into `{tier, feedback}`. Errors
/// (including "no API key") are returned as strings so the caller can show a
/// one-line "assist unavailable" hint and leave self-grade fully functional.
#[tauri::command]
pub async fn grade_free_text(prompt: String) -> Result<String, String> {
    let key = anthropic_api_key()?;
    let v = call_api(&key, build_request(&prompt)).await?;
    parse_text_response(&v)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_is_plain_text_on_opus_and_carries_the_prompt() {
        let req = build_request("VERDICT contract... the student wrote: e4 e5");
        assert_eq!(req["model"], "claude-opus-4-8");
        // Conversational: no tool call is forced.
        assert!(req.get("tools").is_none());
        assert!(req["tool_choice"].is_null());
        // No sampling/thinking params (would 400 on Opus 4.8).
        assert!(req.get("temperature").is_none());
        assert!(req.get("thinking").is_none());
        // The caller-built prompt rides as the user message verbatim.
        assert_eq!(
            req["messages"][0]["content"],
            "VERDICT contract... the student wrote: e4 e5"
        );
    }

    #[test]
    fn parses_a_plain_text_reply() {
        let v = json!({
            "stop_reason": "end_turn",
            "content": [{ "type": "text", "text": " VERDICT: partial\nFEEDBACK: close. " }]
        });
        assert_eq!(
            parse_text_response(&v).unwrap(),
            "VERDICT: partial\nFEEDBACK: close."
        );
    }

    #[test]
    fn refusal_and_empty_and_missing_text_are_errors() {
        let refusal = json!({ "stop_reason": "refusal", "content": [] });
        assert!(parse_text_response(&refusal).is_err());
        let empty = json!({ "stop_reason": "end_turn", "content": [{ "type": "text", "text": "  " }] });
        assert!(parse_text_response(&empty).is_err());
        let no_text = json!({ "stop_reason": "end_turn", "content": [{ "type": "tool_use", "name": "x", "input": {} }] });
        assert!(parse_text_response(&no_text).is_err());
        let no_content = json!({ "stop_reason": "end_turn" });
        assert!(parse_text_response(&no_content).is_err());
    }
}
