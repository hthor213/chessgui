//! Out-of-process material-signature backfill for ChessGUI's games.db.
//!
//! The in-app v4 backfill was removed from the Db::open path after it hung
//! the desktop app: replaying ~1M pre-v4 games in one transaction pegged a
//! core for tens of minutes and every force-quit rolled the work back. This
//! tool does the same job where it belongs — off the laptop, in committed
//! batches, resumable from wherever it stopped.
//!
//! Intended flow (laptop DB, homeserver compute):
//!   1. snapshot games.db and copy it to the homeserver
//!   2. `material-backfill backfill snapshot.db` there (CPU-quota'd)
//!   3. `material-backfill export snapshot.db sigs.tsv` (works mid-run)
//!   4. copy sigs.tsv back and `material-backfill import games.db sigs.tsv`
//!      on the laptop — rows join on games.dup_hash, so it's safe even if
//!      game ids shifted, and INSERT OR IGNORE makes re-imports free.
//!
//! The signature logic is duplicated from
//! apps/desktop/src-tauri/src/db.rs (material_signature,
//! replay_material_sigs, the '' sentinel for unreplayable games) — keep the
//! two in sync.

use std::io::{BufRead, BufReader, BufWriter, Write};
use std::time::Instant;

use rusqlite::{params, Connection};
use shakmaty::packed::PackedUciMove;
use shakmaty::{Chess, Color, Move, Position, Role};

const DEFAULT_BATCH: usize = 1000;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let usage = "usage: material-backfill <backfill|export|import> <db> [file] [--batch N]";
    if args.len() < 3 {
        eprintln!("{usage}");
        std::process::exit(2);
    }
    let cmd = args[1].as_str();
    let db_path = args[2].as_str();
    let batch = args
        .iter()
        .position(|a| a == "--batch")
        .and_then(|i| args.get(i + 1))
        .and_then(|v| v.parse().ok())
        .unwrap_or(DEFAULT_BATCH);
    let result = match cmd {
        "backfill" => backfill(db_path, batch),
        "export" => export(db_path, args.get(3).map(String::as_str).unwrap_or("sigs.tsv")),
        "import" => match args.get(3) {
            Some(file) => import(db_path, file, batch),
            None => {
                eprintln!("import needs a TSV file argument\n{usage}");
                std::process::exit(2);
            }
        },
        _ => {
            eprintln!("{usage}");
            std::process::exit(2);
        }
    };
    if let Err(e) = result {
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}

fn open(db_path: &str) -> rusqlite::Result<Connection> {
    let conn = Connection::open(db_path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    // The laptop import runs while the app may hold the DB; wait, don't fail.
    conn.busy_timeout(std::time::Duration::from_secs(30))?;
    Ok(conn)
}

/// Index up to `limit` un-indexed games in one committed transaction.
/// Returns games processed; 0 = caught up. Mirrors Db::backfill_material_batch.
fn backfill_batch(conn: &mut Connection, limit: usize) -> rusqlite::Result<usize> {
    let tx = conn.transaction()?;
    let processed;
    {
        let mut stmt = tx.prepare_cached(
            "SELECT id, moves FROM games g WHERE NOT EXISTS \
             (SELECT 1 FROM game_material m WHERE m.game_id = g.id) LIMIT ?1",
        )?;
        let rows: Vec<(i64, Vec<u8>)> = stmt
            .query_map([limit], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<Result<_, _>>()?;
        processed = rows.len();
        let mut ins = tx.prepare_cached(
            "INSERT OR IGNORE INTO game_material (game_id, signature) VALUES (?1, ?2)",
        )?;
        for (id, moves) in rows {
            match replay_material_sigs(&moves) {
                Some(sigs) => {
                    for sig in sigs {
                        ins.execute(params![id, sig])?;
                    }
                }
                // Unreplayable (FEN-start / corrupt): sentinel so the game
                // stops counting as un-indexed and batches always progress.
                None => {
                    ins.execute(params![id, ""])?;
                }
            }
        }
    }
    tx.commit()?;
    Ok(processed)
}

fn backfill(db_path: &str, batch: usize) -> rusqlite::Result<()> {
    let mut conn = open(db_path)?;
    let total: i64 = conn.query_row(
        "SELECT COUNT(*) FROM games g WHERE NOT EXISTS \
         (SELECT 1 FROM game_material m WHERE m.game_id = g.id)",
        [],
        |r| r.get(0),
    )?;
    println!("{total} games to index (batch = {batch}, committed per batch)");
    let started = Instant::now();
    let mut done: i64 = 0;
    loop {
        let n = backfill_batch(&mut conn, batch)? as i64;
        if n == 0 {
            break;
        }
        done += n;
        let rate = done as f64 / started.elapsed().as_secs_f64().max(0.001);
        println!(
            "{done}/{total} ({:.1}%) — {rate:.0} games/s",
            100.0 * done as f64 / total.max(1) as f64
        );
    }
    println!("caught up: {done} games indexed in {:.0}s", started.elapsed().as_secs_f64());
    Ok(())
}

/// Dump (dup_hash, signature) TSV — the portable form of game_material.
/// Safe to run while a backfill is in progress; you just get what's done.
fn export(db_path: &str, out_path: &str) -> rusqlite::Result<()> {
    let conn = open(db_path)?;
    let mut out = BufWriter::new(
        std::fs::File::create(out_path)
            .unwrap_or_else(|e| panic!("cannot create {out_path}: {e}")),
    );
    let mut stmt = conn.prepare(
        "SELECT g.dup_hash, m.signature FROM game_material m \
         JOIN games g ON g.id = m.game_id",
    )?;
    let mut rows = stmt.query([])?;
    let mut n: u64 = 0;
    while let Some(row) = rows.next()? {
        let hash: String = row.get(0)?;
        let sig: String = row.get(1)?;
        writeln!(out, "{hash}\t{sig}").expect("write failed");
        n += 1;
    }
    out.flush().expect("flush failed");
    println!("exported {n} rows to {out_path}");
    Ok(())
}

/// Merge a (dup_hash, signature) TSV into game_material, joining on
/// games.dup_hash (stable across databases; ids are not). Batched commits,
/// INSERT OR IGNORE — rerunning or importing partial exports is free.
fn import(db_path: &str, in_path: &str, batch: usize) -> rusqlite::Result<()> {
    let conn = open(db_path)?;
    let file = std::fs::File::open(in_path)
        .unwrap_or_else(|e| panic!("cannot open {in_path}: {e}"));
    let mut inserted: u64 = 0;
    let mut unmatched: u64 = 0;
    let mut in_batch: usize = 0;
    conn.execute_batch("BEGIN")?;
    {
        let mut ins = conn.prepare_cached(
            "INSERT OR IGNORE INTO game_material (game_id, signature) \
             SELECT id, ?2 FROM games WHERE dup_hash = ?1",
        )?;
        for line in BufReader::new(file).lines() {
            let line = line.expect("read failed");
            let Some((hash, sig)) = line.split_once('\t') else { continue };
            let n = ins.execute(params![hash, sig])?;
            if n == 0 {
                unmatched += 1; // duplicate row, or game absent in this DB
            } else {
                inserted += n as u64;
            }
            in_batch += 1;
            if in_batch >= batch {
                conn.execute_batch("COMMIT; BEGIN")?;
                in_batch = 0;
            }
        }
    }
    conn.execute_batch("COMMIT")?;
    println!("imported {inserted} rows ({unmatched} already present or unmatched)");
    Ok(())
}

// ---------------------------------------------------------------------------
// Duplicated from apps/desktop/src-tauri/src/db.rs — keep in sync.
// ---------------------------------------------------------------------------

/// Material signature of a position: per side "K" then "Q"/"R"/"B"/"N"/"P"
/// repeated per piece on the board, White's half first — e.g. "KRPKR".
fn material_signature(pos: &Chess) -> String {
    let board = pos.board();
    let mut out = String::new();
    for color in [Color::White, Color::Black] {
        for (role, ch) in [
            (Role::King, 'K'),
            (Role::Queen, 'Q'),
            (Role::Rook, 'R'),
            (Role::Bishop, 'B'),
            (Role::Knight, 'N'),
            (Role::Pawn, 'P'),
        ] {
            let n = (board.by_color(color) & board.by_role(role)).count();
            for _ in 0..n {
                out.push(ch);
            }
        }
    }
    out
}

fn is_capture(m: &Move) -> bool {
    m.is_capture() || m.is_en_passant()
}

/// Replay a packed mainline from the standard start and collect the distinct
/// material signatures reached. `None` if any move fails to apply.
fn replay_material_sigs(packed_moves: &[u8]) -> Option<Vec<String>> {
    let mut pos = Chess::default();
    let mut sigs = vec![material_signature(&pos)];
    for c in packed_moves.chunks_exact(PackedUciMove::BYTES) {
        let uci = PackedUciMove::from_bytes([c[0], c[1]]).unpack();
        let m = uci.to_move(&pos).ok()?;
        let material_changed = is_capture(&m) || m.is_promotion();
        pos.play_unchecked(m);
        if material_changed {
            let sig = material_signature(&pos);
            if sigs.last() != Some(&sig) {
                sigs.push(sig);
            }
        }
    }
    Some(sigs)
}
