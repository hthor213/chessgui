//! AI coach for the Eval Calibration reveal (spec 213).
//!
//! After the user commits an eval + written reasoning, this asks Claude to read
//! their *reasoning* (not just their number) and diagnose where it diverged from
//! the engine evidence — a missed piece, a miscounted exchange, an overlooked
//! defender, a wrong plan priority, or a scale miscalibration (right direction,
//! wrong magnitude). It is a reasoning critic grounded ONLY in the engine lines
//! and game continuation we pass it — it never invents variations.
//!
//! Alongside the coach-voice note it returns a structured `{cause_tags,
//! reasoning_quality, scale_error}` label from a fixed vocabulary — the first
//! machine labeler for the mistake taxonomy. Model is `claude-opus-4-8`
//! (accuracy over cost for AI features — do not downgrade).

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::vision::anthropic_api_key;

/// Model for coach feedback. Accuracy matters more than cost here; keep Opus.
const MODEL: &str = "claude-opus-4-8";

/// The fixed cause-tag vocabulary the model must choose from (documented in
/// docs/research/calibration-data-format.md). Keep in sync with that doc.
const CAUSE_TAGS: [&str; 10] = [
    "missed_piece",
    "miscounted_exchange",
    "overlooked_defender",
    "overlooked_attacker",
    "missed_tactic",
    "wrong_plan_priority",
    "king_safety_misjudged",
    "endgame_technique",
    "scale_miscalibration",
    "sound_reasoning",
];

const SYSTEM: &str = "You are a chess reasoning coach reviewing a student's written analysis of a \
single position. You are a REASONING CRITIC, not a chess oracle.\n\n\
HARD RULES:\n\
- Base every tactical or positional claim ONLY on the engine data and game continuation provided. \
NEVER invent moves, variations, or evaluations that are not in the provided data. If the evidence \
is too thin to explain the gap, say what you can and no more.\n\
- Your job is to diagnose the GAP between the student's written reasoning and the engine evidence: \
did they miss a piece, miscount an exchange sequence, overlook a defender or attacker, misjudge \
king safety, get the plan priority wrong, or get the eval direction right but the magnitude wrong \
(scale miscalibration)?\n\
- If the student's reasoning was sound and only their number was off, SAY SO explicitly — separate \
a calibration error (right idea, wrong size) from a perception error (missed something on the board).\n\
- Write 2 to 4 sentences in a direct, warm coach voice, addressing the student as \"you\". Name \
concrete squares and pieces, and refer to what THEY actually wrote. Be specific and useful; never \
praise emptily.\n\n\
Reply by calling the coach_feedback tool with your note and the structured labels.";

// ---------------------------------------------------------------------------
// Boundary types
// ---------------------------------------------------------------------------

/// Everything the coach needs about one answered position. Mirrors the frontend
/// `CoachInput` assembled in lib/calibration.ts.
#[derive(Debug, Clone, Deserialize)]
pub struct CoachInput {
    pub fen: String,
    /// "white" | "black" — side to move.
    pub to_move: String,
    pub sf_cp: Option<i64>,
    pub sf_mate: Option<i64>,
    pub sf_best_san: Option<String>,
    pub sf_best_uci: Option<String>,
    pub multipv_gap_cp: Option<i64>,
    pub material: Option<i32>,
    /// The user's perceived eval in pawns (White-POV), if given.
    pub user_eval: Option<f64>,
    pub user_why: String,
    /// The move the user said they'd play (UCI), if any.
    pub user_move_uci: Option<String>,
    /// Second-look revision, if the user made one.
    pub revised_eval: Option<f64>,
    pub revision_note: Option<String>,
    /// What a rated human actually played from this position (v2 sessions).
    pub played_san: Option<String>,
    pub continuation_san: Option<Vec<String>>,
    pub white_elo: Option<i64>,
    pub black_elo: Option<i64>,
}

/// The coach's response: a note plus structured taxonomy labels. Mirrors the
/// frontend `CoachFeedback`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CoachFeedback {
    pub note: String,
    pub cause_tags: Vec<String>,
    /// "sound" | "partial" | "flawed".
    pub reasoning_quality: String,
    /// Direction right, magnitude off.
    pub scale_error: bool,
}

// ---------------------------------------------------------------------------
// Request building + response parsing (pure — unit-tested without the network)
// ---------------------------------------------------------------------------

/// White-POV Stockfish eval, rendered for the prompt.
fn sf_eval_str(input: &CoachInput) -> String {
    if let Some(m) = input.sf_mate {
        format!("mate in {m} (White-POV: {})", if m > 0 { "White mates" } else { "Black mates" })
    } else if let Some(cp) = input.sf_cp {
        format!("{:+.2} pawns (White-POV)", cp as f64 / 100.0)
    } else {
        "unknown".to_string()
    }
}

/// Assemble the user-turn text: the engine evidence, then the student's answer.
fn user_text(input: &CoachInput) -> String {
    let mut s = String::new();
    s.push_str("POSITION\n");
    s.push_str(&format!("FEN: {}\n", input.fen));
    s.push_str(&format!("Side to move: {}\n", input.to_move));
    if let Some(mat) = input.material {
        s.push_str(&format!("Material balance (points, White minus Black): {mat:+}\n"));
    }
    s.push_str("\nENGINE EVIDENCE (Stockfish — the only ground truth; do not go beyond it)\n");
    s.push_str(&format!("Evaluation: {}\n", sf_eval_str(input)));
    if let Some(best) = input.sf_best_san.as_deref().or(input.sf_best_uci.as_deref()) {
        s.push_str(&format!("Best move: {best}\n"));
    }
    if let Some(gap) = input.multipv_gap_cp {
        s.push_str(&format!(
            "Best move's margin over the 2nd-best line: {:.2} pawns\n",
            gap as f64 / 100.0
        ));
    }
    if let Some(played) = &input.played_san {
        let elo = if input.to_move == "white" { input.white_elo } else { input.black_elo };
        let elo_str = elo.map(|e| format!(" ({e}-rated)", )).unwrap_or_default();
        s.push_str(&format!("In the actual game a{elo_str} human played: {played}\n"));
    }
    if let Some(cont) = &input.continuation_san {
        if !cont.is_empty() {
            s.push_str(&format!("Game continued: {}\n", cont.join(" ")));
        }
    }
    s.push_str("\nTHE STUDENT'S ANSWER\n");
    match input.user_eval {
        Some(e) => s.push_str(&format!("Their eval: {e:+.1} pawns (White-POV)\n")),
        None => s.push_str("Their eval: (skipped)\n"),
    }
    s.push_str(&format!("Their reasoning: {}\n", if input.user_why.trim().is_empty() {
        "(they wrote nothing)"
    } else {
        input.user_why.trim()
    }));
    if let Some(mv) = &input.user_move_uci {
        s.push_str(&format!("The move they'd play: {mv}\n"));
    }
    if input.revised_eval.is_some() || input.revision_note.is_some() {
        s.push_str("On a second look, before seeing this evidence, they revised: ");
        if let Some(re) = input.revised_eval {
            s.push_str(&format!("eval → {re:+.1}. "));
        }
        if let Some(note) = &input.revision_note {
            s.push_str(&format!("note: \"{note}\". "));
        }
        s.push('\n');
    }
    s.push_str("\nDiagnose the gap between their reasoning and the engine evidence.");
    s
}

/// Build the Anthropic Messages API request body. A forced, strict tool call
/// gives us the note and the structured labels in one validated object.
fn build_request(input: &CoachInput) -> serde_json::Value {
    json!({
        "model": MODEL,
        "max_tokens": 1024,
        "system": SYSTEM,
        "tools": [{
            "name": "coach_feedback",
            "description": "Deliver the coaching note and the structured taxonomy labels.",
            "strict": true,
            "input_schema": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "note": {
                        "type": "string",
                        "description": "2-4 sentence coach note addressed to the student as \"you\"."
                    },
                    "cause_tags": {
                        "type": "array",
                        "description": "Zero or more causes of the reasoning gap, from the fixed vocabulary.",
                        "items": { "type": "string", "enum": CAUSE_TAGS }
                    },
                    "reasoning_quality": {
                        "type": "string",
                        "enum": ["sound", "partial", "flawed"]
                    },
                    "scale_error": {
                        "type": "boolean",
                        "description": "True if the direction was right but the magnitude was off."
                    }
                },
                "required": ["note", "cause_tags", "reasoning_quality", "scale_error"]
            }
        }],
        "tool_choice": { "type": "tool", "name": "coach_feedback" },
        "messages": [{ "role": "user", "content": user_text(input) }]
    })
}

/// Extract the `coach_feedback` tool_use input from an Anthropic response body.
fn parse_response(v: &serde_json::Value) -> Result<CoachFeedback, String> {
    if v["stop_reason"] == "refusal" {
        return Err("The model declined to comment on this position".to_string());
    }
    let blocks = v["content"]
        .as_array()
        .ok_or("No content in model response")?;
    let tool_input = blocks
        .iter()
        .find(|b| b["type"] == "tool_use" && b["name"] == "coach_feedback")
        .map(|b| &b["input"])
        .ok_or("No coach_feedback tool call in model response")?;
    serde_json::from_value(tool_input.clone())
        .map_err(|e| format!("Malformed coach_feedback payload: {e}"))
}

// ---------------------------------------------------------------------------
// Tauri command
// ---------------------------------------------------------------------------

/// Ask Claude to critique the user's written reasoning for one position. Errors
/// (including "no API key") are returned as strings so the UI can degrade to a
/// one-line hint without blocking the reveal.
#[tauri::command]
pub async fn coach_feedback(input: CoachInput) -> Result<CoachFeedback, String> {
    let key = anthropic_api_key()?;
    let body = build_request(&input);

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
    parse_response(&v)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_input() -> CoachInput {
        CoachInput {
            fen: "r2q1rk1/pp1nbppp/2p1pn2/3p4/2PP4/2N1PN2/PP2BPPP/R1BQ1RK1 w - - 0 9".to_string(),
            to_move: "white".to_string(),
            sf_cp: Some(35),
            sf_mate: None,
            sf_best_san: Some("Qc2".to_string()),
            sf_best_uci: Some("d1c2".to_string()),
            multipv_gap_cp: Some(20),
            material: Some(0),
            user_eval: Some(1.5),
            user_why: "White wins a pawn on e7 with the exchange sequence".to_string(),
            user_move_uci: Some("c4d5".to_string()),
            revised_eval: None,
            revision_note: None,
            played_san: Some("cxd5".to_string()),
            continuation_san: Some(vec!["exd5".to_string(), "Qc2".to_string()]),
            white_elo: Some(2100),
            black_elo: Some(2080),
        }
    }

    #[test]
    fn request_is_forced_strict_tool_call_on_opus() {
        let req = build_request(&sample_input());
        assert_eq!(req["model"], "claude-opus-4-8");
        assert_eq!(req["tool_choice"]["type"], "tool");
        assert_eq!(req["tool_choice"]["name"], "coach_feedback");
        assert_eq!(req["tools"][0]["strict"], true);
        // No sampling/thinking params (would 400 on Opus 4.8).
        assert!(req.get("temperature").is_none());
        assert!(req.get("thinking").is_none());
        // The user text carries the engine evidence and the student's words.
        let text = req["messages"][0]["content"].as_str().unwrap();
        assert!(text.contains("ENGINE EVIDENCE"));
        assert!(text.contains("Qc2"), "best move present");
        assert!(text.contains("wins a pawn on e7"), "their reasoning present");
        assert!(text.contains("2100-rated") || text.contains("2100"), "player Elo present");
    }

    #[test]
    fn skipped_answer_renders_without_eval() {
        let mut input = sample_input();
        input.user_eval = None;
        input.user_why = "".to_string();
        let text = user_text(&input);
        assert!(text.contains("(skipped)"));
        assert!(text.contains("(they wrote nothing)"));
    }

    #[test]
    fn parses_tool_use_response() {
        let v = json!({
            "stop_reason": "tool_use",
            "content": [
                { "type": "text", "text": "" },
                {
                    "type": "tool_use",
                    "name": "coach_feedback",
                    "input": {
                        "note": "You counted the e7 capture as winning a pawn, but after cxd5 exd5 the pawn is recaptured — material is level, so your +1.5 is really about +0.3.",
                        "cause_tags": ["miscounted_exchange", "scale_miscalibration"],
                        "reasoning_quality": "partial",
                        "scale_error": true
                    }
                }
            ]
        });
        let fb = parse_response(&v).unwrap();
        assert!(fb.note.contains("cxd5"));
        assert_eq!(fb.reasoning_quality, "partial");
        assert!(fb.scale_error);
        assert_eq!(fb.cause_tags, vec!["miscounted_exchange", "scale_miscalibration"]);
    }

    #[test]
    fn refusal_and_missing_tool_are_errors() {
        let refusal = json!({ "stop_reason": "refusal", "content": [] });
        assert!(parse_response(&refusal).is_err());
        let no_tool = json!({ "stop_reason": "end_turn", "content": [{ "type": "text", "text": "hi" }] });
        assert!(parse_response(&no_tool).is_err());
    }

    /// Manual live smoke against the real API, benchmarking the coach on the
    /// user's answer #1 (the e7-exchange miscount). Run with:
    ///   ANTHROPIC_API_KEY=... cargo test --lib coach -- --ignored --nocapture live_coach_smoke
    #[tokio::test]
    #[ignore = "manual; calls the real Anthropic API (needs a key)"]
    async fn live_coach_smoke() {
        let fb = coach_feedback(sample_input()).await;
        match fb {
            Ok(f) => {
                println!("\n=== coach note ===\n{}\n", f.note);
                println!("tags: {:?}", f.cause_tags);
                println!("reasoning_quality: {}  scale_error: {}", f.reasoning_quality, f.scale_error);
                assert!(!f.note.trim().is_empty());
            }
            Err(e) => {
                eprintln!("live_coach_smoke skipped/failed: {e}");
            }
        }
    }
}
