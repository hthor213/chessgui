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

use crate::verify::{self, LineVerification};
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
- If the student wrote nothing, that is normal (the text is optional): critique their MOVE CHOICE \
and eval against the engine data, and invite them to reply with why they chose it.\n\
- Compare evals by ABSOLUTE difference in pawns, never by ratio (\"you were 0.7 high\", not \
\"a threefold overstatement\" — ratios explode near zero and mislead). The student answers on a \
coarse quick-select grid (0.5-pawn steps below 1, whole pawns above), so treat a miss of half a \
grid step (~0.25 below 1.0, ~0.5 above) as input granularity, not misjudgment — do not scold \
precision the input cannot express.\n\
- If the student states a PLAN for the side to move, grade the plan's DIRECTION against the \
engine line, SEPARATELY from their eval number: \"aligned\" when the plan pushes where the \
engine's best play pushes, \"partial\" when it overlaps the engine line but misses its main \
point, \"wrong\" when the engine line contradicts or ignores it, \"unclear\" when the provided \
data cannot settle the direction. Grade only against the provided line and continuation — never \
against consequences you cannot verify. A \"wrong\" plan normally warrants the \
wrong_plan_priority cause tag. When no plan is stated, use \"no_plan\".\n\
- If the engine's best move looks like it hangs or loses material, do NOT invent a positional \
justification for it (\"gains space\", \"takes the initiative\"). When an engine line (best play) \
IS provided, use it to explain the concrete tactical point: walk the student through those moves \
and show how the material comes back or the threat lands, citing only the moves in that line. When \
NO engine line is provided, say plainly that the move's justification is concrete and tactical, \
that the data you have doesn't show the refutation, and that asking \"doesn't this just lose \
material?\" is exactly the right question to take to the board.\n\
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
    /// The user's perceived eval in pawns (White-POV), if given. On range
    /// elicitation this is a derived representative point — the range below is
    /// what they actually asserted.
    pub user_eval: Option<f64>,
    /// Range elicitation (spec 213): the asserted log-spaced range's bounds in
    /// pawns, White-POV; a missing side is unbounded ("4+"). Both None on
    /// point-elicitation answers. `#[serde(default)]` so pre-range frontends
    /// that omit the keys still deserialize.
    #[serde(default)]
    pub user_eval_lo: Option<f64>,
    #[serde(default)]
    pub user_eval_hi: Option<f64>,
    pub user_why: String,
    /// Plan elicitation (spec 213, v5): the user's one-line plan for the side
    /// to move (and optional plan B), asked on plan decks only.
    /// `#[serde(default)]` so pre-plan frontends that omit them deserialize.
    #[serde(default)]
    pub user_plan: Option<String>,
    #[serde(default)]
    pub user_plan_b: Option<String>,
    /// The move the user said they'd play (UCI), if any.
    pub user_move_uci: Option<String>,
    /// Line verification, 1-PLY (2026-07-16): White-POV engine eval of the
    /// USER'S move (searchmoves-restricted, same budget as the stored best-
    /// move eval) so the coach can grade the move itself, plus the mover-POV
    /// gap to best in centipawns. `#[serde(default)]` so older stored answers
    /// (no played-move eval) deserialize as None.
    #[serde(default)]
    pub user_move_eval_cp: Option<i64>,
    #[serde(default)]
    pub user_move_eval_mate: Option<i64>,
    #[serde(default)]
    pub user_move_gap_cp: Option<i64>,
    /// Second-look revision, if the user made one.
    pub revised_eval: Option<f64>,
    pub revision_note: Option<String>,
    /// What a rated human actually played from this position (v2 sessions).
    pub played_san: Option<String>,
    pub continuation_san: Option<Vec<String>>,
    pub white_elo: Option<i64>,
    pub black_elo: Option<i64>,
    /// Stockfish's best-play line (PV1), SAN, up to ~6 plies (v3 sessions). Lets
    /// the coach explain a tactical justification concretely. `#[serde(default)]`
    /// so v1/v2 frontends that omit it deserialize as None.
    #[serde(default)]
    pub sf_pv_san: Option<Vec<String>>,
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
    /// Plan elicitation (spec 213, v5): the stated plan's direction vs the
    /// engine line — "aligned" | "partial" | "wrong" | "unclear" | "no_plan".
    /// `#[serde(default)]` so pre-plan stored feedback deserializes as None.
    #[serde(default)]
    pub plan_grade: Option<String>,
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
    if let Some(pv) = input.sf_pv_san.as_ref().filter(|p| !p.is_empty()) {
        s.push_str(&format!("Engine line (best play): {}\n", pv.join(" ")));
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
    // Range elicitation: critique the range they actually asserted, never the
    // derived point. Point answers render exactly as before.
    match (input.user_eval_lo, input.user_eval_hi) {
        (None, None) => match input.user_eval {
            Some(e) => s.push_str(&format!("Their eval: {e:+.1} pawns (White-POV)\n")),
            None => s.push_str("Their eval: (skipped)\n"),
        },
        (lo, hi) => {
            let range = match (lo, hi) {
                (Some(l), Some(h)) => format!("between {l:+.1} and {h:+.1}"),
                (Some(l), None) => format!("{l:+.1} or more"),
                (None, Some(h)) => format!("{h:+.1} or less"),
                (None, None) => unreachable!(),
            };
            s.push_str(&format!(
                "Their eval: {range} pawns (White-POV — they asserted this RANGE, not a point; judge whether the truth falls inside it)\n"
            ));
        }
    }
    // Plan elicitation (spec 213): the plan was stated BEFORE the eval, on
    // plan decks only — render it so the coach can grade its direction.
    if let Some(plan) = input.user_plan.as_deref().filter(|p| !p.trim().is_empty()) {
        s.push_str(&format!("Their plan for the side to move: {}\n", plan.trim()));
        if let Some(b) = input.user_plan_b.as_deref().filter(|p| !p.trim().is_empty()) {
            s.push_str(&format!("Their backup plan: {}\n", b.trim()));
        }
    }
    s.push_str(&format!("Their reasoning: {}\n", if input.user_why.trim().is_empty() {
        "(they wrote nothing)"
    } else {
        input.user_why.trim()
    }));
    if let Some(mv) = &input.user_move_uci {
        s.push_str(&format!("The move they'd play: {mv}\n"));
        // 1-PLY verification: the engine's read of THEIR move, rendered next
        // to it so the coach grades the move they chose, not just the number.
        if let Some(m) = input.user_move_eval_mate {
            s.push_str(&format!(
                "Engine eval of their move (same depth as the best-move eval): mate in {m} (White-POV)\n"
            ));
        } else if let Some(cp) = input.user_move_eval_cp {
            s.push_str(&format!(
                "Engine eval of their move (same depth as the best-move eval): {:+.2} pawns (White-POV)\n",
                cp as f64 / 100.0
            ));
        }
        if let Some(gap) = input.user_move_gap_cp {
            if gap <= 10 {
                s.push_str("Their move matches the best move within search noise.\n");
            } else {
                s.push_str(&format!(
                    "Their move is {:.2} pawns worse than the best move (for the side to move).\n",
                    gap as f64 / 100.0
                ));
            }
        }
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
                    },
                    "plan_grade": {
                        "type": "string",
                        "enum": ["aligned", "partial", "wrong", "unclear", "no_plan"],
                        "description": "Direction of the student's stated plan vs the engine line, graded separately from the eval number; no_plan when they stated none."
                    }
                },
                "required": ["note", "cause_tags", "reasoning_quality", "scale_error", "plan_grade"]
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

/// System prompt for the follow-up round: the student pushes back on the
/// coach's note with their own reasoning, and the coach answers ONCE, still
/// grounded only in the provided engine data.
const FOLLOWUP_SYSTEM: &str = "You are a chess reasoning coach. You already gave a student a short \
critique of their analysis; the student has now REPLIED with their own reasoning — why they \
rejected the engine's move or judged the position as they did. Answer their reply directly.\n\n\
HARD RULES:\n\
- Base every claim ONLY on the engine data provided. NEVER invent moves, variations, or \
evaluations. If their objection turns on a concrete line you were not given (e.g. \"doesn't that \
lose material?\", \"isn't there a check?\"), say plainly that the data you have cannot settle it \
and that their question is the right one to check on the board.\n\
- When an ENGINE CHECK OF THE STUDENT'S LINE section is present, the student's own described \
line has been verified move by move — that IS engine data. Ground your answer in it: walk them \
through where their line holds and where the eval turns, or, if it breaks down, name the exact \
move that is illegal or where the game already ended. Cite only the moves and numbers in that \
section.\n\
- Take their stated reason seriously as a window into HOW they decide: castling rights, pin \
aversion, king safety fears, simplification urges. If the reason reflects a sound practical \
instinct, say so even when the engine disagrees with the conclusion. If it reflects a bias \
(overpricing castling, avoiding all pins on principle), name the bias kindly and concretely.\n\
- Compare evals by absolute difference in pawns, never by ratio.\n\
- Write 2 to 4 sentences, direct and warm, addressing the student as \"you\". No labels, no \
lists — just the reply.";

/// Render an engine-checked line (N-PLY verification) for the follow-up
/// prompt: per-ply White-POV evals, the net swing, and — when the line breaks
/// down — the exact move that is illegal. Grounded citations only.
fn checked_line_text(v: &LineVerification) -> String {
    let mut s = String::from(
        "\n\nENGINE CHECK OF THE STUDENT'S LINE (their described moves, verified move by move \
— this IS engine data; cite these moves and numbers freely)\n",
    );
    if let Some(m) = v.start_mate {
        s.push_str(&format!("Start (before the line): mate in {m} (White-POV)\n"));
    } else if let Some(cp) = v.start_cp {
        s.push_str(&format!("Start (before the line): {:+.2} (White-POV pawns)\n", cp as f64 / 100.0));
    }
    for (i, p) in v.plies.iter().enumerate() {
        let eval = if let Some(t) = &p.terminal {
            t.clone()
        } else if let Some(m) = p.eval_mate {
            format!("mate in {m}")
        } else if let Some(cp) = p.eval_cp {
            format!("{:+.2}", cp as f64 / 100.0)
        } else {
            "no read".to_string()
        };
        s.push_str(&format!("  ply {}: {} → {}\n", i + 1, p.san, eval));
    }
    if !v.legal {
        let at = v.illegal_at.unwrap_or(v.plies.len()) + 1;
        let mv = v.illegal_move.as_deref().unwrap_or("?");
        s.push_str(&format!(
            "LINE BREAKS DOWN: move {at} (\"{mv}\") is not legal at that point — everything \
before it is verified, nothing after it exists.\n"
        ));
    } else if v.ends_in_mate {
        s.push_str("The line ends in checkmate on the board.\n");
    } else if let Some(d) = v.delta_cp {
        s.push_str(&format!(
            "Net swing over the line: {:+.2} pawns (White-POV)\n",
            d as f64 / 100.0
        ));
    }
    s
}

/// Build the follow-up request: prior context + coach note + student reply
/// (+ the engine check of any line the student described), plain text
/// response (no tool call — this is conversational).
fn build_followup_request(
    input: &CoachInput,
    note: &str,
    rebuttal: &str,
    checked: Option<&LineVerification>,
) -> serde_json::Value {
    let mut text = user_text(input);
    text.push_str(&format!(
        "\n\nYOUR EARLIER COACHING NOTE\n{note}\n\nTHE STUDENT'S REPLY\n{rebuttal}"
    ));
    if let Some(v) = checked {
        text.push_str(&checked_line_text(v));
    }
    text.push_str("\n\nAnswer the student's reply.");
    json!({
        "model": MODEL,
        "max_tokens": 512,
        "system": FOLLOWUP_SYSTEM,
        "messages": [{ "role": "user", "content": text }]
    })
}

// ---------------------------------------------------------------------------
// Line extraction (N-PLY verification, 2026-07-16): pull a concrete move
// sequence out of the student's free-text reply so verify.rs can check it
// before the coach opines. Best-effort end to end — any failure degrades to
// the plain follow-up.
// ---------------------------------------------------------------------------

const EXTRACT_SYSTEM: &str = "You extract a concrete chess move sequence from a student's message \
so an engine can verify it. You are given a position (FEN, side to move) and the message. If the \
message describes a sequence of moves from THIS position, call extract_line with those moves in \
SAN, in order, alternating sides, starting with the side to move. Where the student is vague \
about one of their own moves (\"then I move my king\"), choose the most natural legal move \
consistent with their words; where they assert an opponent move (\"he must take on f5\"), include \
it. If a step cannot be pinned to a concrete move, stop the sequence at the last concrete move. \
If the message describes no move sequence at all, return an empty array. NEVER continue the line \
beyond what the student described.";

/// Build the extraction request: a forced, strict tool call returning the
/// SAN move list (possibly empty).
fn build_extract_request(input: &CoachInput, rebuttal: &str) -> serde_json::Value {
    let mut text = String::new();
    text.push_str(&format!("FEN: {}\n", input.fen));
    text.push_str(&format!("Side to move: {}\n", input.to_move));
    if let Some(best) = input.sf_best_san.as_deref().or(input.sf_best_uci.as_deref()) {
        text.push_str(&format!("Engine's best move (context only): {best}\n"));
    }
    text.push_str(&format!(
        "\nTHE STUDENT'S MESSAGE\n{rebuttal}\n\nExtract the described move sequence."
    ));
    json!({
        "model": MODEL,
        "max_tokens": 512,
        "system": EXTRACT_SYSTEM,
        "tools": [{
            "name": "extract_line",
            "description": "Report the concrete move sequence the student described, or an empty list.",
            "strict": true,
            "input_schema": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "moves": {
                        "type": "array",
                        "description": "The described moves in SAN, in order from the given position; empty if none.",
                        "items": { "type": "string" }
                    }
                },
                "required": ["moves"]
            }
        }],
        "tool_choice": { "type": "tool", "name": "extract_line" },
        "messages": [{ "role": "user", "content": text }]
    })
}

/// Extract the SAN list from an extract_line response; None on any miss.
fn parse_extract_response(v: &serde_json::Value) -> Option<Vec<String>> {
    let blocks = v["content"].as_array()?;
    let input = blocks
        .iter()
        .find(|b| b["type"] == "tool_use" && b["name"] == "extract_line")
        .map(|b| &b["input"])?;
    let moves = input["moves"].as_array()?;
    Some(
        moves
            .iter()
            .filter_map(|m| m.as_str())
            .map(|m| m.to_string())
            .collect(),
    )
}

/// Extraction + engine verification of the student's described line. Every
/// step is best-effort: no line, a failed extraction, or a dead engine all
/// resolve to None and the follow-up proceeds ungrounded (as before).
async fn extract_and_verify(
    key: &str,
    input: &CoachInput,
    rebuttal: &str,
    stockfish_path: Option<String>,
    movetime_ms: Option<u64>,
) -> Option<LineVerification> {
    let v = call_api(key, build_extract_request(input, rebuttal)).await.ok()?;
    let moves = parse_extract_response(&v)?;
    if moves.is_empty() {
        return None;
    }
    verify::verify_line_impl(&input.fen, &moves, stockfish_path, movetime_ms)
        .await
        .ok()
}

/// Extract the plain-text reply from a followup response body.
fn parse_followup_response(v: &serde_json::Value) -> Result<String, String> {
    if v["stop_reason"] == "refusal" {
        return Err("The model declined to reply".to_string());
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

/// POST one Messages API request, returning the parsed JSON body. Shared by
/// the note, the follow-up, and the line extraction.
async fn call_api(key: &str, body: serde_json::Value) -> Result<serde_json::Value, String> {
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
    Ok(v)
}

/// Ask Claude to critique the user's written reasoning for one position. Errors
/// (including "no API key") are returned as strings so the UI can degrade to a
/// one-line hint without blocking the reveal.
#[tauri::command]
pub async fn coach_feedback(input: CoachInput) -> Result<CoachFeedback, String> {
    let key = anthropic_api_key()?;
    let v = call_api(&key, build_request(&input)).await?;
    parse_response(&v)
}

/// One follow-up round: the student's rebuttal to the coach's note gets a
/// single grounded reply. Same degrade-to-hint error contract as the note.
///
/// N-PLY verification (2026-07-16): before replying, a line described in the
/// rebuttal is extracted (one extra model call) and engine-checked, and the
/// verified line joins the coach's context — so "Ra7, then I move the king,
/// then he must take f5" gets answered against real evals, not vibes.
/// `stockfish_path`/`movetime_ms` come from the session; both optional, and
/// the whole verification is best-effort (a miss degrades to the plain reply).
#[tauri::command]
pub async fn coach_followup(
    input: CoachInput,
    note: String,
    rebuttal: String,
    stockfish_path: Option<String>,
    movetime_ms: Option<u64>,
) -> Result<String, String> {
    let key = anthropic_api_key()?;
    let checked = extract_and_verify(&key, &input, &rebuttal, stockfish_path, movetime_ms).await;
    let body = build_followup_request(&input, &note, &rebuttal, checked.as_ref());
    let v = call_api(&key, body).await?;
    parse_followup_response(&v)
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
            user_eval_lo: None,
            user_eval_hi: None,
            user_why: "White wins a pawn on e7 with the exchange sequence".to_string(),
            user_plan: None,
            user_plan_b: None,
            user_move_uci: Some("c4d5".to_string()),
            user_move_eval_cp: None,
            user_move_eval_mate: None,
            user_move_gap_cp: None,
            revised_eval: None,
            revision_note: None,
            played_san: Some("cxd5".to_string()),
            continuation_san: Some(vec!["exd5".to_string(), "Qc2".to_string()]),
            white_elo: Some(2100),
            black_elo: Some(2080),
            sf_pv_san: Some(vec!["Qc2".to_string(), "dxc4".to_string(), "Bxc4".to_string()]),
        }
    }

    #[test]
    fn followup_request_carries_note_and_rebuttal_as_plain_text() {
        let req = build_followup_request(&sample_input(), "You missed Nxe2.", "I saw it but didn't want to lose castling.", None);
        assert_eq!(req["model"], "claude-opus-4-8");
        assert!(req.get("tools").is_none(), "followup is conversational, no tool call");
        let text = req["messages"][0]["content"].as_str().unwrap();
        assert!(text.contains("YOUR EARLIER COACHING NOTE"));
        assert!(text.contains("You missed Nxe2."));
        assert!(text.contains("lose castling"));
        assert!(text.contains("ENGINE EVIDENCE"), "position context still present");
        // No checked line → no engine-check section.
        assert!(!text.contains("ENGINE CHECK OF THE STUDENT'S LINE"));
    }

    fn checked_line() -> LineVerification {
        LineVerification {
            legal: true,
            illegal_at: None,
            illegal_move: None,
            start_cp: Some(35),
            start_mate: None,
            plies: vec![
                crate::verify::VerifiedPly {
                    san: "Ra7".to_string(),
                    uci: "a1a7".to_string(),
                    fen_after: "x".to_string(),
                    eval_cp: Some(120),
                    eval_mate: None,
                    terminal: None,
                },
                crate::verify::VerifiedPly {
                    san: "Kg8".to_string(),
                    uci: "h8g8".to_string(),
                    fen_after: "y".to_string(),
                    eval_cp: Some(110),
                    eval_mate: None,
                    terminal: None,
                },
            ],
            end_cp: Some(110),
            end_mate: None,
            delta_cp: Some(75),
            ends_in_mate: false,
        }
    }

    /// N-PLY verification: a checked line renders per-ply White-POV evals and
    /// the net swing into the follow-up prompt.
    #[test]
    fn followup_request_carries_the_engine_checked_line() {
        let v = checked_line();
        let req = build_followup_request(&sample_input(), "Note.", "Ra7 then he's stuck.", Some(&v));
        let text = req["messages"][0]["content"].as_str().unwrap();
        assert!(text.contains("ENGINE CHECK OF THE STUDENT'S LINE"));
        assert!(text.contains("ply 1: Ra7 → +1.20"));
        assert!(text.contains("ply 2: Kg8 → +1.10"));
        assert!(text.contains("Start (before the line): +0.35"));
        assert!(text.contains("Net swing over the line: +0.75"));
        // The instruction to answer still closes the prompt.
        assert!(text.trim_end().ends_with("Answer the student's reply."));
    }

    /// An illegal line names the exact breakdown move; a mate-ending line says
    /// so instead of a swing.
    #[test]
    fn checked_line_text_renders_breakdown_and_mate() {
        let mut v = checked_line();
        v.legal = false;
        v.illegal_at = Some(2);
        v.illegal_move = Some("Rxf5".to_string());
        let text = checked_line_text(&v);
        assert!(text.contains("LINE BREAKS DOWN: move 3 (\"Rxf5\")"));
        assert!(!text.contains("Net swing"));

        let mut v = checked_line();
        v.ends_in_mate = true;
        v.plies[1].terminal = Some("checkmate".to_string());
        v.plies[1].eval_cp = None;
        let text = checked_line_text(&v);
        assert!(text.contains("ply 2: Kg8 → checkmate"));
        assert!(text.contains("ends in checkmate"));
        assert!(!text.contains("Net swing"));
    }

    /// The extraction request is a forced strict tool call carrying the FEN
    /// and the student's message; the parser reads the SAN list back out.
    #[test]
    fn extract_request_and_response_roundtrip() {
        let req = build_extract_request(&sample_input(), "Ra7 then I move the king, then he must take f5");
        assert_eq!(req["tool_choice"]["name"], "extract_line");
        assert_eq!(req["tools"][0]["strict"], true);
        let text = req["messages"][0]["content"].as_str().unwrap();
        assert!(text.contains(&sample_input().fen));
        assert!(text.contains("he must take f5"));

        let resp = json!({
            "stop_reason": "tool_use",
            "content": [{ "type": "tool_use", "name": "extract_line",
                          "input": { "moves": ["Ra7", "Kg8", "gxf5"] } }]
        });
        assert_eq!(
            parse_extract_response(&resp).unwrap(),
            vec!["Ra7", "Kg8", "gxf5"]
        );
        // No tool block → None; an empty list parses as empty (caller skips).
        assert!(parse_extract_response(&json!({ "content": [] })).is_none());
        let empty = json!({
            "content": [{ "type": "tool_use", "name": "extract_line", "input": { "moves": [] } }]
        });
        assert_eq!(parse_extract_response(&empty).unwrap(), Vec::<String>::new());
    }

    /// 1-PLY verification: the user's move eval + gap render next to their
    /// move; mate-flavoured evals and the noise floor render sanely.
    #[test]
    fn user_move_eval_renders_in_prompt() {
        let mut input = sample_input();
        // No eval → just the move, as before.
        assert!(!user_text(&input).contains("Engine eval of their move"));

        input.user_move_eval_cp = Some(-58);
        input.user_move_gap_cp = Some(93);
        let text = user_text(&input);
        assert!(text.contains("The move they'd play: c4d5"));
        assert!(text.contains("Engine eval of their move (same depth as the best-move eval): -0.58 pawns (White-POV)"));
        assert!(text.contains("0.93 pawns worse than the best move"));

        // Within search noise → said as such, no scolding number.
        input.user_move_gap_cp = Some(4);
        assert!(user_text(&input).contains("matches the best move within search noise"));

        // A mate read wins over the cp line.
        input.user_move_eval_mate = Some(-2);
        assert!(user_text(&input).contains("Engine eval of their move (same depth as the best-move eval): mate in -2"));
    }

    #[test]
    fn followup_parse_takes_text_and_rejects_empty() {
        let ok = json!({ "stop_reason": "end_turn", "content": [{ "type": "text", "text": " A fair concern. " }] });
        assert_eq!(parse_followup_response(&ok).unwrap(), "A fair concern.");
        let empty = json!({ "stop_reason": "end_turn", "content": [{ "type": "text", "text": "  " }] });
        assert!(parse_followup_response(&empty).is_err());
        let refusal = json!({ "stop_reason": "refusal", "content": [] });
        assert!(parse_followup_response(&refusal).is_err());
    }

    /// The wire shape the frontend sends for a v1 calibration session (no v2
    /// game context — coachInputFor derives to_move from the FEN and sends
    /// explicit nulls). A required field missing here fails the whole invoke
    /// before any API call, which the UI shows as "request failed".
    #[test]
    fn deserializes_v1_session_wire_payload() {
        let wire = json!({
            "fen": "r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3",
            "to_move": "black",
            "sf_cp": 35,
            "sf_mate": null,
            "sf_best_san": "Nf6",
            "sf_best_uci": "g8f6",
            "multipv_gap_cp": 20,
            "material": 0,
            "user_eval": 0.5,
            "user_why": "developing",
            "user_move_uci": null,
            "revised_eval": null,
            "revision_note": null,
            "played_san": null,
            "continuation_san": null,
            "white_elo": null,
            "black_elo": null
        });
        let input: CoachInput = serde_json::from_value(wire).expect("v1 wire payload must deserialize");
        assert_eq!(input.to_move, "black");
        assert!(input.played_san.is_none());
        // v3's PV is absent on the v1 wire → None via #[serde(default)].
        assert!(input.sf_pv_san.is_none());
        // Range-elicitation bounds are absent on pre-range wires → None.
        assert!(input.user_eval_lo.is_none());
        assert!(input.user_eval_hi.is_none());
        // v5's plan fields are absent on pre-plan wires → None.
        assert!(input.user_plan.is_none());
        assert!(input.user_plan_b.is_none());
        // Played-move eval (1-PLY verification) absent on old wires → None.
        assert!(input.user_move_eval_cp.is_none());
        assert!(input.user_move_eval_mate.is_none());
        assert!(input.user_move_gap_cp.is_none());
    }

    /// Plan elicitation (spec 213): a stated plan (and plan B) renders in the
    /// student's answer section; absent or blank plans render nothing.
    #[test]
    fn plan_renders_when_stated_and_not_otherwise() {
        let mut input = sample_input();
        assert!(!user_text(&input).contains("Their plan"));

        input.user_plan = Some("queenside minority attack".to_string());
        let text = user_text(&input);
        assert!(text.contains("Their plan for the side to move: queenside minority attack"));
        assert!(!text.contains("Their backup plan"));

        input.user_plan_b = Some("trade into the pawn endgame".to_string());
        let text = user_text(&input);
        assert!(text.contains("Their backup plan: trade into the pawn endgame"));

        // A blank plan is the same as no plan — and a plan B without a plan A
        // never renders (the UI can't produce one, but the prompt stays sane).
        input.user_plan = Some("   ".to_string());
        let text = user_text(&input);
        assert!(!text.contains("Their plan"));
        assert!(!text.contains("Their backup plan"));
    }

    /// Range elicitation (spec 213): the prompt carries the asserted range —
    /// not the derived point — and unbounded sides render as "or more/less".
    #[test]
    fn range_answer_renders_as_range_not_point() {
        let mut input = sample_input();
        input.user_eval = Some(1.5); // derived midpoint — must NOT be shown
        input.user_eval_lo = Some(1.0);
        input.user_eval_hi = Some(2.0);
        let text = user_text(&input);
        assert!(text.contains("between +1.0 and +2.0"));
        assert!(text.contains("asserted this RANGE"));
        assert!(!text.contains("Their eval: +1.5"), "derived point must not leak into the prompt");

        input.user_eval_lo = Some(4.0);
        input.user_eval_hi = None;
        assert!(user_text(&input).contains("Their eval: +4.0 or more"));

        input.user_eval_lo = None;
        input.user_eval_hi = Some(-4.0);
        assert!(user_text(&input).contains("Their eval: -4.0 or less"));

        // Point answers (both bounds None) render exactly as before.
        input.user_eval_lo = None;
        input.user_eval_hi = None;
        assert!(user_text(&input).contains("Their eval: +1.5 pawns (White-POV)"));
    }

    #[test]
    fn request_is_forced_strict_tool_call_on_opus() {
        let req = build_request(&sample_input());
        assert_eq!(req["model"], "claude-opus-4-8");
        assert_eq!(req["tool_choice"]["type"], "tool");
        assert_eq!(req["tool_choice"]["name"], "coach_feedback");
        assert_eq!(req["tools"][0]["strict"], true);
        // Plan grading (spec 213 plan elicitation) is a required schema field.
        let schema = &req["tools"][0]["input_schema"];
        assert!(schema["required"].as_array().unwrap().iter().any(|v| v == "plan_grade"));
        assert!(schema["properties"]["plan_grade"]["enum"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v == "no_plan"));
        // No sampling/thinking params (would 400 on Opus 4.8).
        assert!(req.get("temperature").is_none());
        assert!(req.get("thinking").is_none());
        // The user text carries the engine evidence and the student's words.
        let text = req["messages"][0]["content"].as_str().unwrap();
        assert!(text.contains("ENGINE EVIDENCE"));
        assert!(text.contains("Qc2"), "best move present");
        assert!(text.contains("wins a pawn on e7"), "their reasoning present");
        assert!(text.contains("2100-rated") || text.contains("2100"), "player Elo present");
        // The v3 PV line renders in the engine-evidence section.
        assert!(
            text.contains("Engine line (best play): Qc2 dxc4 Bxc4"),
            "engine PV line present"
        );
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
                        "scale_error": true,
                        "plan_grade": "wrong"
                    }
                }
            ]
        });
        let fb = parse_response(&v).unwrap();
        assert!(fb.note.contains("cxd5"));
        assert_eq!(fb.reasoning_quality, "partial");
        assert!(fb.scale_error);
        assert_eq!(fb.cause_tags, vec!["miscounted_exchange", "scale_miscalibration"]);
        assert_eq!(fb.plan_grade.as_deref(), Some("wrong"));
    }

    /// A response without plan_grade (pre-plan model output, or stored old
    /// feedback re-parsed) still deserializes — the field defaults to None.
    #[test]
    fn parses_response_without_plan_grade() {
        let v = json!({
            "stop_reason": "tool_use",
            "content": [{
                "type": "tool_use",
                "name": "coach_feedback",
                "input": {
                    "note": "Sound read.",
                    "cause_tags": ["sound_reasoning"],
                    "reasoning_quality": "sound",
                    "scale_error": false
                }
            }]
        });
        let fb = parse_response(&v).unwrap();
        assert!(fb.plan_grade.is_none());
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
