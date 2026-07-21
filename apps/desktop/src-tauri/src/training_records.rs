//! Training-record store (spec 226 J): the private half of what a notebook
//! produces — candidate sets, assessments with provenance, likelihood labels,
//! coverage, width and the head-to-head log, all pointing AT an archived game
//! and never living inside one.
//!
//! The document's shape is owned by the TypeScript side
//! (core/training-record.ts `TrainingRecordsStore`); this module persists the
//! raw JSON at `<app_data_dir>/training_records.json` — the same app-data-dir
//! pattern as active_games.rs. Deliberately NOT the spec 200 game database:
//! that holds the games as played, shared with the opponent, and this holds
//! everything about the player that must never be welded into one.
//!
//! ## The doctrine gate, layer 2
//!
//! This is the most dangerous store in the app. Once spec 215's post-game pass
//! joins engine verdicts onto these decisions, a by-FEN query over it IS an
//! engine-evaluation lookup table keyed by position — precisely what the
//! Notebook Doctrine (spec 226 G) exists to prevent, and precisely the thing
//! that would be cheating to consult mid-game.
//!
//! So `training_records_query_by_position` refuses unless the caller proves it
//! is standing outside a fair-play context, exactly as uci.rs refuses a
//! locked engine command. The TypeScript guard
//! (core/training-record.ts `positionQueryAllowed`) is layer 1 and this is
//! layer 2; keep the two rules in sync.
//!
//! The bulk load is NOT refused — reading your own notebook front to back is
//! permitted over anything — but it IS redacted, because the document is
//! itself a position index: a decision and a candidate each carry a FEN, so
//! handing the whole thing over inside a live game would deliver exactly the
//! table the query gate refuses, in one call. Outside an unrestricted context
//! the FENs are dropped on the way out and everything the linear read is for —
//! assessments, likelihoods, coverage, width, preferences — survives.
//!
//! ## Durability
//!
//! This store is the permanent cross-game evidence spec 226 J exists to
//! accumulate, and the TypeScript parser treats anything it cannot read as an
//! empty store — so a truncated write would look like "no records" and the
//! next archive would happily persist a store containing only that one game.
//! Hence: writes go to a temp file and are renamed over the target (atomic on
//! every platform we ship), writes are per-record so the whole document never
//! round-trips through the frontend, and a store that exists but will not
//! parse is never overwritten — the write refuses and says where the file is.

use std::path::PathBuf;

use tauri::Manager;

/// `<app_data_dir>/training_records.json`, creating the dir if absent.
fn store_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("training_records.json"))
}

/// The document version the TypeScript side writes (`TRAINING_RECORD_VERSION`).
const STORE_VERSION: i64 = 1;

fn empty_store() -> serde_json::Value {
    serde_json::json!({ "v": STORE_VERSION, "records": [] })
}

/// Read the store as JSON, distinguishing the three cases that matter:
/// absent (a fresh install — an empty store), readable, and PRESENT BUT
/// UNPARSEABLE. The last one is an error rather than an empty store on
/// purpose: reporting a damaged file as "no records" is how a damaged file
/// becomes a deleted one at the next write.
fn read_store(file: &PathBuf) -> Result<serde_json::Value, String> {
    let text = match std::fs::read_to_string(file) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(empty_store()),
        Err(e) => return Err(format!("reading {file:?}: {e}")),
    };
    if text.trim().is_empty() {
        return Ok(empty_store());
    }
    serde_json::from_str(&text).map_err(|e| {
        format!(
            "the training-record store at {file:?} is present but unreadable ({e}). \
             Refusing to touch it — move it aside by hand if it is beyond saving; \
             it holds every game's candidate sets and cannot be rebuilt."
        )
    })
}

/// Write via a temp file and rename, so a crash or a full disk leaves the
/// previous document intact rather than a truncated one.
fn write_store(file: &PathBuf, doc: &serde_json::Value) -> Result<(), String> {
    let json = serde_json::to_string(doc).map_err(|e| format!("serializing the store: {e}"))?;
    let tmp = file.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| format!("writing {tmp:?}: {e}"))?;
    std::fs::rename(&tmp, file).map_err(|e| format!("replacing {file:?}: {e}"))
}

/// Drop the position index out of a store document (spec 226 G/J).
///
/// Mirrors core/training-record.ts `redactPositionIndex`; keep the two in
/// sync. When spec 215 joins engine verdicts onto these decisions, THOSE
/// FIELDS BELONG HERE TOO — a verdict without a position cannot be looked up,
/// but there is no reason to ship it into a live game either.
fn redact_positions(doc: &mut serde_json::Value) {
    let Some(records) = doc.get_mut("records").and_then(|r| r.as_array_mut()) else {
        return;
    };
    for record in records.iter_mut() {
        let Some(decisions) = record.get_mut("decisions").and_then(|d| d.as_array_mut()) else {
            continue;
        };
        for decision in decisions.iter_mut() {
            if let Some(fen) = decision.get_mut("fen") {
                *fen = serde_json::Value::String(String::new());
            }
            if let Some(cands) = decision.get_mut("candidates").and_then(|c| c.as_array_mut()) {
                for cand in cands.iter_mut() {
                    if let Some(fen) = cand.get_mut("fen") {
                        *fen = serde_json::Value::String(String::new());
                    }
                }
            }
        }
    }
}

/// The stored document, or None if nothing has been written yet. Redacted
/// unless `context` proves the caller is outside a fair-play game.
#[tauri::command]
pub fn training_records_load(
    app: tauri::AppHandle,
    context: Option<String>,
) -> Result<Option<String>, String> {
    let file = store_path(&app)?;
    if !file.exists() {
        return Ok(None);
    }
    let mut doc = read_store(&file)?;
    if !position_query_allowed(context.as_deref()) {
        redact_positions(&mut doc);
    }
    serde_json::to_string(&doc)
        .map(Some)
        .map_err(|e| format!("serializing the store: {e}"))
}

/// Insert-or-replace one record by `id`, newest-created first — the same
/// ordering core's `upsertTrainingRecord` produces.
///
/// Per-record rather than whole-document because the frontend must never have
/// to LOAD the store in order to write it: what it loads is redacted inside a
/// fair-play context, and persisting that back would erase every position in
/// the store permanently.
#[tauri::command]
pub fn training_records_upsert(app: tauri::AppHandle, record: String) -> Result<(), String> {
    let incoming: serde_json::Value = serde_json::from_str(&record)
        .map_err(|e| format!("refusing to save malformed training-record JSON: {e}"))?;
    let file = store_path(&app)?;
    let doc = upsert_into(read_store(&file)?, incoming)?;
    write_store(&file, &doc)
}

/// Delete one record by id. An id that isn't there is a no-op.
#[tauri::command]
pub fn training_records_remove(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let file = store_path(&app)?;
    let doc = remove_from(read_store(&file)?, &id);
    write_store(&file, &doc)
}

/// The upsert itself, split out from the command so the ordering and the
/// replace-by-id rule are testable without a Tauri app handle.
fn upsert_into(
    doc: serde_json::Value,
    incoming: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let id = incoming
        .get("id")
        .and_then(|i| i.as_str())
        .ok_or_else(|| "refusing to save a training record with no id".to_string())?
        .to_string();
    let mut records = records_of(&doc);
    records.retain(|r| r.get("id").and_then(|i| i.as_str()) != Some(id.as_str()));
    records.push(incoming);
    records.sort_by_key(|r| -r.get("createdAt").and_then(|c| c.as_i64()).unwrap_or(0));
    Ok(serde_json::json!({ "v": STORE_VERSION, "records": records }))
}

fn remove_from(doc: serde_json::Value, id: &str) -> serde_json::Value {
    let mut records = records_of(&doc);
    records.retain(|r| r.get("id").and_then(|i| i.as_str()) != Some(id));
    serde_json::json!({ "v": STORE_VERSION, "records": records })
}

fn records_of(doc: &serde_json::Value) -> Vec<serde_json::Value> {
    doc.get("records")
        .and_then(|r| r.as_array())
        .cloned()
        .unwrap_or_default()
}

// ---- the doctrine gate ----

/// The only context tag that may run a position-indexed query. Mirrors
/// core/active-game.ts `UNRESTRICTED_ENGINE_CONTEXT`; anything else — an
/// `active-game:*` tag, an unknown string, or no tag at all — is refused.
///
/// Note the default is the OPPOSITE of uci.rs's: there, an absent tag means an
/// unrestricted caller and the scoping lives in the frontend hook. Here, an
/// absent tag means a caller that could not say where it was standing, and for
/// the store holding engine verdicts joined to positions "I don't know"
/// resolves to no.
const UNRESTRICTED_CONTEXT: &str = "unrestricted";

pub fn position_query_allowed(context: Option<&str>) -> bool {
    matches!(context, Some(tag) if tag == UNRESTRICTED_CONTEXT)
}

const POSITION_QUERY_REFUSED: &str =
    "Refused: position-indexed search of the training record is not available in a \
     fair-play context (spec 226 G — the store holds engine verdicts joined to positions)";

/// Position identity for the query: piece placement, side to move, castling
/// rights and the en-passant square. The move counters are dropped, because
/// the same position reached by a different move order is the same position —
/// which is exactly why this query is dangerous enough to gate.
fn fen_key(fen: &str) -> String {
    fen.split_whitespace()
        .take(4)
        .collect::<Vec<_>>()
        .join(" ")
}

/// Linear scan of the stored document for decisions at `fen`. Split out from
/// the command so the refusal and the matching are both unit-testable without
/// a Tauri app handle.
pub fn decisions_at_position(doc: &str, fen: &str) -> Result<String, String> {
    let parsed: serde_json::Value = serde_json::from_str(doc)
        .map_err(|e| format!("training-record store is not valid JSON: {e}"))?;
    let key = fen_key(fen);
    let mut hits: Vec<serde_json::Value> = Vec::new();
    let records = parsed
        .get("records")
        .and_then(|r| r.as_array())
        .cloned()
        .unwrap_or_default();
    for record in records {
        let id = record.get("id").cloned().unwrap_or(serde_json::Value::Null);
        let game = record.get("game").cloned().unwrap_or(serde_json::Value::Null);
        let decisions = record
            .get("decisions")
            .and_then(|d| d.as_array())
            .cloned()
            .unwrap_or_default();
        for decision in decisions {
            let matches = decision
                .get("fen")
                .and_then(|f| f.as_str())
                .map(|f| fen_key(f) == key)
                .unwrap_or(false);
            if matches {
                hits.push(serde_json::json!({
                    "recordId": id,
                    "game": game,
                    "decision": decision,
                }));
            }
        }
    }
    serde_json::to_string(&hits).map_err(|e| format!("serializing query result: {e}"))
}

/// Position-indexed read over the training record — the post-game instrument,
/// refused everywhere else. See the module docs: this is layer 2 of the
/// two-layer gate, and it must refuse on its own even if layer 1 is bypassed.
#[tauri::command]
pub fn training_records_query_by_position(
    app: tauri::AppHandle,
    fen: String,
    context: Option<String>,
) -> Result<String, String> {
    if !position_query_allowed(context.as_deref()) {
        return Err(POSITION_QUERY_REFUSED.to_string());
    }
    let file = store_path(&app)?;
    let doc = match std::fs::read_to_string(&file) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok("[]".to_string()),
        Err(e) => return Err(format!("reading {file:?}: {e}")),
    };
    decisions_at_position(&doc, &fen)
}

#[cfg(test)]
mod tests {
    use super::*;

    const DOC: &str = r#"{
      "v": 1,
      "records": [{
        "id": "tr-1",
        "game": { "gameUrl": "https://www.chess.com/game/daily/1" },
        "decisions": [
          { "nodeId": "n1", "fen": "8/8/8/8/8/8/8/K6k w - - 4 12" },
          { "nodeId": "n2", "fen": "8/8/8/8/8/8/8/K5k1 b - - 0 1" }
        ]
      }]
    }"#;

    #[test]
    fn refuses_a_fair_play_context() {
        assert!(!position_query_allowed(Some("active-game:https://x")));
        assert!(!position_query_allowed(Some("active-game:unknown")));
    }

    #[test]
    fn refuses_an_absent_or_unknown_context() {
        // "I could not tell where I was standing" resolves to no — the
        // opposite default from the engine gate, on purpose.
        assert!(!position_query_allowed(None));
        assert!(!position_query_allowed(Some("")));
        assert!(!position_query_allowed(Some("post-game")));
    }

    #[test]
    fn allows_only_the_unrestricted_tag() {
        assert!(position_query_allowed(Some("unrestricted")));
    }

    #[test]
    fn matches_ignoring_the_move_counters() {
        let out = decisions_at_position(DOC, "8/8/8/8/8/8/8/K6k w - - 0 1").unwrap();
        assert!(out.contains("\"n1\""), "{out}");
        assert!(!out.contains("\"n2\""), "{out}");
    }

    #[test]
    fn a_position_that_was_never_reached_yields_nothing() {
        let out = decisions_at_position(DOC, "8/8/8/8/8/8/8/K1k5 w - - 0 1").unwrap();
        assert_eq!(out, "[]");
    }

    #[test]
    fn redaction_drops_the_join_key_and_keeps_the_notes() {
        let mut doc: serde_json::Value = serde_json::from_str(
            r#"{"v":1,"records":[{"id":"tr-1","decisions":[
                 {"nodeId":"n1","fen":"8/8/8/8/8/8/8/K6k w - - 4 12","coverage":{"named":6},
                  "candidates":[{"san":"b4","fen":"8/8/8/8/8/8/8/K5k1 b - - 0 1","assessment":1}]}
               ]}]}"#,
        )
        .unwrap();
        redact_positions(&mut doc);
        let out = serde_json::to_string(&doc).unwrap();
        assert!(!out.contains("K6k"), "{out}");
        assert!(!out.contains("K5k1"), "{out}");
        // What the linear read is FOR survives untouched.
        assert!(out.contains("\"san\":\"b4\""), "{out}");
        assert!(out.contains("\"assessment\":1"), "{out}");
        assert!(out.contains("\"named\":6"), "{out}");
    }

    #[test]
    fn upsert_replaces_by_id_and_keeps_the_others() {
        let doc = serde_json::json!({"v":1,"records":[
            {"id":"tr-1","createdAt":1,"decisions":[]},
            {"id":"tr-2","createdAt":2,"decisions":[]}
        ]});
        let next = upsert_into(
            doc,
            serde_json::json!({"id":"tr-1","createdAt":3,"decisions":["fresh"]}),
        )
        .unwrap();
        let records = next["records"].as_array().unwrap();
        assert_eq!(records.len(), 2);
        // Newest first, and the untouched record is still there — the point of
        // writing per record rather than replacing the document.
        assert_eq!(records[0]["id"], "tr-1");
        assert_eq!(records[0]["createdAt"], 3);
        assert_eq!(records[1]["id"], "tr-2");
    }

    #[test]
    fn upsert_refuses_a_record_with_no_id() {
        assert!(upsert_into(empty_store(), serde_json::json!({"createdAt": 1})).is_err());
    }

    #[test]
    fn remove_leaves_the_rest_alone() {
        let doc = serde_json::json!({"v":1,"records":[
            {"id":"tr-1","createdAt":1},{"id":"tr-2","createdAt":2}
        ]});
        let next = remove_from(doc, "tr-1");
        let records = next["records"].as_array().unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0]["id"], "tr-2");
    }

    #[test]
    fn an_unreadable_store_is_an_error_not_an_empty_one() {
        // The whole point: "no records" is what the frontend parser reports for
        // a damaged file, and a write on top of that would delete a season of
        // evidence. Absent is fine; damaged is not.
        let dir = std::env::temp_dir().join(format!("tr-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("training_records.json");
        assert!(read_store(&file).is_ok(), "absent reads as an empty store");
        std::fs::write(&file, "{ truncated mid-wri").unwrap();
        let err = read_store(&file).unwrap_err();
        assert!(err.contains("unreadable"), "{err}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_write_replaces_the_file_atomically() {
        let dir = std::env::temp_dir().join(format!("tr-write-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("training_records.json");
        write_store(&file, &serde_json::json!({"v":1,"records":[{"id":"tr-1"}]})).unwrap();
        let back = read_store(&file).unwrap();
        assert_eq!(back["records"][0]["id"], "tr-1");
        // The temp file is renamed, never left behind next to the store.
        assert!(!dir.join("training_records.json.tmp").exists());
        std::fs::remove_dir_all(&dir).ok();
    }
}
