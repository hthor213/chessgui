//! Avoidance puzzles (spec 211, Tier 1): storage, import and queries for the
//! `puzzles` table in the app database.
//!
//! The schema MIRRORS scripts/mining/import_puzzles.py EXACTLY (one schema,
//! two writers is a bug factory — the Python importer builds standalone
//! puzzle DBs on the mining host; this module ingests the same generator
//! JSONL directly into the app DB). Any schema change must land in BOTH
//! places. Dedup is identical too: UNIQUE(fen, trap_uci) + INSERT OR IGNORE,
//! so re-importing a batch is a no-op and the same rake reached in two games
//! lands once.
//!
//! Beyond the Python importer's implicit validation (missing keys abort the
//! row), rows here are also checked for a parseable FEN, a legal trap move
//! and a legal refutation line — the solver replays them on a real board, so
//! a malformed row would surface as a broken puzzle later. Invalid rows are
//! counted as errors, never imported.
//!
//! `puzzle_check_move` is the solver's grading engine: a one-shot Stockfish
//! eval of the position AFTER a candidate move, at the puzzle's verify depth,
//! returned from the MOVER's perspective — the same convention as the
//! generator's `verified_*_cp` fields, so lib/puzzles.ts can grade against
//! the stored thresholds directly.

use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use serde_json::Value;
use shakmaty::fen::Fen;
use shakmaty::uci::UciMove;
use shakmaty::{CastlingMode, Chess, Position};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::time::timeout;

use crate::db::{resolve_db_path, Db, DbManager};

/// Default Stockfish binary (Homebrew, Apple Silicon) — same as calibration.
const DEFAULT_STOCKFISH: &str = "/opt/homebrew/bin/stockfish";

/// Opening-rake bar (spec 211 "Opening-rake decks"): a puzzle counts as an
/// opening rake when its trap ply index is < 20 — "don't be -1 by move 10".
/// MIRRORS `OPENING_MAX_PLY` in packages/core/src/puzzle-types.ts (the deck
/// UI sends the same value as `max_ply`); a change must land in both.
const OPENING_MAX_PLY: i64 = 20;

/// `puzzles` table DDL — a verbatim mirror of import_puzzles.py's SCHEMA
/// (column names, types, defaults, unique key, index). Executed by
/// `Db::init_schema` (db.rs) as part of schema v2.
pub(crate) const PUZZLES_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS puzzles (
    id                   INTEGER PRIMARY KEY,
    fen                  TEXT NOT NULL,
    trap_uci             TEXT NOT NULL,
    trap_san             TEXT,
    refutation_line      TEXT NOT NULL,          -- space-separated UCI
    played_reply_san     TEXT,
    safe_threshold       INTEGER NOT NULL,        -- cp window for "correct"
    eval_before_cp       INTEGER,                 -- mover perspective ([%eval])
    eval_after_cp        INTEGER,
    verified_pre_best_cp INTEGER,                 -- engine re-verification
    verified_after_cp    INTEGER,
    n_alternatives       INTEGER,
    mate                 INTEGER NOT NULL DEFAULT 0,
    mover                TEXT,
    ply                  INTEGER,
    band                 TEXT,                    -- mover's 100-Elo band
    white_elo            INTEGER,
    black_elo            INTEGER,
    source_game_id       TEXT,
    site                 TEXT,
    date                 TEXT,
    time_control         TEXT,
    source_file          TEXT,
    themes               TEXT NOT NULL DEFAULT '[]',  -- Tier-3 (spec 211:59)
    band_miss_rates      TEXT,                        -- Tier-2 (spec 211:53)
    engine_verify_depth  INTEGER NOT NULL,
    generator            TEXT,
    created_at           TEXT NOT NULL,
    -- Depth-differential difficulty PRIOR (spec 214 cognitive-gate proposal):
    -- minimal Stockfish depth at which the trap registers as clearly losing;
    -- -1 = swept to max depth without registering, NULL = not annotated.
    -- Written by scripts/mining/depth_differential.py. The depth->Elo mapping
    -- awaits Tier-2 band miss-rate calibration (spec 211) — a prior, not a
    -- calibrated difficulty.
    visible_from_depth   INTEGER,
    UNIQUE (fen, trap_uci)
);
CREATE INDEX IF NOT EXISTS idx_puzzles_band ON puzzles (band);
"#;

/// Idempotent column migration: DBs whose `puzzles` table predates
/// `visible_from_depth` never get it from CREATE TABLE IF NOT EXISTS, so the
/// column is ALTERed in — appended, matching its append-only position in the
/// DDL (and what scripts/mining/depth_differential.py does on standalone DBs).
pub(crate) fn migrate_puzzles_columns(conn: &rusqlite::Connection) -> rusqlite::Result<()> {
    let has: i64 = conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('puzzles') WHERE name = 'visible_from_depth'",
        [],
        |r| r.get(0),
    )?;
    if has == 0 {
        conn.execute("ALTER TABLE puzzles ADD COLUMN visible_from_depth INTEGER", [])?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Serde boundary types (mirrored in lib/puzzles.ts)
// ---------------------------------------------------------------------------

/// Outcome of a JSONL import.
#[derive(Debug, Default, Clone, Serialize)]
pub struct PuzzleImportReport {
    pub imported: u64,
    pub dups_skipped: u64,
    pub errors: u64,
}

/// One puzzle row, as the solver consumes it. `refutation_line` is split back
/// into per-move UCI; `themes` is parsed back to a list.
#[derive(Debug, Clone, Serialize)]
pub struct PuzzleRow {
    pub id: i64,
    pub fen: String,
    pub trap_uci: String,
    pub trap_san: Option<String>,
    pub refutation_line: Vec<String>,
    pub played_reply_san: Option<String>,
    pub safe_threshold: i64,
    pub eval_before_cp: Option<i64>,
    pub eval_after_cp: Option<i64>,
    pub verified_pre_best_cp: Option<i64>,
    pub verified_after_cp: Option<i64>,
    pub n_alternatives: Option<i64>,
    pub mate: bool,
    pub mover: Option<String>,
    pub ply: Option<i64>,
    pub band: Option<String>,
    pub white_elo: Option<i64>,
    pub black_elo: Option<i64>,
    pub source_game_id: Option<String>,
    pub site: Option<String>,
    pub date: Option<String>,
    pub time_control: Option<String>,
    pub themes: Vec<String>,
    pub band_miss_rates: Option<String>,
    pub engine_verify_depth: i64,
}

/// Per-band puzzle counts, for the deck picker.
#[derive(Debug, Clone, Serialize)]
pub struct PuzzleBandCount {
    pub band: String,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct PuzzleStats {
    pub total: i64,
    /// Puzzles with trap ply < OPENING_MAX_PLY — the opening-rake pool.
    pub opening: i64,
    pub bands: Vec<PuzzleBandCount>,
}

// ---------------------------------------------------------------------------
// Row validation (generator JSONL -> insertable values)
// ---------------------------------------------------------------------------

struct ValidRow {
    fen: String,
    trap_uci: String,
    trap_san: Option<String>,
    refutation_line: String,
    played_reply_san: Option<String>,
    safe_threshold: i64,
    eval_before_cp: Option<i64>,
    eval_after_cp: Option<i64>,
    verified_pre_best_cp: Option<i64>,
    verified_after_cp: Option<i64>,
    n_alternatives: Option<i64>,
    mate: i64,
    mover: Option<String>,
    ply: Option<i64>,
    band: Option<String>,
    white_elo: Option<i64>,
    black_elo: Option<i64>,
    source_game_id: Option<String>,
    site: Option<String>,
    date: Option<String>,
    time_control: Option<String>,
    source_file: Option<String>,
    themes: String,
    band_miss_rates: Option<String>,
    engine_verify_depth: i64,
    generator: Option<String>,
    created_at: String,
}

fn opt_str(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(|x| x.as_str()).map(|s| s.to_string())
}

fn opt_int(v: &Value, key: &str) -> Option<i64> {
    v.get(key).and_then(|x| x.as_i64())
}

/// Parse `fen` into a playable position (standard castling, like the rest of
/// the app).
fn position_of(fen: &str) -> Option<Chess> {
    Fen::from_ascii(fen.as_bytes())
        .ok()?
        .into_position::<Chess>(CastlingMode::Standard)
        .ok()
}

/// Validate one generator JSONL record. Mirrors import_puzzles.py's required
/// fields (a missing key rejects the row), plus board-level checks the solver
/// depends on: the FEN parses, the trap move is legal, and the refutation
/// line replays legally after the trap.
fn validate_row(v: &Value) -> Result<ValidRow, String> {
    let fen = opt_str(v, "fen").ok_or("missing fen")?;
    let trap_uci = opt_str(v, "trap_uci").ok_or("missing trap_uci")?;
    let safe_threshold = opt_int(v, "safe_threshold_cp").ok_or("missing safe_threshold_cp")?;
    let engine_verify_depth =
        opt_int(v, "engine_verify_depth").ok_or("missing engine_verify_depth")?;
    let created_at = opt_str(v, "created_at").ok_or("missing created_at")?;
    let refutation: Vec<String> = v
        .get("refutation_line")
        .and_then(|x| x.as_array())
        .ok_or("missing refutation_line")?
        .iter()
        .map(|m| m.as_str().map(|s| s.to_string()).ok_or("non-string refutation move"))
        .collect::<Result<_, _>>()?;
    if refutation.is_empty() {
        return Err("empty refutation_line".to_string());
    }

    // Board-level checks: replay trap + refutation on a real board.
    let mut pos = position_of(&fen).ok_or("unparseable fen")?;
    let trap = UciMove::from_ascii(trap_uci.as_bytes())
        .ok()
        .and_then(|u| u.to_move(&pos).ok())
        .ok_or("illegal trap move")?;
    pos.play_unchecked(trap);
    for m in &refutation {
        let mv = UciMove::from_ascii(m.as_bytes())
            .ok()
            .and_then(|u| u.to_move(&pos).ok())
            .ok_or("illegal refutation move")?;
        pos.play_unchecked(mv);
    }

    // themes: keep valid JSON text; the generator leaves it absent (Tier-3).
    let themes = v
        .get("themes")
        .filter(|t| t.is_array())
        .map(|t| t.to_string())
        .unwrap_or_else(|| "[]".to_string());

    Ok(ValidRow {
        fen,
        trap_uci,
        trap_san: opt_str(v, "trap_san"),
        refutation_line: refutation.join(" "),
        played_reply_san: opt_str(v, "played_reply_san"),
        safe_threshold,
        eval_before_cp: opt_int(v, "eval_before_cp"),
        eval_after_cp: opt_int(v, "eval_after_cp"),
        verified_pre_best_cp: opt_int(v, "verified_pre_best_cp"),
        verified_after_cp: opt_int(v, "verified_after_cp"),
        n_alternatives: opt_int(v, "n_alternatives"),
        mate: v.get("mate").and_then(|x| x.as_bool()).unwrap_or(false) as i64,
        mover: opt_str(v, "mover"),
        ply: opt_int(v, "ply"),
        band: opt_str(v, "band"),
        white_elo: opt_int(v, "white_elo"),
        black_elo: opt_int(v, "black_elo"),
        source_game_id: opt_str(v, "source_game_id"),
        site: opt_str(v, "site"),
        date: opt_str(v, "date"),
        time_control: opt_str(v, "time_control"),
        source_file: opt_str(v, "source_file"),
        themes,
        band_miss_rates: v
            .get("band_miss_rates")
            .filter(|x| !x.is_null())
            .map(|x| x.to_string()),
        engine_verify_depth,
        generator: opt_str(v, "generator"),
        created_at,
    })
}

// ---------------------------------------------------------------------------
// Db extension: import + queries
// ---------------------------------------------------------------------------

impl Db {
    /// Ingest generator JSONL (one record per line). Blank lines are skipped;
    /// invalid lines count as errors. Dedup via UNIQUE(fen, trap_uci).
    pub fn import_puzzles_jsonl(&mut self, text: &str) -> rusqlite::Result<PuzzleImportReport> {
        let mut report = PuzzleImportReport::default();
        let tx = self.conn.transaction()?;
        {
            let mut stmt = tx.prepare_cached(
                "INSERT OR IGNORE INTO puzzles (fen, trap_uci, trap_san, refutation_line, \
                 played_reply_san, safe_threshold, eval_before_cp, eval_after_cp, \
                 verified_pre_best_cp, verified_after_cp, n_alternatives, mate, mover, ply, \
                 band, white_elo, black_elo, source_game_id, site, date, time_control, \
                 source_file, themes, band_miss_rates, engine_verify_depth, generator, \
                 created_at) \
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,\
                 ?20,?21,?22,?23,?24,?25,?26,?27)",
            )?;
            for line in text.lines() {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                let parsed: Value = match serde_json::from_str(line) {
                    Ok(v) => v,
                    Err(_) => {
                        report.errors += 1;
                        continue;
                    }
                };
                let row = match validate_row(&parsed) {
                    Ok(r) => r,
                    Err(_) => {
                        report.errors += 1;
                        continue;
                    }
                };
                let changed = stmt.execute(params![
                    row.fen,
                    row.trap_uci,
                    row.trap_san,
                    row.refutation_line,
                    row.played_reply_san,
                    row.safe_threshold,
                    row.eval_before_cp,
                    row.eval_after_cp,
                    row.verified_pre_best_cp,
                    row.verified_after_cp,
                    row.n_alternatives,
                    row.mate,
                    row.mover,
                    row.ply,
                    row.band,
                    row.white_elo,
                    row.black_elo,
                    row.source_game_id,
                    row.site,
                    row.date,
                    row.time_control,
                    row.source_file,
                    row.themes,
                    row.band_miss_rates,
                    row.engine_verify_depth,
                    row.generator,
                    row.created_at,
                ])?;
                if changed == 0 {
                    report.dups_skipped += 1;
                } else {
                    report.imported += 1;
                }
            }
        }
        tx.commit()?;
        Ok(report)
    }

    /// Draw a random deck. `band` filters to the mover's Elo band when given;
    /// if the band can't fill `limit`, the remainder is topped up from the
    /// whole table (honest fallback — a thin band never silently shrinks the
    /// session). `theme` filters on the themes JSON list (Tier-3; no-op on
    /// Tier-1 data where themes = []). `max_ply` keeps only puzzles whose
    /// trap ply is below it (the opening-rake deck, spec 211); unlike the
    /// band it is a HARD filter — the top-up respects it too, because a
    /// midgame rake in an opening deck defeats the deck's point. NULL plies
    /// are excluded when the cap is on (an unknown phase can't qualify).
    pub fn puzzles_deck(
        &self,
        band: Option<&str>,
        theme: Option<&str>,
        max_ply: Option<i64>,
        limit: i64,
    ) -> rusqlite::Result<Vec<PuzzleRow>> {
        let theme_like = theme.map(|t| format!("%\"{}\"%", t));
        let mut rows: Vec<PuzzleRow> = Vec::new();
        if let Some(b) = band {
            let mut stmt = self.conn.prepare(
                "SELECT * FROM puzzles WHERE band = ?1 \
                 AND (?2 IS NULL OR themes LIKE ?2) \
                 AND (?3 IS NULL OR ply < ?3) \
                 ORDER BY RANDOM() LIMIT ?4",
            )?;
            let got = stmt.query_map(params![b, theme_like, max_ply, limit], row_to_puzzle)?;
            for r in got {
                rows.push(r?);
            }
        }
        if rows.len() < limit as usize {
            let need = limit - rows.len() as i64;
            let picked: Vec<i64> = rows.iter().map(|r| r.id).collect();
            let ids_csv = picked
                .iter()
                .map(|i| i.to_string())
                .collect::<Vec<_>>()
                .join(",");
            // `picked` are numeric ids straight from this query — safe to inline.
            let sql = format!(
                "SELECT * FROM puzzles WHERE (?1 IS NULL OR themes LIKE ?1) \
                 AND (?2 IS NULL OR ply < ?2) \
                 AND id NOT IN ({}) ORDER BY RANDOM() LIMIT ?3",
                if ids_csv.is_empty() { "-1".to_string() } else { ids_csv }
            );
            let mut stmt = self.conn.prepare(&sql)?;
            let got = stmt.query_map(params![theme_like, max_ply, need], row_to_puzzle)?;
            for r in got {
                rows.push(r?);
            }
        }
        Ok(rows)
    }

    pub fn get_puzzle(&self, id: i64) -> rusqlite::Result<Option<PuzzleRow>> {
        self.conn
            .query_row("SELECT * FROM puzzles WHERE id = ?1", [id], row_to_puzzle)
            .optional()
    }

    pub fn puzzles_stats(&self) -> rusqlite::Result<PuzzleStats> {
        let total = self
            .conn
            .query_row("SELECT COUNT(*) FROM puzzles", [], |r| r.get(0))?;
        let opening = self.conn.query_row(
            "SELECT COUNT(*) FROM puzzles WHERE ply < ?1",
            [OPENING_MAX_PLY],
            |r| r.get(0),
        )?;
        let mut stmt = self.conn.prepare(
            "SELECT band, COUNT(*) FROM puzzles WHERE band IS NOT NULL \
             GROUP BY band ORDER BY band",
        )?;
        let bands = stmt
            .query_map([], |r| {
                Ok(PuzzleBandCount {
                    band: r.get(0)?,
                    count: r.get(1)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(PuzzleStats {
            total,
            opening,
            bands,
        })
    }
}

/// Column order matches PUZZLES_SCHEMA (SELECT * is safe because the schema is
/// append-only by construction — it mirrors the frozen Python importer).
fn row_to_puzzle(r: &rusqlite::Row<'_>) -> rusqlite::Result<PuzzleRow> {
    let refutation: String = r.get("refutation_line")?;
    let themes_raw: String = r.get("themes")?;
    let themes: Vec<String> = serde_json::from_str(&themes_raw).unwrap_or_default();
    Ok(PuzzleRow {
        id: r.get("id")?,
        fen: r.get("fen")?,
        trap_uci: r.get("trap_uci")?,
        trap_san: r.get("trap_san")?,
        refutation_line: refutation.split_whitespace().map(String::from).collect(),
        played_reply_san: r.get("played_reply_san")?,
        safe_threshold: r.get("safe_threshold")?,
        eval_before_cp: r.get("eval_before_cp")?,
        eval_after_cp: r.get("eval_after_cp")?,
        verified_pre_best_cp: r.get("verified_pre_best_cp")?,
        verified_after_cp: r.get("verified_after_cp")?,
        n_alternatives: r.get("n_alternatives")?,
        mate: r.get::<_, i64>("mate")? != 0,
        mover: r.get("mover")?,
        ply: r.get("ply")?,
        band: r.get("band")?,
        white_elo: r.get("white_elo")?,
        black_elo: r.get("black_elo")?,
        source_game_id: r.get("source_game_id")?,
        site: r.get("site")?,
        date: r.get("date")?,
        time_control: r.get("time_control")?,
        themes,
        band_miss_rates: r.get("band_miss_rates")?,
        engine_verify_depth: r.get("engine_verify_depth")?,
    })
}

// ---------------------------------------------------------------------------
// Grading engine: one-shot fixed-depth eval after a candidate move
// ---------------------------------------------------------------------------

/// Engine verdict on a candidate move, MOVER's perspective (the side that just
/// moved) — the same convention as the generator's verified_*_cp fields.
/// `pv` is the opponent's best line after the move (the refutation, if the
/// move loses), as UCI.
#[derive(Debug, Clone, Serialize)]
pub struct MoveCheck {
    pub cp_mover: Option<i64>,
    /// Mate distance, mover POV: negative = mover gets mated.
    pub mate_mover: Option<i64>,
    pub pv: Vec<String>,
    pub depth: u32,
}

/// Last-seen `info depth .. score (cp|mate) N .. pv ...` — side-to-move POV.
fn parse_info_line(line: &str) -> Option<(Option<i64>, Option<i64>, Vec<String>)> {
    let toks: Vec<&str> = line.split_whitespace().collect();
    let mut cp = None;
    let mut mate = None;
    let mut pv = Vec::new();
    let mut i = 0;
    while i < toks.len() {
        match toks[i] {
            "score" if i + 2 < toks.len() + 1 => {
                if toks.get(i + 1) == Some(&"cp") {
                    cp = toks.get(i + 2).and_then(|v| v.parse().ok());
                } else if toks.get(i + 1) == Some(&"mate") {
                    mate = toks.get(i + 2).and_then(|v| v.parse().ok());
                }
                i += 3;
            }
            "pv" => {
                pv = toks[i + 1..].iter().map(|s| s.to_string()).collect();
                break;
            }
            _ => i += 1,
        }
    }
    if cp.is_none() && mate.is_none() {
        return None;
    }
    Some((cp, mate, pv))
}

/// Evaluate `fen` after `uci_move` at fixed `depth` with a one-shot Stockfish.
/// The move is validated on a real board first, so an illegal candidate errors
/// immediately instead of confusing the engine.
async fn check_move_impl(
    fen: &str,
    uci_move: &str,
    depth: u32,
    stockfish_path: &str,
) -> Result<MoveCheck, String> {
    let pos = position_of(fen).ok_or_else(|| format!("unparseable FEN: {fen}"))?;
    UciMove::from_ascii(uci_move.as_bytes())
        .ok()
        .and_then(|u| u.to_move(&pos).ok())
        .ok_or_else(|| format!("illegal move {uci_move} in {fen}"))?;

    let mut child = crate::engine_path::engine_command(stockfish_path)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("Failed to start Stockfish '{stockfish_path}': {e}"))?;
    let mut stdin = child.stdin.take().ok_or("No stdin")?;
    let stdout = child.stdout.take().ok_or("No stdout")?;
    let mut lines = BufReader::new(stdout).lines();

    async fn send(stdin: &mut tokio::process::ChildStdin, cmd: String) -> Result<(), String> {
        stdin
            .write_all(format!("{cmd}\n").as_bytes())
            .await
            .map_err(|e| format!("Write error: {e}"))
    }

    send(&mut stdin, "uci".to_string()).await?;
    let handshake = async {
        loop {
            match lines.next_line().await {
                Ok(Some(l)) if l.trim() == "uciok" => return Ok(()),
                Ok(Some(_)) => continue,
                Ok(None) => return Err("Stockfish closed unexpectedly".to_string()),
                Err(e) => return Err(format!("Read error: {e}")),
            }
        }
    };
    timeout(Duration::from_secs(10), handshake)
        .await
        .map_err(|_| "Timed out waiting for uciok".to_string())??;

    send(&mut stdin, format!("position fen {fen} moves {uci_move}")).await?;
    send(&mut stdin, format!("go depth {depth}")).await?;

    let mut last: Option<(Option<i64>, Option<i64>, Vec<String>)> = None;
    let read = async {
        loop {
            match lines.next_line().await {
                Ok(Some(l)) => {
                    let l = l.trim().to_string();
                    if l.starts_with("info ") {
                        if let Some(parsed) = parse_info_line(&l) {
                            last = Some(parsed);
                        }
                    } else if l.starts_with("bestmove") {
                        return Ok(());
                    }
                }
                Ok(None) => return Err("Stockfish closed unexpectedly".to_string()),
                Err(e) => return Err(format!("Read error: {e}")),
            }
        }
    };
    timeout(Duration::from_secs(60), read)
        .await
        .map_err(|_| "Timed out waiting for Stockfish".to_string())??;
    let _ = child.kill().await;

    let (cp_stm, mate_stm, pv) =
        last.ok_or("Stockfish returned no score (terminal position after the move?)")?;
    let mut pv = pv;
    pv.truncate(10); // matches the generator's --refutation-plies default
    Ok(MoveCheck {
        // The opponent is to move after the candidate — negate to mover POV.
        cp_mover: cp_stm.map(|c| -c),
        mate_mover: mate_stm.map(|m| -m),
        pv,
        depth,
    })
}

// ---------------------------------------------------------------------------
// Tauri command layer
// ---------------------------------------------------------------------------

/// Import generator JSONL: either `text` (contents read by the webview file
/// picker) or `file_path` (read here). Same dedup + validation either way.
#[tauri::command]
pub async fn puzzles_import(
    app: tauri::AppHandle,
    text: Option<String>,
    file_path: Option<String>,
    db_path: Option<String>,
) -> Result<PuzzleImportReport, String> {
    let path = resolve_db_path(&app, db_path)?;
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        let content = match file_path.filter(|s| !s.is_empty()) {
            Some(fp) => std::fs::read_to_string(&fp).map_err(|e| format!("read {fp}: {e}"))?,
            None => text.unwrap_or_default(),
        };
        let state = app.state::<DbManager>();
        state.with(&path, |db| db.import_puzzles_jsonl(&content))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn puzzles_deck(
    app: tauri::AppHandle,
    state: tauri::State<'_, DbManager>,
    band: Option<String>,
    theme: Option<String>,
    max_ply: Option<i64>,
    limit: i64,
    db_path: Option<String>,
) -> Result<Vec<PuzzleRow>, String> {
    let path = resolve_db_path(&app, db_path)?;
    state.with(&path, |db| {
        db.puzzles_deck(band.as_deref(), theme.as_deref(), max_ply, limit)
    })
}

#[tauri::command]
pub fn puzzles_get(
    app: tauri::AppHandle,
    state: tauri::State<'_, DbManager>,
    id: i64,
    db_path: Option<String>,
) -> Result<Option<PuzzleRow>, String> {
    let path = resolve_db_path(&app, db_path)?;
    state.with(&path, |db| db.get_puzzle(id))
}

#[tauri::command]
pub fn puzzles_stats(
    app: tauri::AppHandle,
    state: tauri::State<'_, DbManager>,
    db_path: Option<String>,
) -> Result<PuzzleStats, String> {
    let path = resolve_db_path(&app, db_path)?;
    state.with(&path, |db| db.puzzles_stats())
}

/// Grade a candidate move: fixed-depth Stockfish eval of the position after
/// it, mover POV (see `MoveCheck`).
#[tauri::command]
pub async fn puzzle_check_move(
    fen: String,
    uci: String,
    depth: u32,
    stockfish_path: Option<String>,
) -> Result<MoveCheck, String> {
    let sf = stockfish_path
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_STOCKFISH.to_string());
    check_move_impl(&fen, &uci, depth.clamp(1, 30), &sf).await
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Real dry-run output of mine_cliffs.py over the local partial pack
    /// (12 verified puzzles) — the same JSONL shape the server batch produces.
    const CLIFFS: &str = include_str!("../tests/fixtures/cliffs.jsonl");

    #[test]
    fn imports_fixture_jsonl() {
        let mut db = Db::open_in_memory().unwrap();
        let rep = db.import_puzzles_jsonl(CLIFFS).unwrap();
        assert_eq!(rep.imported, 12, "all 12 dry-run puzzles import");
        assert_eq!(rep.dups_skipped, 0);
        assert_eq!(rep.errors, 0);
        let stats = db.puzzles_stats().unwrap();
        assert_eq!(stats.total, 12);
        // Bands present in the dry run: 1900, 2000, 2100, 2200.
        let bands: Vec<&str> = stats.bands.iter().map(|b| b.band.as_str()).collect();
        assert_eq!(bands, vec!["1900", "2000", "2100", "2200"]);
    }

    #[test]
    fn reimport_is_noop() {
        let mut db = Db::open_in_memory().unwrap();
        db.import_puzzles_jsonl(CLIFFS).unwrap();
        let rep = db.import_puzzles_jsonl(CLIFFS).unwrap();
        assert_eq!(rep.imported, 0);
        assert_eq!(rep.dups_skipped, 12);
        assert_eq!(db.puzzles_stats().unwrap().total, 12);
    }

    #[test]
    fn invalid_rows_counted_not_imported() {
        let mut db = Db::open_in_memory().unwrap();
        let bad = concat!(
            "not json at all\n",
            // missing trap_uci
            r#"{"fen": "8/8/8/8/8/8/8/K6k w - - 0 1", "safe_threshold_cp": 50, "engine_verify_depth": 16, "created_at": "t", "refutation_line": ["a1a2"]}"#,
            "\n",
            // illegal trap move
            r#"{"fen": "8/8/8/8/8/8/8/K6k w - - 0 1", "trap_uci": "e2e4", "safe_threshold_cp": 50, "engine_verify_depth": 16, "created_at": "t", "refutation_line": ["a1a2"]}"#,
            "\n",
        );
        let rep = db.import_puzzles_jsonl(bad).unwrap();
        assert_eq!(rep.imported, 0);
        assert_eq!(rep.errors, 3);
    }

    #[test]
    fn deck_filters_by_band_and_tops_up() {
        let mut db = Db::open_in_memory().unwrap();
        db.import_puzzles_jsonl(CLIFFS).unwrap();
        // 2200 has exactly one puzzle in the fixture.
        let only = db.puzzles_deck(Some("2200"), None, None, 1).unwrap();
        assert_eq!(only.len(), 1);
        assert_eq!(only[0].band.as_deref(), Some("2200"));
        // Asking for 5 from a band of 1 tops up from other bands, no dups.
        let deck = db.puzzles_deck(Some("2200"), None, None, 5).unwrap();
        assert_eq!(deck.len(), 5);
        let mut ids: Vec<i64> = deck.iter().map(|p| p.id).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), 5, "top-up never repeats a puzzle");
        assert!(deck.iter().any(|p| p.band.as_deref() == Some("2200")));
    }

    #[test]
    fn deck_without_band_and_over_ask() {
        let mut db = Db::open_in_memory().unwrap();
        db.import_puzzles_jsonl(CLIFFS).unwrap();
        let deck = db.puzzles_deck(None, None, None, 50).unwrap();
        assert_eq!(deck.len(), 12, "asking beyond the table returns all rows");
    }

    #[test]
    fn opening_deck_is_a_hard_filter() {
        let mut db = Db::open_in_memory().unwrap();
        db.import_puzzles_jsonl(CLIFFS).unwrap();
        // Exactly one fixture row is an opening rake (ply 14, band 1900).
        let deck = db
            .puzzles_deck(None, None, Some(OPENING_MAX_PLY), 50)
            .unwrap();
        assert_eq!(deck.len(), 1, "the ply cap never tops up past itself");
        assert_eq!(deck[0].ply, Some(14));
        // The band top-up respects the cap too: asking 1900-band openers
        // for 5 still yields only the one qualifying row.
        let banded = db
            .puzzles_deck(Some("1900"), None, Some(OPENING_MAX_PLY), 5)
            .unwrap();
        assert_eq!(banded.len(), 1);
        assert_eq!(banded[0].band.as_deref(), Some("1900"));
        // And the stats surface the opening pool size for the deck picker.
        assert_eq!(db.puzzles_stats().unwrap().opening, 1);
    }

    #[test]
    fn get_puzzle_roundtrips_fields() {
        let mut db = Db::open_in_memory().unwrap();
        db.import_puzzles_jsonl(CLIFFS).unwrap();
        let deck = db.puzzles_deck(Some("2200"), None, None, 1).unwrap();
        let p = db.get_puzzle(deck[0].id).unwrap().unwrap();
        assert_eq!(p.fen, "r1b1kb1r/3n1ppp/p3pn2/1p6/2NPq3/3B1N2/PP3PPP/R1BQ1RK1 b kq - 1 11");
        assert_eq!(p.trap_uci, "e4g4");
        assert_eq!(p.trap_san.as_deref(), Some("Qg4"));
        assert_eq!(p.safe_threshold, 50);
        assert_eq!(p.engine_verify_depth, 16);
        assert_eq!(p.refutation_line.len(), 10);
        assert_eq!(p.refutation_line[0], "c4e5");
        assert!(!p.mate);
        assert!(p.themes.is_empty(), "Tier-1 rows carry no themes");
        assert!(p.band_miss_rates.is_none(), "Tier-2 field stays NULL");
        assert!(db.get_puzzle(999_999).unwrap().is_none());
    }

    // Real-engine check on the first dry-run puzzle: the trap move must grade
    // as clearly losing (the generator verified ~-317cp at depth 16; depth 12
    // here keeps the test fast and the sign unambiguous), and a safe
    // developing move must grade near the verified best. Requires the
    // Homebrew Stockfish, like the other real_stockfish tests.
    #[tokio::test]
    async fn real_stockfish_check_move_trap_vs_safe() {
        let fen = "r1b2rk1/pp3ppp/2p5/4n3/4P3/2N3P1/PP2BPP1/R3R1K1 b - - 2 19";
        let trap = check_move_impl(fen, "c8e6", 12, DEFAULT_STOCKFISH)
            .await
            .unwrap();
        let cp = trap.cp_mover.expect("cp score for the trap");
        assert!(cp <= -150, "trap grades as a cliff, got {cp}");
        assert!(!trap.pv.is_empty(), "refutation PV comes back for the replay");

        let safe = check_move_impl(fen, "g7g6", 12, DEFAULT_STOCKFISH)
            .await
            .unwrap();
        let cp = safe.cp_mover.expect("cp score for the safe move");
        // Verified best pre-move was -19cp; Rad8 must stay within the safe
        // window (generous slack for the lower test depth).
        assert!(cp >= -80, "safe move stays near best, got {cp}");
    }

    #[tokio::test]
    async fn check_move_rejects_illegal_candidate() {
        let err = check_move_impl("8/8/8/8/8/8/8/K6k w - - 0 1", "e2e4", 8, DEFAULT_STOCKFISH)
            .await
            .unwrap_err();
        assert!(err.contains("illegal move"), "got: {err}");
    }

    #[test]
    fn info_line_parses_cp_mate_and_pv() {
        let (cp, mate, pv) = parse_info_line(
            "info depth 16 seldepth 24 score cp -317 nodes 1 pv f2f4 e5d7 f4f5",
        )
        .unwrap();
        assert_eq!(cp, Some(-317));
        assert_eq!(mate, None);
        assert_eq!(pv, vec!["f2f4", "e5d7", "f4f5"]);
        let (cp, mate, _) =
            parse_info_line("info depth 10 score mate 3 nodes 5 pv e2e4").unwrap();
        assert_eq!(cp, None);
        assert_eq!(mate, Some(3));
        assert!(parse_info_line("info depth 3 currmove e2e4").is_none());
    }
}
