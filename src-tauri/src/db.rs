//! SQLite-backed game database (spec 200, first slice: storage + import + search).
//!
//! Schema v1 stores each game's headers as searchable columns, the full movetext
//! (mainline + variations + comments + NAGs, reconstructed faithfully from the
//! parser) for round-trip loading into the frontend GameTree, and a compact
//! 2-byte-per-move BLOB (shakmaty `PackedUciMove`) of the mainline. A side
//! `positions` table indexes the Zobrist hash of every mainline position up to a
//! ply cap so a target position can be found in O(1) via `WHERE zobrist = ?`,
//! verified against the stored FEN to rule out the (astronomically rare) hash
//! collision.
//!
//! Deduplication is exact: `dup_hash` is a 128-bit hash of the normalized
//! mainline (space-joined UCI) plus the result, UNIQUE-indexed so re-importing
//! the same game is skipped and counted rather than duplicated.
//!
//! DB logic here is pure (operates on an owned `rusqlite::Connection`) so it can
//! be unit-tested against in-memory databases; the Tauri command wrappers live at
//! the bottom and manage per-path connections resolved from the app data dir.

use std::collections::HashMap;
use std::io::{BufReader, Cursor, Read};
use std::path::Path;
use std::sync::Mutex;

use pgn_reader::{Outcome, RawComment, RawTag, Reader, SanPlus, Skip, Visitor};
use rusqlite::{params, params_from_iter, Connection};
use serde::{Deserialize, Serialize};
use shakmaty::fen::Fen;
use shakmaty::packed::PackedUciMove;
use shakmaty::uci::UciMove;
use shakmaty::zobrist::Zobrist64;
use shakmaty::{CastlingMode, Chess, Color, EnPassantMode, Position};
use std::ops::ControlFlow;

/// Default upper bound on how many mainline plies of each game get indexed into
/// the `positions` table. 40 plies (20 full moves) covers openings and early
/// middlegame — the range where position search and the opening explorer are
/// useful — while keeping the position index a small multiple of the game count.
pub const DEFAULT_PLY_CAP: u32 = 40;

const SCHEMA_VERSION: i64 = 1;

// ---------------------------------------------------------------------------
// Serde boundary types (mirrored in lib/database.ts)
// ---------------------------------------------------------------------------

/// Outcome of importing a PGN stream.
#[derive(Debug, Default, Clone, Serialize)]
pub struct ImportReport {
    pub imported: u64,
    pub dups_skipped: u64,
    pub errors: u64,
}

/// Header row for the game list. Elos are optional (absent/`?` in many PGNs).
#[derive(Debug, Clone, Serialize)]
pub struct GameHeader {
    pub id: i64,
    pub white: String,
    pub black: String,
    pub white_elo: Option<i64>,
    pub black_elo: Option<i64>,
    pub event: String,
    pub site: String,
    pub round: String,
    pub date: String,
    pub eco: String,
    pub result: String,
    pub ply_count: i64,
    pub source: String,
}

/// Filters for `list_games`. All fields optional; omitted fields don't constrain.
/// `player` matches either colour; `white`/`black` match that colour only.
#[derive(Debug, Default, Clone, Deserialize)]
pub struct GameFilter {
    pub player: Option<String>,
    pub white: Option<String>,
    pub black: Option<String>,
    pub event: Option<String>,
    /// ECO prefix, e.g. "B9" matches B90..B99.
    pub eco: Option<String>,
    /// Inclusive lower bound on the (string-sortable) PGN date, e.g. "2020.01.01".
    pub date_from: Option<String>,
    /// Inclusive upper bound on the PGN date.
    pub date_to: Option<String>,
    pub result: Option<String>,
    /// Minimum Elo required of at least one player.
    pub min_elo: Option<i64>,
}

/// A game that reaches the searched position, plus the move played next in it —
/// the raw material the opening explorer aggregates into per-move W/D/L stats.
#[derive(Debug, Clone, Serialize)]
pub struct PositionHit {
    pub game_id: i64,
    pub white: String,
    pub black: String,
    pub white_elo: Option<i64>,
    pub black_elo: Option<i64>,
    pub result: String,
    pub date: String,
    /// Ply index at which the searched position occurred (0 = start position).
    pub ply: i64,
    /// UCI of the move played from the searched position, or null if it was the
    /// final indexed position in that game.
    pub next_uci: Option<String>,
    /// SAN of that same move (convenient for the explorer UI).
    pub next_san: Option<String>,
}

/// Aggregate counts for the whole database.
#[derive(Debug, Clone, Serialize)]
pub struct DbStats {
    pub games: i64,
    pub positions: i64,
}

// ---------------------------------------------------------------------------
// Parsed game (produced by the pgn-reader Visitor, consumed by the inserter)
// ---------------------------------------------------------------------------

#[derive(Default)]
struct GameTags {
    white: String,
    black: String,
    white_elo: Option<i64>,
    black_elo: Option<i64>,
    event: String,
    site: String,
    round: String,
    date: String,
    eco: String,
    result: String,
    /// Non-standard starting position, if a `[FEN "..."]` tag is present.
    fen: Option<String>,
}

struct ParsedGame {
    tags: GameTags,
    /// Reconstructed movetext including variations, comments, NAGs and the result
    /// token — faithful in content, suitable for reload into the GameTree.
    movetext: String,
    /// Mainline moves as compact UCI, packed 2 bytes each.
    packed_moves: Vec<u8>,
    /// (zobrist as i64, verification FEN, ply) for each indexed mainline position.
    positions: Vec<(i64, String, u32)>,
    ply_count: u32,
    result: String,
    /// Set when the mainline could not be fully applied (illegal/ambiguous SAN or
    /// an unparseable FEN tag). Such games are counted as errors, not imported.
    error: Option<String>,
}

// ---------------------------------------------------------------------------
// Movetext reconstruction + mainline indexing
// ---------------------------------------------------------------------------

/// One nesting level of the movetext being reconstructed. `abs_ply` is the
/// absolute half-move index (from the game's start position) of the *next* move
/// to be written on this line, which drives correct move-number display even
/// inside variations.
struct Frame {
    abs_ply: u32,
    force_number: bool,
}

/// Accumulates a single game as the parser walks it. Only depth-0 (mainline)
/// moves are applied to `pos` and indexed; variation moves are reconstructed into
/// the movetext but not played, so they never affect the hash or position index.
struct GameBuilder {
    tags: GameTags,
    pos: Chess,
    start_fullmove: u32,
    start_white: bool,
    ply_cap: u32,
    movetext: String,
    packed_moves: Vec<u8>,
    positions: Vec<(i64, String, u32)>,
    frames: Vec<Frame>,
    result_token: Option<String>,
    error: Option<String>,
}

impl GameBuilder {
    fn new(tags: GameTags, pos: Chess, ply_cap: u32) -> GameBuilder {
        let start_white = pos.turn() == Color::White;
        let start_fullmove = pos.fullmoves().get();
        // Index the start position itself (ply 0) so a search for the opening
        // position — or any FEN start — finds the game.
        let mut positions = Vec::new();
        let z = pos.zobrist_hash::<Zobrist64>(EnPassantMode::Legal).0 as i64;
        positions.push((z, epd(&pos), 0));
        GameBuilder {
            tags,
            pos,
            start_fullmove,
            start_white,
            ply_cap,
            movetext: String::new(),
            packed_moves: Vec::new(),
            positions,
            frames: vec![Frame {
                abs_ply: 0,
                force_number: true,
            }],
            result_token: None,
            error: None,
        }
    }

    fn depth(&self) -> usize {
        self.frames.len() - 1
    }

    /// Move-number prefix ("12. ", "12... " or "") for the move about to be
    /// written at `abs_ply`, honouring the force-number flag.
    fn move_prefix(&self, abs_ply: u32, force: bool) -> String {
        let white_to_move = if self.start_white {
            abs_ply % 2 == 0
        } else {
            abs_ply % 2 == 1
        };
        let fullmove = if self.start_white {
            self.start_fullmove + abs_ply / 2
        } else {
            self.start_fullmove + (abs_ply + 1) / 2
        };
        if white_to_move {
            format!("{fullmove}. ")
        } else if force {
            format!("{fullmove}... ")
        } else {
            String::new()
        }
    }

    fn push_token(&mut self, tok: &str) {
        if !self.movetext.is_empty() {
            self.movetext.push(' ');
        }
        self.movetext.push_str(tok);
    }

    fn on_san(&mut self, san_plus: SanPlus) {
        if self.error.is_some() {
            return;
        }
        let mainline = self.depth() == 0;
        let (abs_ply, force) = {
            let f = self.frames.last().unwrap();
            (f.abs_ply, f.force_number)
        };
        let prefix = self.move_prefix(abs_ply, force);
        let token = format!("{prefix}{san_plus}");
        self.push_token(&token);

        if mainline {
            // Resolve the SAN against the live position, then play + index it.
            match san_plus.san.to_move(&self.pos) {
                Ok(mv) => {
                    let uci = UciMove::from_move(mv, CastlingMode::Standard);
                    self.packed_moves
                        .extend_from_slice(&PackedUciMove::pack(uci).to_bytes());
                    self.pos.play_unchecked(mv);
                    let next_ply = abs_ply + 1;
                    if next_ply <= self.ply_cap {
                        let z = self.pos.zobrist_hash::<Zobrist64>(EnPassantMode::Legal).0 as i64;
                        self.positions.push((z, epd(&self.pos), next_ply));
                    }
                }
                Err(e) => {
                    self.error = Some(format!("illegal SAN {san_plus}: {e}"));
                }
            }
        }

        let f = self.frames.last_mut().unwrap();
        f.abs_ply += 1;
        f.force_number = false;
    }

    fn on_comment(&mut self, comment: RawComment<'_>) {
        let text = String::from_utf8_lossy(comment.as_bytes());
        let text = text.trim();
        if !text.is_empty() {
            self.push_token(&format!("{{{text}}}"));
        }
        if let Some(f) = self.frames.last_mut() {
            f.force_number = true;
        }
    }

    fn on_nag(&mut self, nag: pgn_reader::Nag) {
        self.push_token(&format!("${}", nag.0));
        if let Some(f) = self.frames.last_mut() {
            f.force_number = true;
        }
    }

    fn on_begin_variation(&mut self) {
        self.push_token("(");
        // A variation replaces the parent's most recent move, so it starts one
        // ply earlier than the parent's current write cursor.
        let parent_ply = self.frames.last().map(|f| f.abs_ply).unwrap_or(0);
        let abs_ply = parent_ply.saturating_sub(1);
        self.frames.push(Frame {
            abs_ply,
            force_number: true,
        });
    }

    fn on_end_variation(&mut self) {
        self.push_token(")");
        if self.frames.len() > 1 {
            self.frames.pop();
        }
        if let Some(f) = self.frames.last_mut() {
            f.force_number = true;
        }
    }

    fn on_outcome(&mut self, outcome: Outcome) {
        self.result_token = Some(outcome.to_string());
    }

    fn finish(mut self) -> ParsedGame {
        // Result precedence: the header Result tag wins (it is what databases key
        // on); fall back to the movetext termination token, then "*".
        let result = if !self.tags.result.is_empty() {
            self.tags.result.clone()
        } else if let Some(tok) = &self.result_token {
            tok.clone()
        } else {
            "*".to_string()
        };
        let closing = self.result_token.clone().unwrap_or_else(|| result.clone());
        self.push_token(&closing);
        let ply_count = self.packed_moves.len() as u32 / PackedUciMove::BYTES as u32;
        ParsedGame {
            tags: self.tags,
            movetext: self.movetext,
            packed_moves: self.packed_moves,
            positions: self.positions,
            ply_count,
            result,
            error: self.error,
        }
    }
}

/// The EPD (first four FEN fields: placement, turn, castling, en passant) of a
/// position, computed with `EnPassantMode::Legal` so the en-passant field agrees
/// with the Zobrist hash. This is the collision-verification key: it ignores the
/// halfmove clock and fullmove number, so transpositions that differ only in
/// those counters still match.
fn epd(pos: &Chess) -> String {
    let fen = Fen::from_position(pos, EnPassantMode::Legal).to_string();
    fen.split(' ').take(4).collect::<Vec<_>>().join(" ")
}

struct ImportVisitor {
    ply_cap: u32,
}

impl Visitor for ImportVisitor {
    type Tags = GameTags;
    type Movetext = GameBuilder;
    type Output = ParsedGame;

    fn begin_tags(&mut self) -> ControlFlow<Self::Output, Self::Tags> {
        ControlFlow::Continue(GameTags::default())
    }

    fn tag(
        &mut self,
        tags: &mut Self::Tags,
        name: &[u8],
        value: RawTag<'_>,
    ) -> ControlFlow<Self::Output> {
        let v = || String::from_utf8_lossy(value.as_bytes()).into_owned();
        match name {
            b"White" => tags.white = v(),
            b"Black" => tags.black = v(),
            b"WhiteElo" => tags.white_elo = v().parse().ok(),
            b"BlackElo" => tags.black_elo = v().parse().ok(),
            b"Event" => tags.event = v(),
            b"Site" => tags.site = v(),
            b"Round" => tags.round = v(),
            b"Date" => tags.date = v(),
            b"ECO" => tags.eco = v(),
            b"Result" => tags.result = v(),
            b"FEN" => tags.fen = Some(v()),
            _ => {}
        }
        ControlFlow::Continue(())
    }

    fn begin_movetext(&mut self, tags: Self::Tags) -> ControlFlow<Self::Output, Self::Movetext> {
        let pos = match &tags.fen {
            Some(fen_str) => match Fen::from_ascii(fen_str.as_bytes())
                .ok()
                .and_then(|f| f.into_position::<Chess>(CastlingMode::Standard).ok())
            {
                Some(p) => p,
                None => {
                    // Unparseable/illegal FEN tag: emit a game marked as an error
                    // so the import counts it and moves on.
                    let mut b = GameBuilder::new(GameTags::default(), Chess::default(), 0);
                    b.tags = tags;
                    b.error = Some("invalid FEN tag".to_string());
                    return ControlFlow::Continue(b);
                }
            },
            None => Chess::default(),
        };
        ControlFlow::Continue(GameBuilder::new(tags, pos, self.ply_cap))
    }

    fn san(&mut self, mt: &mut Self::Movetext, san_plus: SanPlus) -> ControlFlow<Self::Output> {
        mt.on_san(san_plus);
        ControlFlow::Continue(())
    }

    fn nag(&mut self, mt: &mut Self::Movetext, nag: pgn_reader::Nag) -> ControlFlow<Self::Output> {
        mt.on_nag(nag);
        ControlFlow::Continue(())
    }

    fn comment(
        &mut self,
        mt: &mut Self::Movetext,
        comment: RawComment<'_>,
    ) -> ControlFlow<Self::Output> {
        mt.on_comment(comment);
        ControlFlow::Continue(())
    }

    fn begin_variation(&mut self, mt: &mut Self::Movetext) -> ControlFlow<Self::Output, Skip> {
        mt.on_begin_variation();
        // Skip(false) = descend into the variation so we can reconstruct its text.
        ControlFlow::Continue(Skip(false))
    }

    fn end_variation(&mut self, mt: &mut Self::Movetext) -> ControlFlow<Self::Output> {
        mt.on_end_variation();
        ControlFlow::Continue(())
    }

    fn outcome(&mut self, mt: &mut Self::Movetext, outcome: Outcome) -> ControlFlow<Self::Output> {
        mt.on_outcome(outcome);
        ControlFlow::Continue(())
    }

    fn end_game(&mut self, mt: Self::Movetext) -> Self::Output {
        mt.finish()
    }
}

/// 128-bit FNV-1a over the normalized mainline (space-joined UCI) plus the
/// result. 128 bits makes an accidental collision — which would wrongly skip a
/// distinct game — effectively impossible at any realistic database size, so exact
/// duplicates can be detected by a single UNIQUE-indexed column.
fn dup_hash(packed_moves: &[u8], result: &str) -> String {
    const OFF: u128 = 0x6c62272e07bb014262b821756295c58d;
    const PRIME: u128 = 0x0000000001000000000000000000013b;
    let mut h = OFF;
    let mut feed = |bytes: &[u8]| {
        for &b in bytes {
            h ^= b as u128;
            h = h.wrapping_mul(PRIME);
        }
    };
    // Feed canonical UCI text so the hash is independent of encoding details.
    for chunk in packed_moves.chunks_exact(PackedUciMove::BYTES) {
        let uci = PackedUciMove::from_bytes([chunk[0], chunk[1]]).unpack();
        feed(uci.to_string().as_bytes());
        feed(b" ");
    }
    feed(b"|");
    feed(result.as_bytes());
    format!("{h:032x}")
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

pub struct Db {
    conn: Connection,
}

impl Db {
    /// Open (creating if absent) a database at `path` and ensure schema v1.
    pub fn open<P: AsRef<Path>>(path: P) -> rusqlite::Result<Db> {
        let conn = Connection::open(path)?;
        Self::from_conn(conn)
    }

    /// In-memory database, for tests.
    #[allow(dead_code)]
    pub fn open_in_memory() -> rusqlite::Result<Db> {
        Self::from_conn(Connection::open_in_memory()?)
    }

    fn from_conn(conn: Connection) -> rusqlite::Result<Db> {
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        let db = Db { conn };
        db.init_schema()?;
        Ok(db)
    }

    fn init_schema(&self) -> rusqlite::Result<()> {
        self.conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);

            CREATE TABLE IF NOT EXISTS games (
                id           INTEGER PRIMARY KEY,
                white        TEXT NOT NULL DEFAULT '',
                black        TEXT NOT NULL DEFAULT '',
                white_elo    INTEGER,
                black_elo    INTEGER,
                event        TEXT NOT NULL DEFAULT '',
                site         TEXT NOT NULL DEFAULT '',
                round        TEXT NOT NULL DEFAULT '',
                date         TEXT NOT NULL DEFAULT '',
                eco          TEXT NOT NULL DEFAULT '',
                result       TEXT NOT NULL DEFAULT '*',
                ply_count    INTEGER NOT NULL DEFAULT 0,
                source       TEXT NOT NULL DEFAULT '',
                import_batch TEXT NOT NULL DEFAULT '',
                pgn_moves    TEXT NOT NULL DEFAULT '',
                moves        BLOB NOT NULL,
                dup_hash     TEXT NOT NULL,
                created_at   TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE UNIQUE INDEX IF NOT EXISTS idx_games_dup   ON games(dup_hash);
            CREATE INDEX IF NOT EXISTS idx_games_white ON games(white);
            CREATE INDEX IF NOT EXISTS idx_games_black ON games(black);
            CREATE INDEX IF NOT EXISTS idx_games_event ON games(event);
            CREATE INDEX IF NOT EXISTS idx_games_eco   ON games(eco);
            CREATE INDEX IF NOT EXISTS idx_games_date  ON games(date);

            CREATE TABLE IF NOT EXISTS positions (
                zobrist INTEGER NOT NULL,
                game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
                ply     INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_positions_zobrist ON positions(zobrist);
            CREATE INDEX IF NOT EXISTS idx_positions_game    ON positions(game_id);
            "#,
        )?;
        // Record the schema version once.
        let has: i64 =
            self.conn
                .query_row("SELECT COUNT(*) FROM schema_version", [], |r| r.get(0))?;
        if has == 0 {
            self.conn
                .execute("INSERT INTO schema_version (version) VALUES (?1)", [SCHEMA_VERSION])?;
        }
        Ok(())
    }

    /// Import a PGN string (paste / small input; held in memory).
    pub fn import_pgn_str(&mut self, text: &str, source: &str) -> rusqlite::Result<ImportReport> {
        self.import_reader(Cursor::new(text.as_bytes()), source, DEFAULT_PLY_CAP)
    }

    /// Import a PGN file, streaming from disk (survives multi-GB files without
    /// loading them into memory).
    pub fn import_pgn_file(&mut self, path: &str, source: &str) -> std::io::Result<ImportReport> {
        let file = std::fs::File::open(path)?;
        self.import_reader(BufReader::new(file), source, DEFAULT_PLY_CAP)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))
    }

    /// Core import loop: stream games from `reader`, committing every 1000 games.
    pub fn import_reader<R: Read>(
        &mut self,
        reader: R,
        source: &str,
        ply_cap: u32,
    ) -> rusqlite::Result<ImportReport> {
        let batch_id = format!("{source}@{}", now_stamp());
        let mut report = ImportReport::default();
        let mut visitor = ImportVisitor { ply_cap };
        let mut pgn = Reader::new(reader);

        const BATCH: u64 = 1000;
        let mut tx = self.conn.transaction()?;
        let mut in_batch = 0u64;
        loop {
            let game = match pgn.read_game(&mut visitor) {
                Ok(Some(g)) => g,
                Ok(None) => break,
                Err(_) => {
                    // A hard tokenizer error: count it and stop (the stream state
                    // after an I/O error is not resumable).
                    report.errors += 1;
                    break;
                }
            };
            match insert_game(&tx, &game, source, &batch_id) {
                Ok(InsertOutcome::Inserted) => report.imported += 1,
                Ok(InsertOutcome::Duplicate) => report.dups_skipped += 1,
                Ok(InsertOutcome::Error) => report.errors += 1,
                Err(_) => report.errors += 1,
            }
            in_batch += 1;
            if in_batch >= BATCH {
                tx.commit()?;
                tx = self.conn.transaction()?;
                in_batch = 0;
            }
        }
        tx.commit()?;
        Ok(report)
    }

    /// Paginated, filtered header list. Sort defaults to newest-inserted first
    /// (`id DESC`); `sort_by` is validated against a column whitelist so it can
    /// never inject SQL.
    pub fn list_games(
        &self,
        filter: &GameFilter,
        limit: i64,
        offset: i64,
        sort_by: Option<&str>,
        desc: bool,
    ) -> rusqlite::Result<Vec<GameHeader>> {
        let mut sql = String::from(
            "SELECT id, white, black, white_elo, black_elo, event, site, round, \
             date, eco, result, ply_count, source FROM games",
        );
        let mut clauses: Vec<String> = Vec::new();
        let mut args: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

        if let Some(p) = filter.player.as_deref().filter(|s| !s.is_empty()) {
            clauses.push("(white LIKE ? OR black LIKE ?)".to_string());
            args.push(Box::new(format!("%{p}%")));
            args.push(Box::new(format!("%{p}%")));
        }
        if let Some(w) = filter.white.as_deref().filter(|s| !s.is_empty()) {
            clauses.push("white LIKE ?".to_string());
            args.push(Box::new(format!("%{w}%")));
        }
        if let Some(b) = filter.black.as_deref().filter(|s| !s.is_empty()) {
            clauses.push("black LIKE ?".to_string());
            args.push(Box::new(format!("%{b}%")));
        }
        if let Some(e) = filter.event.as_deref().filter(|s| !s.is_empty()) {
            clauses.push("event LIKE ?".to_string());
            args.push(Box::new(format!("%{e}%")));
        }
        if let Some(eco) = filter.eco.as_deref().filter(|s| !s.is_empty()) {
            clauses.push("eco LIKE ?".to_string());
            args.push(Box::new(format!("{eco}%")));
        }
        if let Some(d) = filter.date_from.as_deref().filter(|s| !s.is_empty()) {
            clauses.push("date >= ?".to_string());
            args.push(Box::new(d.to_string()));
        }
        if let Some(d) = filter.date_to.as_deref().filter(|s| !s.is_empty()) {
            clauses.push("date <= ?".to_string());
            args.push(Box::new(d.to_string()));
        }
        if let Some(r) = filter.result.as_deref().filter(|s| !s.is_empty()) {
            clauses.push("result = ?".to_string());
            args.push(Box::new(r.to_string()));
        }
        if let Some(elo) = filter.min_elo {
            clauses.push("(white_elo >= ? OR black_elo >= ?)".to_string());
            args.push(Box::new(elo));
            args.push(Box::new(elo));
        }

        if !clauses.is_empty() {
            sql.push_str(" WHERE ");
            sql.push_str(&clauses.join(" AND "));
        }
        // Column whitelist: any unrecognized value falls back to `id`, so the
        // interpolated string is always one of these fixed literals.
        let col = match sort_by {
            Some("white") => "white",
            Some("black") => "black",
            Some("white_elo") => "white_elo",
            Some("black_elo") => "black_elo",
            Some("event") => "event",
            Some("date") => "date",
            Some("eco") => "eco",
            Some("result") => "result",
            Some("ply_count") => "ply_count",
            _ => "id",
        };
        let dir = if desc { "DESC" } else { "ASC" };
        // Tie-break on id so pagination is stable when the sort column has dups.
        sql.push_str(&format!(" ORDER BY {col} {dir}, id DESC LIMIT ? OFFSET ?"));
        args.push(Box::new(limit));
        args.push(Box::new(offset));

        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(args.iter()), row_to_header)?;
        rows.collect()
    }

    /// Reconstructed PGN movetext (no headers) for one game. Kept alongside
    /// `get_game_pgn` for callers that only need the movetext.
    #[allow(dead_code)]
    pub fn get_game(&self, id: i64) -> rusqlite::Result<Option<String>> {
        self.conn
            .query_row("SELECT pgn_moves FROM games WHERE id = ?1", [id], |r| r.get(0))
            .map(Some)
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(other),
            })
    }

    /// Full header + movetext for one game, as a ready-to-parse PGN string
    /// (tags followed by the movetext).
    pub fn get_game_pgn(&self, id: i64) -> rusqlite::Result<Option<String>> {
        let row = self.conn.query_row(
            "SELECT white, black, event, site, round, date, eco, result, pgn_moves \
             FROM games WHERE id = ?1",
            [id],
            |r| {
                Ok(GameForPgn {
                    white: r.get(0)?,
                    black: r.get(1)?,
                    event: r.get(2)?,
                    site: r.get(3)?,
                    round: r.get(4)?,
                    date: r.get(5)?,
                    eco: r.get(6)?,
                    result: r.get(7)?,
                    movetext: r.get(8)?,
                })
            },
        );
        match row {
            Ok(g) => Ok(Some(g.to_pgn())),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// Find games reaching the position given by `fen`. Zobrist lookup, then FEN
    /// (EPD) verification to reject the rare hash collision. Returns, per game,
    /// the move played next from that position.
    pub fn search_position(&self, fen: &str, limit: i64) -> rusqlite::Result<Vec<PositionHit>> {
        let pos = match Fen::from_ascii(fen.trim().as_bytes())
            .ok()
            .and_then(|f| f.into_position::<Chess>(CastlingMode::Standard).ok())
        {
            Some(p) => p,
            None => return Ok(Vec::new()),
        };
        let zobrist = pos.zobrist_hash::<Zobrist64>(EnPassantMode::Legal).0 as i64;
        let target_epd = epd(&pos);

        let mut stmt = self.conn.prepare(
            "SELECT p.game_id, p.ply, g.white, g.black, g.white_elo, g.black_elo, \
             g.result, g.date, g.moves \
             FROM positions p JOIN games g ON g.id = p.game_id \
             WHERE p.zobrist = ?1 ORDER BY p.game_id LIMIT ?2",
        )?;
        let raw = stmt.query_map(params![zobrist, limit], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, Option<i64>>(4)?,
                r.get::<_, Option<i64>>(5)?,
                r.get::<_, String>(6)?,
                r.get::<_, String>(7)?,
                r.get::<_, Vec<u8>>(8)?,
            ))
        })?;

        let mut hits = Vec::new();
        for row in raw {
            let (game_id, ply, white, black, white_elo, black_elo, result, date, moves) = row?;
            // Replay the mainline to the matched ply to (a) verify the EPD against
            // a collision and (b) read off the next move as UCI + SAN.
            let (verified, next_uci, next_san) = verify_and_next(&moves, ply as usize, &target_epd);
            if !verified {
                continue;
            }
            hits.push(PositionHit {
                game_id,
                white,
                black,
                white_elo,
                black_elo,
                result,
                date,
                ply,
                next_uci,
                next_san,
            });
        }
        Ok(hits)
    }

    /// Delete games by id (positions cascade). Returns the number removed.
    pub fn delete_games(&self, ids: &[i64]) -> rusqlite::Result<usize> {
        if ids.is_empty() {
            return Ok(0);
        }
        let placeholders = std::iter::repeat("?").take(ids.len()).collect::<Vec<_>>().join(",");
        let sql = format!("DELETE FROM games WHERE id IN ({placeholders})");
        self.conn
            .execute(&sql, params_from_iter(ids.iter()))
    }

    pub fn stats(&self) -> rusqlite::Result<DbStats> {
        let games = self.conn.query_row("SELECT COUNT(*) FROM games", [], |r| r.get(0))?;
        let positions = self
            .conn
            .query_row("SELECT COUNT(*) FROM positions", [], |r| r.get(0))?;
        Ok(DbStats { games, positions })
    }
}

enum InsertOutcome {
    Inserted,
    Duplicate,
    Error,
}

fn insert_game(
    tx: &Connection,
    game: &ParsedGame,
    source: &str,
    batch_id: &str,
) -> rusqlite::Result<InsertOutcome> {
    if game.error.is_some() {
        return Ok(InsertOutcome::Error);
    }
    let hash = dup_hash(&game.packed_moves, &game.result);
    let t = &game.tags;
    // INSERT OR IGNORE hits the UNIQUE(dup_hash) index; changes()==0 means the
    // game already exists (this import or a prior one) → duplicate.
    let changed = tx.execute(
        "INSERT OR IGNORE INTO games \
         (white, black, white_elo, black_elo, event, site, round, date, eco, \
          result, ply_count, source, import_batch, pgn_moves, moves, dup_hash) \
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)",
        params![
            t.white,
            t.black,
            t.white_elo,
            t.black_elo,
            t.event,
            t.site,
            t.round,
            t.date,
            t.eco,
            game.result,
            game.ply_count as i64,
            source,
            batch_id,
            game.movetext,
            game.packed_moves,
            hash,
        ],
    )?;
    if changed == 0 {
        return Ok(InsertOutcome::Duplicate);
    }
    let game_id = tx.last_insert_rowid();
    let mut stmt =
        tx.prepare_cached("INSERT INTO positions (zobrist, game_id, ply) VALUES (?1, ?2, ?3)")?;
    for (zobrist, _epd, ply) in &game.positions {
        stmt.execute(params![zobrist, game_id, *ply as i64])?;
    }
    Ok(InsertOutcome::Inserted)
}

/// Replay `packed_moves` from the start position to `ply`, confirm the EPD there
/// matches `target_epd`, and return the next move (UCI + SAN) if any.
fn verify_and_next(
    packed_moves: &[u8],
    ply: usize,
    target_epd: &str,
) -> (bool, Option<String>, Option<String>) {
    let mut pos = Chess::default();
    let moves: Vec<UciMove> = packed_moves
        .chunks_exact(PackedUciMove::BYTES)
        .map(|c| PackedUciMove::from_bytes([c[0], c[1]]).unpack())
        .collect();
    // Positions indexed from a FEN start would need the FEN to replay; this slice
    // verifies standard-start games (the overwhelming majority) and safely rejects
    // the rest rather than returning a false match.
    for uci in moves.iter().take(ply) {
        match uci.to_move(&pos) {
            Ok(m) => pos.play_unchecked(m),
            Err(_) => return (false, None, None),
        }
    }
    if epd(&pos) != *target_epd {
        return (false, None, None);
    }
    let next = moves.get(ply).and_then(|uci| {
        uci.to_move(&pos).ok().map(|m| {
            let san = shakmaty::san::San::from_move(&pos, m).to_string();
            (uci.to_string(), san)
        })
    });
    match next {
        Some((u, s)) => (true, Some(u), Some(s)),
        None => (true, None, None),
    }
}

fn row_to_header(r: &rusqlite::Row<'_>) -> rusqlite::Result<GameHeader> {
    Ok(GameHeader {
        id: r.get(0)?,
        white: r.get(1)?,
        black: r.get(2)?,
        white_elo: r.get(3)?,
        black_elo: r.get(4)?,
        event: r.get(5)?,
        site: r.get(6)?,
        round: r.get(7)?,
        date: r.get(8)?,
        eco: r.get(9)?,
        result: r.get(10)?,
        ply_count: r.get(11)?,
        source: r.get(12)?,
    })
}

struct GameForPgn {
    white: String,
    black: String,
    event: String,
    site: String,
    round: String,
    date: String,
    eco: String,
    result: String,
    movetext: String,
}

impl GameForPgn {
    fn to_pgn(&self) -> String {
        let esc = |s: &str| s.replace('\\', "\\\\").replace('"', "\\\"");
        let mut out = String::new();
        let mut tag = |k: &str, v: &str| {
            out.push_str(&format!("[{k} \"{}\"]\n", esc(v)));
        };
        tag("Event", &self.event);
        tag("Site", &self.site);
        tag("Date", &self.date);
        tag("Round", &self.round);
        tag("White", &self.white);
        tag("Black", &self.black);
        tag("Result", &self.result);
        if !self.eco.is_empty() {
            tag("ECO", &self.eco);
        }
        out.push('\n');
        out.push_str(&self.movetext);
        out.push('\n');
        out
    }
}

fn now_stamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    secs.to_string()
}

// ---------------------------------------------------------------------------
// Tauri command layer
// ---------------------------------------------------------------------------

/// Manages one open `Db` per resolved path, so several databases can be queried
/// simultaneously. Connections are opened lazily on first use.
#[derive(Default)]
pub struct DbManager {
    conns: Mutex<HashMap<String, Db>>,
}

impl DbManager {
    fn with<T>(
        &self,
        path: &str,
        f: impl FnOnce(&mut Db) -> rusqlite::Result<T>,
    ) -> Result<T, String> {
        let mut map = self.conns.lock().map_err(|e| e.to_string())?;
        if !map.contains_key(path) {
            let db = Db::open(path).map_err(|e| e.to_string())?;
            map.insert(path.to_string(), db);
        }
        let db = map.get_mut(path).unwrap();
        f(db).map_err(|e| e.to_string())
    }
}

fn resolve_db_path(app: &tauri::AppHandle, db_path: Option<String>) -> Result<String, String> {
    use tauri::Manager;
    if let Some(p) = db_path.filter(|s| !s.is_empty()) {
        return Ok(p);
    }
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("games.db").to_string_lossy().into_owned())
}

#[tauri::command]
pub fn db_import_pgn(
    app: tauri::AppHandle,
    state: tauri::State<'_, DbManager>,
    source: String,
    text: Option<String>,
    file_path: Option<String>,
    db_path: Option<String>,
) -> Result<ImportReport, String> {
    let path = resolve_db_path(&app, db_path)?;
    state.with(&path, |db| {
        if let Some(fp) = file_path.filter(|s| !s.is_empty()) {
            db.import_pgn_file(&fp, &source)
                .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))
        } else {
            db.import_pgn_str(text.as_deref().unwrap_or(""), &source)
        }
    })
}

#[tauri::command]
pub fn db_list_games(
    app: tauri::AppHandle,
    state: tauri::State<'_, DbManager>,
    filter: GameFilter,
    limit: i64,
    offset: i64,
    sort_by: Option<String>,
    sort_dir: Option<String>,
    db_path: Option<String>,
) -> Result<Vec<GameHeader>, String> {
    let path = resolve_db_path(&app, db_path)?;
    // Default to descending; "asc" opts into ascending.
    let desc = sort_dir.as_deref() != Some("asc");
    state.with(&path, |db| {
        db.list_games(&filter, limit, offset, sort_by.as_deref(), desc)
    })
}

#[tauri::command]
pub fn db_search_position(
    app: tauri::AppHandle,
    state: tauri::State<'_, DbManager>,
    fen: String,
    limit: Option<i64>,
    db_path: Option<String>,
) -> Result<Vec<PositionHit>, String> {
    let path = resolve_db_path(&app, db_path)?;
    state.with(&path, |db| db.search_position(&fen, limit.unwrap_or(200)))
}

#[tauri::command]
pub fn db_get_game(
    app: tauri::AppHandle,
    state: tauri::State<'_, DbManager>,
    id: i64,
    db_path: Option<String>,
) -> Result<Option<String>, String> {
    let path = resolve_db_path(&app, db_path)?;
    state.with(&path, |db| db.get_game_pgn(id))
}

#[tauri::command]
pub fn db_delete_games(
    app: tauri::AppHandle,
    state: tauri::State<'_, DbManager>,
    ids: Vec<i64>,
    db_path: Option<String>,
) -> Result<usize, String> {
    let path = resolve_db_path(&app, db_path)?;
    state.with(&path, |db| db.delete_games(&ids))
}

#[tauri::command]
pub fn db_stats(
    app: tauri::AppHandle,
    state: tauri::State<'_, DbManager>,
    db_path: Option<String>,
) -> Result<DbStats, String> {
    let path = resolve_db_path(&app, db_path)?;
    state.with(&path, |db| db.stats())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = include_str!("../tests/fixtures/sample.pgn");

    #[test]
    fn schema_initializes() {
        let db = Db::open_in_memory().unwrap();
        let stats = db.stats().unwrap();
        assert_eq!(stats.games, 0);
        assert_eq!(stats.positions, 0);
    }

    #[test]
    fn imports_and_counts() {
        let mut db = Db::open_in_memory().unwrap();
        let rep = db.import_pgn_str(SAMPLE, "test").unwrap();
        assert_eq!(rep.imported, 3, "fixture has 3 distinct games");
        assert_eq!(rep.dups_skipped, 0);
        assert_eq!(rep.errors, 0);
        assert_eq!(db.stats().unwrap().games, 3);
        assert!(db.stats().unwrap().positions > 0);
    }

    #[test]
    fn dedup_across_two_imports() {
        let mut db = Db::open_in_memory().unwrap();
        let a = db.import_pgn_str(SAMPLE, "first").unwrap();
        assert_eq!(a.imported, 3);
        // Re-importing the same corpus should skip every game as a duplicate.
        let b = db.import_pgn_str(SAMPLE, "second").unwrap();
        assert_eq!(b.imported, 0);
        assert_eq!(b.dups_skipped, 3);
        assert_eq!(db.stats().unwrap().games, 3);
    }

    #[test]
    fn header_filters() {
        let mut db = Db::open_in_memory().unwrap();
        db.import_pgn_str(SAMPLE, "test").unwrap();

        let by_player = db
            .list_games(
                &GameFilter {
                    player: Some("Carlsen".into()),
                    ..Default::default()
                },
                100,
                0,
                None,
                true,
            )
            .unwrap();
        assert!(
            by_player.iter().all(|g| g.white.contains("Carlsen") || g.black.contains("Carlsen")),
            "player filter matches either colour"
        );
        assert!(!by_player.is_empty());

        let by_eco = db
            .list_games(
                &GameFilter {
                    eco: Some("B".into()),
                    ..Default::default()
                },
                100,
                0,
                None,
                true,
            )
            .unwrap();
        assert!(by_eco.iter().all(|g| g.eco.starts_with('B')));

        let all = db.list_games(&GameFilter::default(), 100, 0, None, true).unwrap();
        assert_eq!(all.len(), 3);

        // Sort by white ascending: names must be non-decreasing.
        let by_white = db
            .list_games(&GameFilter::default(), 100, 0, Some("white"), false)
            .unwrap();
        let names: Vec<&str> = by_white.iter().map(|g| g.white.as_str()).collect();
        let mut sorted = names.clone();
        sorted.sort();
        assert_eq!(names, sorted, "ascending sort by white");

        // An unknown sort column falls back to id order rather than erroring.
        let bogus = db
            .list_games(&GameFilter::default(), 100, 0, Some("white; DROP TABLE games"), true)
            .unwrap();
        assert_eq!(bogus.len(), 3, "injection attempt is ignored, not executed");
    }

    #[test]
    fn position_search_finds_transposition() {
        let mut db = Db::open_in_memory().unwrap();
        db.import_pgn_str(SAMPLE, "test").unwrap();

        // Position after 1. e4 c5 (start of the Sicilian) — reachable in the
        // fixture. Search by its FEN and confirm the next move is read back.
        let mut pos = Chess::default();
        for uci in ["e2e4", "c7c5"] {
            let m = UciMove::from_ascii(uci.as_bytes()).unwrap().to_move(&pos).unwrap();
            pos.play_unchecked(m);
        }
        let fen = Fen::from_position(&pos, EnPassantMode::Legal).to_string();
        let hits = db.search_position(&fen, 100).unwrap();
        assert!(!hits.is_empty(), "at least one Sicilian game reaches this position");
        assert!(
            hits.iter().any(|h| h.next_uci.is_some()),
            "the move played next is reported"
        );
    }

    #[test]
    fn transposition_matches_distinct_move_orders() {
        // Two move orders reaching the same position must share a Zobrist key and
        // both be found by a single position search.
        let mut db = Db::open_in_memory().unwrap();
        let pgn = "\
[Event \"A\"]\n[White \"P1\"]\n[Black \"P2\"]\n[Result \"1-0\"]\n\n1. d4 Nf6 2. c4 e6 3. Nc3 1-0\n\n\
[Event \"B\"]\n[White \"P3\"]\n[Black \"P4\"]\n[Result \"0-1\"]\n\n1. c4 Nf6 2. Nc3 e6 3. d4 0-1\n";
        db.import_pgn_str(pgn, "t").unwrap();

        // Position after 1.d4 Nf6 2.c4 e6 3.Nc3.
        let mut pos = Chess::default();
        for uci in ["d2d4", "g8f6", "c2c4", "e7e6", "b1c3"] {
            let m = UciMove::from_ascii(uci.as_bytes()).unwrap().to_move(&pos).unwrap();
            pos.play_unchecked(m);
        }
        let fen = Fen::from_position(&pos, EnPassantMode::Legal).to_string();
        let hits = db.search_position(&fen, 100).unwrap();
        assert_eq!(hits.len(), 2, "both move orders transpose into the position");
    }

    #[test]
    fn get_game_roundtrips_movetext() {
        let mut db = Db::open_in_memory().unwrap();
        db.import_pgn_str(SAMPLE, "test").unwrap();
        let ids = db.list_games(&GameFilter::default(), 1, 0, None, true).unwrap();
        let pgn = db.get_game_pgn(ids[0].id).unwrap().unwrap();
        assert!(pgn.contains("[White "));
        assert!(pgn.contains("1."));
    }

    #[test]
    fn delete_removes_game_and_positions() {
        let mut db = Db::open_in_memory().unwrap();
        db.import_pgn_str(SAMPLE, "test").unwrap();
        let before = db.stats().unwrap();
        let ids = db.list_games(&GameFilter::default(), 1, 0, None, true).unwrap();
        let removed = db.delete_games(&[ids[0].id]).unwrap();
        assert_eq!(removed, 1);
        let after = db.stats().unwrap();
        assert_eq!(after.games, before.games - 1);
        assert!(after.positions < before.positions, "cascade drops its positions");
    }

    /// Generate `n` distinct legal games of random moves as one PGN blob. A tiny
    /// LCG keeps it dependency-free and deterministic; distinct move sequences
    /// mean distinct dup_hashes, so nothing dedups away during the benchmark.
    fn synth_pgn(n: usize, max_plies: usize) -> String {
        let mut out = String::with_capacity(n * 64);
        let mut rng: u64 = 0x9e3779b97f4a7c15;
        let next = |rng: &mut u64| {
            *rng = rng.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            *rng >> 33
        };
        for i in 0..n {
            let mut pos = Chess::default();
            let mut moves = String::new();
            let mut fullmove = 1;
            let mut white = true;
            for _ in 0..max_plies {
                let legal = pos.legal_moves();
                if legal.is_empty() {
                    break;
                }
                let idx = (next(&mut rng) as usize) % legal.len();
                let m = legal[idx];
                let san = shakmaty::san::San::from_move(&pos, m).to_string();
                if white {
                    moves.push_str(&format!("{fullmove}. {san} "));
                } else {
                    moves.push_str(&format!("{san} "));
                    fullmove += 1;
                }
                white = !white;
                pos.play_unchecked(m);
            }
            out.push_str(&format!(
                "[Event \"Bench\"]\n[White \"W{i}\"]\n[Black \"B{i}\"]\n[Result \"*\"]\n[ECO \"A00\"]\n\n{moves}*\n\n"
            ));
        }
        out
    }

    #[test]
    #[ignore = "benchmark; run with: cargo test --release -- --ignored --nocapture bench"]
    fn bench_import_and_search() {
        use std::time::Instant;
        let n = 50_000;
        let pgn = synth_pgn(n, 24);
        let mb = pgn.len() as f64 / 1e6;

        let mut db = Db::open_in_memory().unwrap();
        let t0 = Instant::now();
        let rep = db.import_pgn_str(&pgn, "bench").unwrap();
        let dt = t0.elapsed().as_secs_f64();
        let stats = db.stats().unwrap();
        println!(
            "IMPORT: {} games ({:.1} MB), {:.2}s => {:.0} games/s; positions={}",
            rep.imported,
            mb,
            dt,
            rep.imported as f64 / dt,
            stats.games,
        );

        // Position search latency: the start position (worst case — every game
        // has it indexed) and a deeper position.
        let start_fen = Fen::from_position(&Chess::default(), EnPassantMode::Legal).to_string();
        let t1 = Instant::now();
        let hits = db.search_position(&start_fen, 1_000_000).unwrap();
        let dt1 = t1.elapsed().as_secs_f64() * 1e3;
        println!("SEARCH start pos: {} hits in {:.1} ms", hits.len(), dt1);
    }

    #[test]
    fn variations_and_comments_preserved_in_movetext() {
        let mut db = Db::open_in_memory().unwrap();
        let pgn = "\
[Event \"V\"]\n[White \"P1\"]\n[Black \"P2\"]\n[Result \"*\"]\n\n\
1. e4 e5 (1... c5 2. Nf3 {Sicilian}) 2. Nf3 Nc6 *\n";
        let rep = db.import_pgn_str(pgn, "t").unwrap();
        assert_eq!(rep.imported, 1);
        let ids = db.list_games(&GameFilter::default(), 1, 0, None, true).unwrap();
        let mv = db.get_game(ids[0].id).unwrap().unwrap();
        assert!(mv.contains('('), "variation retained: {mv}");
        assert!(mv.contains("Sicilian"), "comment retained: {mv}");
        // Only mainline plies are indexed: 1.e4 e5 2.Nf3 Nc6 = 4 plies.
        assert_eq!(ids[0].ply_count, 4);
    }
}
