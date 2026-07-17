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
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use pgn_reader::{Outcome, RawComment, RawTag, Reader, SanPlus, Skip, Visitor};
use rusqlite::{params, params_from_iter, Connection};
use serde::{Deserialize, Serialize};
use shakmaty::fen::Fen;
use shakmaty::packed::PackedUciMove;
use shakmaty::uci::UciMove;
use shakmaty::zobrist::Zobrist64;
use shakmaty::{CastlingMode, Chess, Color, EnPassantMode, Move, Position, Role};
use std::ops::ControlFlow;

/// Default upper bound on how many mainline plies of each game get indexed into
/// the `positions` table. 40 plies (20 full moves) covers openings and early
/// middlegame — the range where position search and the opening explorer are
/// useful — while keeping the position index a small multiple of the game count.
pub const DEFAULT_PLY_CAP: u32 = 40;

/// v1: games + positions. v2: puzzles (spec 211 — DDL lives in puzzles.rs,
/// mirroring scripts/mining/import_puzzles.py). v3: game_tags (spec 200
/// tagging/favorites). v4: game_material (spec 200 material-signature search;
/// existing games are backfilled by replay on open). All DDL is idempotent
/// (IF NOT EXISTS), so upgrading is just running the batch again.
const SCHEMA_VERSION: i64 = 4;

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

/// Outcome of saving one game (spec 202: save the annotated game to the DB).
/// `updated` is true when a game with the same mainline + result already
/// existed and its headers/annotations were refreshed in place.
#[derive(Debug, Clone, Serialize)]
pub struct SaveReport {
    pub id: i64,
    pub updated: bool,
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
    /// User tags on this game (spec 200 tagging; "favorite" is the star).
    pub tags: Vec<String>,
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
    /// Maximum Elo allowed of both players. Games with an unrated player pass
    /// (a cap excludes known-strong players; it shouldn't hide unknowns).
    pub max_elo: Option<i64>,
    /// Full-text substring match across players, event, site and the movetext
    /// (which carries comments and annotations).
    pub text: Option<String>,
    /// Exact tag the game must carry (spec 200 tagging; "favorite" = starred).
    pub tag: Option<String>,
    /// Material signature the game must reach at some mainline position, e.g.
    /// "KRP vs KR" (rook-and-pawn-vs-rook ending). Either orientation matches
    /// (colour-agnostic); an unparseable signature matches nothing.
    pub material: Option<String>,
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

/// A candidate position for the Eval Calibration sampler (spec 213), drawn by
/// picking a random game and a random ply within it, then replaying the packed
/// mainline to that ply. The cheap, engine-free features the sampler stratifies
/// and filters on are precomputed here, along with the known-Elo game context
/// (sampler v2) that makes each answered position triple-labelled: Stockfish
/// eval, the user's perceived eval, and what a rated human actually played.
/// `fen` is the full FEN (with move counters). Only standard-start games are
/// sampled — a game with a `[FEN]` tag can't be replayed from the packed
/// mainline alone and is skipped.
#[derive(Debug, Clone, Serialize)]
pub struct SampledPosition {
    pub game_id: i64,
    pub ply: i64,
    pub fen: String,
    /// Side to move is in check (excluded by the sampler — forced play, not a
    /// clean evaluation exercise).
    pub in_check: bool,
    /// Material balance in points (P1 N3 B3 R5 Q9), White minus Black.
    pub material: i32,
    /// Non-pawn material phase weight (N/B=1, R=2, Q=4, both colours summed;
    /// 24 at the start). Drives the middlegame/endgame split.
    pub phase: u32,
    /// A capture landed within ±2 plies of this position (a tactically noisy
    /// window the sampler avoids).
    pub near_capture: bool,
    pub zobrist: i64,
    /// Elo of the players in the source game (both present — v2 samples only
    /// Elo-known games).
    pub white_elo: Option<i64>,
    pub black_elo: Option<i64>,
    /// True if White is to move in this position.
    pub white_to_move: bool,
    /// The move actually played from this position in the source game.
    pub played_uci: Option<String>,
    pub played_san: Option<String>,
    /// The next few moves after the played one (SAN), up to 3 — light game
    /// context for the post-answer reveal.
    pub continuation_san: Vec<String>,
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
    /// Distinct material signatures reached along the mainline (start position
    /// plus after every capture/promotion) — the spec-200 material-search keys.
    /// Computed from the live position, so FEN-start games index correctly.
    material_sigs: Vec<String>,
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
    /// Material signatures reached so far (last entry = current signature).
    material_sigs: Vec<String>,
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
        let material_sigs = vec![material_signature(&pos)];
        GameBuilder {
            tags,
            pos,
            start_fullmove,
            start_white,
            ply_cap,
            movetext: String::new(),
            packed_moves: Vec::new(),
            positions,
            material_sigs,
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
                    // Material only changes on a capture or promotion; unlike
                    // the position index this tracks the WHOLE mainline, so
                    // endgame signatures past the ply cap are searchable.
                    let material_changed = is_capture(&mv) || mv.is_promotion();
                    self.pos.play_unchecked(mv);
                    if material_changed {
                        let sig = material_signature(&self.pos);
                        if self.material_sigs.last() != Some(&sig) {
                            self.material_sigs.push(sig);
                        }
                    }
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
            material_sigs: self.material_sigs,
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
    /// Shared with the puzzles module (src/puzzles.rs), which extends `Db`
    /// with the spec-211 puzzle import/queries on the same database.
    pub(crate) conn: Connection,
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
        let mut db = Db { conn };
        db.init_schema()?;
        // v4 migration: index material signatures for games imported before
        // the game_material table existed. Idempotent; a no-op once caught up.
        db.backfill_material()?;
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

            -- v3: user tags / favorites (spec 200). "favorite" is the star.
            CREATE TABLE IF NOT EXISTS game_tags (
                game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
                tag     TEXT NOT NULL,
                PRIMARY KEY (game_id, tag)
            );

            CREATE INDEX IF NOT EXISTS idx_game_tags_tag ON game_tags(tag);

            -- v4: material signatures reached along each game's mainline
            -- (spec 200 material search, e.g. R+P vs R endings). One row per
            -- distinct signature; ~1 + number of captures/promotions per game.
            CREATE TABLE IF NOT EXISTS game_material (
                game_id   INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
                signature TEXT NOT NULL,
                PRIMARY KEY (game_id, signature)
            ) WITHOUT ROWID;

            CREATE INDEX IF NOT EXISTS idx_game_material_sig ON game_material(signature);
            "#,
        )?;
        // v2: avoidance puzzles (spec 211). Schema text lives next to its
        // import logic in puzzles.rs; it mirrors scripts/mining/import_puzzles.py.
        self.conn.execute_batch(crate::puzzles::PUZZLES_SCHEMA)?;
        // Record the schema version once; bump an older recorded version in
        // place (the DDL above is idempotent, so running it IS the migration).
        let has: i64 =
            self.conn
                .query_row("SELECT COUNT(*) FROM schema_version", [], |r| r.get(0))?;
        if has == 0 {
            self.conn
                .execute("INSERT INTO schema_version (version) VALUES (?1)", [SCHEMA_VERSION])?;
        } else {
            self.conn.execute(
                "UPDATE schema_version SET version = ?1 WHERE version < ?1",
                [SCHEMA_VERSION],
            )?;
        }
        Ok(())
    }

    /// Backfill `game_material` for games imported before schema v4. Every
    /// indexed game owns at least its start signature, so "no rows" identifies
    /// the un-indexed ones — which makes this idempotent and cheap once caught
    /// up. Games whose packed mainline can't be replayed from the standard
    /// start (a `[FEN]`-tag game imported pre-v4) are skipped rather than
    /// indexed wrongly; new imports compute signatures from the actual
    /// positions at parse time, so only pre-v4 rows can miss out.
    fn backfill_material(&mut self) -> rusqlite::Result<()> {
        let tx = self.conn.transaction()?;
        {
            let mut stmt = tx.prepare(
                "SELECT id, moves FROM games g WHERE NOT EXISTS \
                 (SELECT 1 FROM game_material m WHERE m.game_id = g.id)",
            )?;
            let rows: Vec<(i64, Vec<u8>)> = stmt
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<Result<_, _>>()?;
            let mut ins = tx.prepare(
                "INSERT OR IGNORE INTO game_material (game_id, signature) VALUES (?1, ?2)",
            )?;
            for (id, moves) in rows {
                if let Some(sigs) = replay_material_sigs(&moves) {
                    for sig in sigs {
                        ins.execute(params![id, sig])?;
                    }
                }
            }
        }
        tx.commit()
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
        self.import_reader_progress(reader, source, ply_cap, |_, _| {})
    }

    /// `import_reader` with a progress callback, invoked after every committed
    /// batch (and once at the end) with the running report and the number of
    /// games processed so far. The PGN stream's total game count is unknowable
    /// without a pre-scan, so progress is a monotone count, not a fraction.
    pub fn import_reader_progress<R: Read>(
        &mut self,
        reader: R,
        source: &str,
        ply_cap: u32,
        mut progress: impl FnMut(&ImportReport, u64),
    ) -> rusqlite::Result<ImportReport> {
        let batch_id = format!("{source}@{}", now_stamp());
        let mut report = ImportReport::default();
        let mut visitor = ImportVisitor { ply_cap };
        let mut pgn = Reader::new(reader);

        const BATCH: u64 = 1000;
        let mut tx = self.conn.transaction()?;
        let mut in_batch = 0u64;
        let mut processed = 0u64;
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
            processed += 1;
            if in_batch >= BATCH {
                tx.commit()?;
                tx = self.conn.transaction()?;
                in_batch = 0;
                progress(&report, processed);
            }
        }
        tx.commit()?;
        progress(&report, processed);
        Ok(report)
    }

    /// Merge every game from another ChessGUI database file into this one
    /// (spec 200 "merge databases"). Streams the source in id order, 1000
    /// games per committed transaction — the same resumable pattern as
    /// `import_reader_progress`/`backfill_material`: a crash mid-merge keeps
    /// every committed batch, and re-running skips them as duplicates via the
    /// `games.dup_hash` unique index. Each copied game's positions, material
    /// signatures and tags come along, re-keyed to its freshly assigned id.
    /// `progress` runs after every committed batch with the running report
    /// and the number of source games processed.
    pub fn merge_from(
        &mut self,
        source_path: &str,
        mut progress: impl FnMut(&ImportReport, u64),
    ) -> rusqlite::Result<ImportReport> {
        // ATTACH is not allowed inside a transaction, so it brackets the
        // batched loop; DETACH must run even when the loop errors (the failed
        // batch's transaction already rolled back on drop).
        self.conn
            .execute("ATTACH DATABASE ?1 AS merge_src", [source_path])?;
        let result = self.merge_attached(&mut progress);
        let detach = self.conn.execute_batch("DETACH DATABASE merge_src");
        let report = result?;
        detach?;
        Ok(report)
    }

    fn merge_attached(
        &mut self,
        progress: &mut impl FnMut(&ImportReport, u64),
    ) -> rusqlite::Result<ImportReport> {
        let has_table = |conn: &Connection, name: &str| -> rusqlite::Result<bool> {
            conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM merge_src.sqlite_master \
                 WHERE type='table' AND name=?1)",
                [name],
                |r| r.get(0),
            )
        };
        if !has_table(&self.conn, "games")? {
            return Err(save_err("source is not a ChessGUI database (no games table)"));
        }
        // Side tables may predate their schema version in an old source file;
        // copy what exists.
        let copy_positions = has_table(&self.conn, "positions")?;
        let copy_material = has_table(&self.conn, "game_material")?;
        let copy_tags = has_table(&self.conn, "game_tags")?;

        let mut report = ImportReport::default();
        let mut processed = 0u64;
        // Keyset pagination on the source PK: no OFFSET rescans, bounded
        // memory per batch regardless of source size.
        let mut last_id = 0i64;
        const BATCH: i64 = 1000;
        loop {
            let tx = self.conn.transaction()?;
            let ids: Vec<i64> = {
                let mut stmt = tx.prepare_cached(
                    "SELECT id FROM merge_src.games WHERE id > ?1 ORDER BY id LIMIT ?2",
                )?;
                let ids = stmt
                    .query_map(params![last_id, BATCH], |r| r.get(0))?
                    .collect::<Result<_, _>>()?;
                ids
            };
            if ids.is_empty() {
                break;
            }
            {
                // INSERT OR IGNORE hits the UNIQUE(dup_hash) index, exactly
                // like PGN import; changes()==0 → already in the target.
                let mut ins_game = tx.prepare_cached(
                    "INSERT OR IGNORE INTO games \
                     (white, black, white_elo, black_elo, event, site, round, date, eco, \
                      result, ply_count, source, import_batch, pgn_moves, moves, dup_hash, \
                      created_at) \
                     SELECT white, black, white_elo, black_elo, event, site, round, date, eco, \
                      result, ply_count, source, import_batch, pgn_moves, moves, dup_hash, \
                      created_at \
                     FROM merge_src.games WHERE id = ?1",
                )?;
                let mut ins_pos = tx.prepare_cached(
                    "INSERT INTO positions (zobrist, game_id, ply) \
                     SELECT zobrist, ?2, ply FROM merge_src.positions WHERE game_id = ?1",
                )?;
                let mut ins_mat = tx.prepare_cached(
                    "INSERT OR IGNORE INTO game_material (game_id, signature) \
                     SELECT ?2, signature FROM merge_src.game_material WHERE game_id = ?1",
                )?;
                let mut ins_tag = tx.prepare_cached(
                    "INSERT OR IGNORE INTO game_tags (game_id, tag) \
                     SELECT ?2, tag FROM merge_src.game_tags WHERE game_id = ?1",
                )?;
                for &src_id in &ids {
                    if ins_game.execute([src_id])? == 0 {
                        report.dups_skipped += 1;
                    } else {
                        let new_id = tx.last_insert_rowid();
                        if copy_positions {
                            ins_pos.execute(params![src_id, new_id])?;
                        }
                        if copy_material {
                            ins_mat.execute(params![src_id, new_id])?;
                        }
                        if copy_tags {
                            ins_tag.execute(params![src_id, new_id])?;
                        }
                        report.imported += 1;
                    }
                    processed += 1;
                }
            }
            last_id = *ids.last().unwrap();
            tx.commit()?;
            progress(&report, processed);
        }
        progress(&report, processed);
        Ok(report)
    }

    /// Save one game's PGN (spec 202: save the annotated game to the DB).
    /// Parses with the same visitor as import, then upserts on the dup hash —
    /// annotations (comments, NAGs, `[%eval]`/`[%cal]`/`[%csl]` tags) live in
    /// the movetext, so saving an annotated copy of an already-stored game
    /// refreshes that game's headers + movetext in place rather than being
    /// skipped as a duplicate. Returns the row id and whether it was an update.
    pub fn save_game(&mut self, pgn: &str, source: &str) -> rusqlite::Result<SaveReport> {
        let mut visitor = ImportVisitor {
            ply_cap: DEFAULT_PLY_CAP,
        };
        let mut reader = Reader::new(Cursor::new(pgn.as_bytes()));
        let game = reader
            .read_game(&mut visitor)
            .map_err(|e| save_err(&format!("PGN parse failed: {e}")))?
            .ok_or_else(|| save_err("no game found in the PGN"))?;
        if let Some(err) = &game.error {
            return Err(save_err(&format!("invalid game: {err}")));
        }
        let batch_id = format!("{source}@{}", now_stamp());
        // The row is found by hash in both branches: `last_insert_rowid` is
        // useless here because `insert_game` inserts position rows after the
        // game row.
        let hash = dup_hash(&game.packed_moves, &game.result);
        let tx = self.conn.transaction()?;
        let updated = match insert_game(&tx, &game, source, &batch_id)? {
            InsertOutcome::Inserted => false,
            InsertOutcome::Duplicate => {
                // Same mainline + result already stored: refresh the headers
                // and the movetext (where the annotations live). Provenance
                // columns (source, import_batch, created_at) keep the original
                // row's values, and the position index is keyed on the
                // unchanged mainline, so neither is touched.
                let t = &game.tags;
                tx.execute(
                    "UPDATE games SET white=?1, black=?2, white_elo=?3, black_elo=?4, \
                     event=?5, site=?6, round=?7, date=?8, eco=?9, pgn_moves=?10 \
                     WHERE dup_hash=?11",
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
                        game.movetext,
                        hash,
                    ],
                )?;
                true
            }
            // Unreachable in practice — `game.error` was checked above — but
            // surface it rather than silently reporting success.
            InsertOutcome::Error => return Err(save_err("game could not be stored")),
        };
        let id = tx.query_row("SELECT id FROM games WHERE dup_hash=?1", [&hash], |r| r.get(0))?;
        tx.commit()?;
        Ok(SaveReport { id, updated })
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
        // Tags ride along as one '\x1f'-joined column (a separator no sane tag
        // contains), split apart in `row_to_header` — one query, no N+1.
        let mut sql = String::from(
            "SELECT id, white, black, white_elo, black_elo, event, site, round, \
             date, eco, result, ply_count, source, \
             (SELECT group_concat(tag, char(31)) FROM \
              (SELECT tag FROM game_tags WHERE game_id = games.id ORDER BY tag)) \
             FROM games",
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
        if let Some(elo) = filter.max_elo {
            // Unrated (NULL) players pass the cap — see the field's doc.
            clauses.push(
                "(IFNULL(white_elo, 0) <= ? AND IFNULL(black_elo, 0) <= ?)".to_string(),
            );
            args.push(Box::new(elo));
            args.push(Box::new(elo));
        }
        if let Some(t) = filter.text.as_deref().filter(|s| !s.is_empty()) {
            // Full-text is a LIKE scan over headers + movetext (comments and
            // annotations included). Adequate at this database's scale; an FTS5
            // index would need sync triggers + a rebuild of existing files.
            clauses.push(
                "(white LIKE ? OR black LIKE ? OR event LIKE ? OR site LIKE ? \
                 OR pgn_moves LIKE ?)"
                    .to_string(),
            );
            let needle = format!("%{t}%");
            for _ in 0..5 {
                args.push(Box::new(needle.clone()));
            }
        }
        if let Some(tag) = filter.tag.as_deref().filter(|s| !s.is_empty()) {
            clauses.push(
                "EXISTS (SELECT 1 FROM game_tags t WHERE t.game_id = games.id AND t.tag = ?)"
                    .to_string(),
            );
            args.push(Box::new(tag.to_string()));
        }
        if let Some(m) = filter.material.as_deref().filter(|s| !s.trim().is_empty()) {
            match parse_material_query(m) {
                Some((sig, flipped)) => {
                    // Either orientation matches — "KRP vs KR" finds the ending
                    // regardless of which colour holds the extra pawn.
                    clauses.push(
                        "EXISTS (SELECT 1 FROM game_material gm \
                         WHERE gm.game_id = games.id AND gm.signature IN (?, ?))"
                            .to_string(),
                    );
                    args.push(Box::new(sig));
                    args.push(Box::new(flipped));
                }
                // An unparseable material query matches nothing rather than
                // silently dropping the filter and showing everything.
                None => clauses.push("0 = 1".to_string()),
            }
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

    /// Attach `tag` to a game (spec 200 tagging; no-op if already present).
    /// The tag is trimmed; an empty tag or an unknown game id is an error.
    pub fn add_tag(&self, game_id: i64, tag: &str) -> rusqlite::Result<()> {
        let tag = tag.trim();
        if tag.is_empty() {
            return Err(save_err("tag must not be empty"));
        }
        // The FK on game_tags rejects unknown game ids with a clear error.
        self.conn.execute(
            "INSERT OR IGNORE INTO game_tags (game_id, tag) VALUES (?1, ?2)",
            params![game_id, tag],
        )?;
        Ok(())
    }

    /// Remove `tag` from a game. Removing an absent tag is a no-op.
    pub fn remove_tag(&self, game_id: i64, tag: &str) -> rusqlite::Result<()> {
        self.conn.execute(
            "DELETE FROM game_tags WHERE game_id = ?1 AND tag = ?2",
            params![game_id, tag.trim()],
        )?;
        Ok(())
    }

    /// All distinct tags in use, sorted — feeds the filter dropdown.
    pub fn list_tags(&self) -> rusqlite::Result<Vec<String>> {
        let mut stmt = self
            .conn
            .prepare("SELECT DISTINCT tag FROM game_tags ORDER BY tag")?;
        let rows = stmt.query_map([], |r| r.get(0))?;
        rows.collect()
    }

    pub fn stats(&self) -> rusqlite::Result<DbStats> {
        let games = self.conn.query_row("SELECT COUNT(*) FROM games", [], |r| r.get(0))?;
        let positions = self
            .conn
            .query_row("SELECT COUNT(*) FROM positions", [], |r| r.get(0))?;
        Ok(DbStats { games, positions })
    }

    /// Draw up to `limit` random positions from Elo-known games whose average
    /// player Elo falls in `[elo_min, elo_max)`, picking a random ply
    /// (`>= min_ply`, with a move still to come) per game — one position per
    /// game, which both avoids intra-game correlation (design doc §4) and lets
    /// the sample reach real endgames the ply-40 position index never held.
    /// Both the game and the ply are chosen in SQL (`ORDER BY RANDOM()` +
    /// `abs(random())`); each row is then replayed to compute features and the
    /// known-Elo context. Non-replayable (`[FEN]`-tag) games are skipped, so the
    /// returned count may be below `limit`.
    pub fn sample_positions_in_elo_band(
        &self,
        elo_min: i64,
        elo_max: i64,
        min_ply: i64,
        limit: i64,
    ) -> rusqlite::Result<Vec<SampledPosition>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, white_elo, black_elo, \
                    (?3 + abs(random()) % (ply_count - ?3)) AS chosen_ply, moves \
             FROM games \
             WHERE white_elo IS NOT NULL AND black_elo IS NOT NULL \
               AND (white_elo + black_elo) / 2 >= ?1 \
               AND (white_elo + black_elo) / 2 <  ?2 \
               AND ply_count > ?3 \
             ORDER BY RANDOM() LIMIT ?4",
        )?;
        let raw = stmt.query_map(params![elo_min, elo_max, min_ply, limit], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, Option<i64>>(1)?,
                r.get::<_, Option<i64>>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, Vec<u8>>(4)?,
            ))
        })?;
        let mut out = Vec::new();
        for row in raw {
            let (game_id, white_elo, black_elo, ply, moves) = row?;
            if let Some(sp) = replay_features(&moves, game_id, ply, white_elo, black_elo) {
                out.push(sp);
            }
        }
        Ok(out)
    }
}

/// Replay `packed_moves` to `ply` and compute the calibration features + the
/// known-Elo game context there. Returns `None` if the mainline can't be applied
/// that far (e.g. a `[FEN]`-tag game), so such rows drop out of the sample
/// rather than yielding a bogus position.
fn replay_features(
    packed_moves: &[u8],
    game_id: i64,
    ply: i64,
    white_elo: Option<i64>,
    black_elo: Option<i64>,
) -> Option<SampledPosition> {
    let moves: Vec<UciMove> = packed_moves
        .chunks_exact(PackedUciMove::BYTES)
        .map(|c| PackedUciMove::from_bytes([c[0], c[1]]).unpack())
        .collect();
    let ply_us = ply.max(0) as usize;
    if ply_us > moves.len() {
        return None;
    }
    let mut pos = Chess::default();
    // Captures on the plies leading into this position.
    let mut before_capture = false;
    for (i, uci) in moves.iter().take(ply_us).enumerate() {
        let m = uci.to_move(&pos).ok()?;
        if i + 2 >= ply_us {
            before_capture |= is_capture(&m);
        }
        pos.play_unchecked(m);
    }

    let fen = Fen::from_position(&pos, EnPassantMode::Legal).to_string();
    let in_check = pos.is_check();
    let white_to_move = pos.turn() == Color::White;
    let (material, phase) = material_and_phase(&pos);
    let zobrist = pos.zobrist_hash::<Zobrist64>(EnPassantMode::Legal).0 as i64;

    // Walk forward from this position: the played move (SAN + UCI), the next up
    // to three moves (SAN, context for the post-answer reveal), and whether a
    // capture lands within the ±2-ply noise window.
    let mut peek = pos.clone();
    let mut played_uci = None;
    let mut played_san = None;
    let mut continuation_san = Vec::new();
    let mut after_capture = false;
    for (offset, uci) in moves.iter().skip(ply_us).take(4).enumerate() {
        let m = match uci.to_move(&peek) {
            Ok(m) => m,
            Err(_) => break,
        };
        let san = shakmaty::san::San::from_move(&peek, m).to_string();
        if offset == 0 {
            played_uci = Some(uci.to_string());
            played_san = Some(san);
        } else {
            continuation_san.push(san);
        }
        if offset <= 1 {
            after_capture |= is_capture(&m);
        }
        peek.play_unchecked(m);
    }

    Some(SampledPosition {
        game_id,
        ply,
        fen,
        in_check,
        material,
        phase,
        near_capture: before_capture || after_capture,
        zobrist,
        white_elo,
        black_elo,
        white_to_move,
        played_uci,
        played_san,
        continuation_san,
    })
}

/// A move that removes an enemy piece (ordinary capture or en passant).
fn is_capture(m: &Move) -> bool {
    m.is_capture() || m.is_en_passant()
}

/// White-POV material balance in points and the non-pawn phase weight.
fn material_and_phase(pos: &Chess) -> (i32, u32) {
    let board = pos.board();
    let count = |c: Color, r: Role| (board.by_color(c) & board.by_role(r)).count() as i32;
    let points = |c: Color| {
        count(c, Role::Pawn)
            + 3 * count(c, Role::Knight)
            + 3 * count(c, Role::Bishop)
            + 5 * count(c, Role::Rook)
            + 9 * count(c, Role::Queen)
    };
    let material = points(Color::White) - points(Color::Black);
    let phase_side = |c: Color| {
        (count(c, Role::Knight)
            + count(c, Role::Bishop)
            + 2 * count(c, Role::Rook)
            + 4 * count(c, Role::Queen)) as u32
    };
    let phase = phase_side(Color::White) + phase_side(Color::Black);
    (material, phase)
}

/// Material signature of a position (spec 200 material search): per side "K"
/// then "Q"/"R"/"B"/"N"/"P" repeated per piece on the board, White's half
/// first — e.g. a rook-and-pawn-vs-rook ending is "KRPKR".
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

/// Parse a material-search query into its canonical signature plus the
/// colour-flipped one. Accepts "KRP vs KR", "krp-kr", "RP v R", "KRPKR"…:
/// case-insensitive, any piece order, kings implied when omitted, sides split
/// by any non-piece characters (or at the second king when written as one
/// token). `None` when the input isn't a material description.
fn parse_material_query(input: &str) -> Option<(String, String)> {
    let upper = input.trim().to_uppercase();
    // Piece letters never include the separators ("VS", "-", "/", space…),
    // so splitting on any non-piece character isolates the two sides.
    let sides: Vec<&str> = upper
        .split(|c: char| !"KQRBNP".contains(c))
        .filter(|s| !s.is_empty())
        .collect();
    let (a, b) = match sides.len() {
        // One run like "KRPKR": unambiguous only with exactly two kings.
        1 => {
            let t = sides[0];
            let ks: Vec<usize> =
                t.char_indices().filter(|&(_, c)| c == 'K').map(|(i, _)| i).collect();
            if ks.len() != 2 {
                return None;
            }
            (&t[..ks[1]], &t[ks[1]..])
        }
        2 => (sides[0], sides[1]),
        _ => return None,
    };
    // Canonicalize one side: count pieces, imply the king, emit KQRBNP order.
    fn canon_side(s: &str) -> Option<String> {
        const ORDER: &str = "KQRBNP";
        let mut counts = [0usize; 6];
        for c in s.chars() {
            counts[ORDER.find(c)?] += 1;
        }
        if counts[0] == 0 {
            counts[0] = 1; // "RP v R" means "KRP vs KR"
        }
        if counts[0] != 1 {
            return None;
        }
        let mut out = String::new();
        for (i, ch) in ORDER.chars().enumerate() {
            for _ in 0..counts[i] {
                out.push(ch);
            }
        }
        Some(out)
    }
    let ca = canon_side(a)?;
    let cb = canon_side(b)?;
    Some((format!("{ca}{cb}"), format!("{cb}{ca}")))
}

/// Replay a packed mainline from the standard start and collect the distinct
/// material signatures reached (start + after every capture/promotion), for
/// the v4 backfill. `None` if any move fails to apply (a FEN-start game —
/// its signatures can't be recovered from the packed mainline alone).
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
    // OR IGNORE: a signature can recur non-consecutively (e.g. a promotion
    // restoring an earlier configuration); the PK dedups it.
    let mut mat = tx.prepare_cached(
        "INSERT OR IGNORE INTO game_material (game_id, signature) VALUES (?1, ?2)",
    )?;
    for sig in &game.material_sigs {
        mat.execute(params![game_id, sig])?;
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
        tags: r
            .get::<_, Option<String>>(13)?
            .map(|s| s.split('\x1f').map(str::to_string).collect())
            .unwrap_or_default(),
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

/// Wrap a validation failure (unparseable/empty PGN on save, a non-ChessGUI
/// merge source) in a rusqlite error so `save_game`/`merge_from` share the
/// `DbManager::with` plumbing, which maps all errors to display strings for
/// the frontend.
fn save_err(msg: &str) -> rusqlite::Error {
    rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(
        std::io::ErrorKind::InvalidData,
        msg.to_string(),
    )))
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
    pub(crate) fn with<T>(
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

pub(crate) fn resolve_db_path(
    app: &tauri::AppHandle,
    db_path: Option<String>,
) -> Result<String, String> {
    use tauri::Manager;
    if let Some(p) = db_path.filter(|s| !s.is_empty()) {
        return Ok(p);
    }
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("games.db").to_string_lossy().into_owned())
}

/// Progress snapshot streamed over the `on_progress` channel during a PGN
/// import: once up front, then after every committed batch, then once at the
/// end. Unlike CBH there is no `total` — a PGN stream's game count is unknown
/// without a full pre-scan — so the UI shows a running count.
#[derive(Serialize, Debug, Clone)]
pub struct PgnImportProgress {
    /// Games processed so far (imported + duplicates + errors).
    pub processed: u64,
    pub imported: u64,
    pub dups_skipped: u64,
    pub errors: u64,
}

/// Import PGN (pasted text or a file path). Runs on a blocking thread —
/// multi-GB files take a while — and streams progress over `on_progress`.
#[tauri::command]
pub async fn db_import_pgn(
    app: tauri::AppHandle,
    source: String,
    text: Option<String>,
    file_path: Option<String>,
    db_path: Option<String>,
    on_progress: tauri::ipc::Channel<PgnImportProgress>,
) -> Result<ImportReport, String> {
    let path = resolve_db_path(&app, db_path)?;
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        let state = app.state::<DbManager>();
        // A send failure just means the webview went away; keep importing.
        let emit = |rep: &ImportReport, processed: u64| {
            let _ = on_progress.send(PgnImportProgress {
                processed,
                imported: rep.imported,
                dups_skipped: rep.dups_skipped,
                errors: rep.errors,
            });
        };
        emit(&ImportReport::default(), 0);
        state.with(&path, |db| {
            if let Some(fp) = file_path.filter(|s| !s.is_empty()) {
                let file = std::fs::File::open(&fp)
                    .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
                db.import_reader_progress(BufReader::new(file), &source, DEFAULT_PLY_CAP, emit)
            } else {
                db.import_reader_progress(
                    Cursor::new(text.as_deref().unwrap_or("").as_bytes()),
                    &source,
                    DEFAULT_PLY_CAP,
                    emit,
                )
            }
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Progress snapshot streamed over the `on_progress` channel during a CBH
/// import: once up front (so the UI learns `total` immediately) and then after
/// every flushed batch.
#[derive(Serialize, Debug, Clone)]
pub struct CbhImportProgress {
    /// CBH records processed so far (converted or failed).
    pub processed: u32,
    /// Total records in the .cbh file.
    pub total: u32,
    pub imported: u64,
    pub dups_skipped: u64,
}

/// Outcome of a full CBH import. `convert_errors` counts records the CBH
/// decoder could not turn into PGN; `db_errors` counts converted games the PGN
/// importer then rejected (re-parse/replay failures).
#[derive(Serialize, Debug, Clone, Default)]
pub struct CbhImportReport {
    pub records: u32,
    pub imported: u64,
    pub dups_skipped: u64,
    pub convert_errors: u64,
    pub db_errors: u64,
    pub dropped_variations: u64,
    pub mainlines_truncated: u64,
    /// The import was cancelled at a batch boundary. Every batch committed
    /// before the cancel is kept; the counts above cover exactly what landed.
    pub cancelled: bool,
}

/// Cancellation flag for the in-flight CBH import, managed as Tauri state.
/// `db_cancel_cbh_import` sets it; `db_import_cbh` clears it on start and
/// polls it once per flushed batch. One flag suffices because only one CBH
/// import runs at a time (the import dialog is modal and busy-locked).
#[derive(Default)]
pub struct CbhImportCancel(pub AtomicBool);

/// Games per `import_pgn_str` flush during a CBH import. Small enough that the
/// DbManager mutex is released regularly (other db commands can interleave),
/// large enough to amortize per-transaction overhead.
const CBH_FLUSH_EVERY: u32 = 1000;

/// Drive the convert → batch → flush loop of a CBH import. Split from the
/// Tauri command so the cancellation path is unit-testable. `cancel` is
/// polled once per flushed batch; on cancellation the loop stops immediately
/// after the flush, so every committed batch is kept (each `flush` call is
/// its own `import_pgn_str` transaction) and the returned report carries
/// `cancelled: true` with honest counts for exactly what landed.
fn run_cbh_import(
    total: u32,
    cancel: &AtomicBool,
    mut convert: impl FnMut(u32) -> Result<crate::cbh::ConvertedGame, crate::cbh::CbhError>,
    mut flush: impl FnMut(&mut CbhImportReport, &mut String, u32) -> Result<(), String>,
) -> Result<CbhImportReport, String> {
    let mut rep = CbhImportReport {
        records: total,
        ..Default::default()
    };
    let mut buf = String::new();
    for id in 1..=total {
        match convert(id) {
            Ok(g) => {
                rep.dropped_variations += g.dropped_variations as u64;
                rep.mainlines_truncated += g.mainline_truncated as u64;
                buf.push_str(&g.pgn);
                buf.push('\n');
            }
            Err(_) => rep.convert_errors += 1,
        }
        if id % CBH_FLUSH_EVERY == 0 {
            flush(&mut rep, &mut buf, id)?;
            if cancel.load(Ordering::SeqCst) {
                rep.cancelled = true;
                return Ok(rep);
            }
        }
    }
    flush(&mut rep, &mut buf, total)?;
    Ok(rep)
}

/// Import a ChessBase .cbh database into the game database. The decoder reads
/// the sibling .cbg/.cba/.cbp/.cbt files next to `cbh_path` (see src/cbh.rs),
/// converts each game to PGN, and pushes batches through the same
/// `import_pgn_str` path as PGN import — so dedup and position indexing apply.
///
/// A large base takes minutes, so the whole loop runs on a blocking thread and
/// streams progress over `on_progress`.
#[tauri::command]
pub async fn db_import_cbh(
    app: tauri::AppHandle,
    cbh_path: String,
    db_path: Option<String>,
    on_progress: tauri::ipc::Channel<CbhImportProgress>,
) -> Result<CbhImportReport, String> {
    let path = resolve_db_path(&app, db_path)?;
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        let state = app.state::<DbManager>();
        let cancel = app.state::<CbhImportCancel>();
        // Fresh import: a cancel left over from a previous run must not apply.
        cancel.0.store(false, Ordering::SeqCst);

        let cbh = crate::cbh::CbhDb::open(&cbh_path)
            .map_err(|e| format!("open {cbh_path}: {e}"))?;
        let basename = Path::new(&cbh_path)
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "unknown".to_string());
        let source = format!("cbh:{basename}");

        let total = cbh.game_count();
        // A send failure just means the webview went away; the import keeps going.
        let emit = |rep: &CbhImportReport, processed: u32| {
            let _ = on_progress.send(CbhImportProgress {
                processed,
                total,
                imported: rep.imported,
                dups_skipped: rep.dups_skipped,
            });
        };
        emit(&CbhImportReport::default(), 0);

        run_cbh_import(
            total,
            &cancel.0,
            |id| cbh.convert_game(id),
            |rep, buf, processed| {
                if !buf.is_empty() {
                    let r = state.with(&path, |db| db.import_pgn_str(buf, &source))?;
                    buf.clear();
                    rep.imported += r.imported;
                    rep.dups_skipped += r.dups_skipped;
                    rep.db_errors += r.errors;
                }
                emit(rep, processed);
                Ok(())
            },
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Request cancellation of the in-flight CBH import (spec 200). The import
/// stops at its next batch boundary, keeps every batch already committed, and
/// resolves with `cancelled: true` and counts for what landed. Harmless no-op
/// when no import is running (the next import resets the flag on start).
#[tauri::command]
pub fn db_cancel_cbh_import(cancel: tauri::State<'_, CbhImportCancel>) -> Result<(), String> {
    cancel.0.store(true, Ordering::SeqCst);
    Ok(())
}

/// Merge another ChessGUI database file into the target database (spec 200
/// "merge databases"). Copies games with their positions/material/tags,
/// skipping exact duplicates via the dup_hash unique index. Runs on a
/// blocking thread — a source can hold hundreds of thousands of games — and
/// streams progress per committed batch. The PGN-import progress shape is
/// reused (running counts, no total).
#[tauri::command]
pub async fn db_merge_from(
    app: tauri::AppHandle,
    source_path: String,
    db_path: Option<String>,
    on_progress: tauri::ipc::Channel<PgnImportProgress>,
) -> Result<ImportReport, String> {
    let target = resolve_db_path(&app, db_path)?;
    // ATTACH would silently create an empty database at a bad path, and
    // merging a database into itself would only dup-skip 100% — both are
    // user errors worth naming up front.
    let source = std::fs::canonicalize(&source_path)
        .map_err(|e| format!("cannot open source database {source_path}: {e}"))?;
    if std::fs::canonicalize(&target).ok().as_deref() == Some(source.as_path()) {
        return Err("cannot merge a database into itself".to_string());
    }
    let source = source.to_string_lossy().into_owned();
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        let state = app.state::<DbManager>();
        // A send failure just means the webview went away; keep merging.
        let emit = |rep: &ImportReport, processed: u64| {
            let _ = on_progress.send(PgnImportProgress {
                processed,
                imported: rep.imported,
                dups_skipped: rep.dups_skipped,
                errors: rep.errors,
            });
        };
        emit(&ImportReport::default(), 0);
        state.with(&target, |db| db.merge_from(&source, emit))
    })
    .await
    .map_err(|e| e.to_string())?
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

/// Save the current game's PGN into the database (spec 202). Upserts on the
/// mainline+result dup hash so re-saving an annotated game updates it in
/// place. `source` defaults to "saved" (shows in the game list's provenance
/// column for new rows).
#[tauri::command]
pub fn db_save_game(
    app: tauri::AppHandle,
    state: tauri::State<'_, DbManager>,
    pgn: String,
    source: Option<String>,
    db_path: Option<String>,
) -> Result<SaveReport, String> {
    let path = resolve_db_path(&app, db_path)?;
    let source = source.filter(|s| !s.is_empty()).unwrap_or_else(|| "saved".to_string());
    state.with(&path, |db| db.save_game(&pgn, &source))
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
pub fn db_add_tag(
    app: tauri::AppHandle,
    state: tauri::State<'_, DbManager>,
    id: i64,
    tag: String,
    db_path: Option<String>,
) -> Result<(), String> {
    let path = resolve_db_path(&app, db_path)?;
    state.with(&path, |db| db.add_tag(id, &tag))
}

#[tauri::command]
pub fn db_remove_tag(
    app: tauri::AppHandle,
    state: tauri::State<'_, DbManager>,
    id: i64,
    tag: String,
    db_path: Option<String>,
) -> Result<(), String> {
    let path = resolve_db_path(&app, db_path)?;
    state.with(&path, |db| db.remove_tag(id, &tag))
}

/// All distinct tags in use in the database (feeds the tag filter dropdown).
#[tauri::command]
pub fn db_list_tags(
    app: tauri::AppHandle,
    state: tauri::State<'_, DbManager>,
    db_path: Option<String>,
) -> Result<Vec<String>, String> {
    let path = resolve_db_path(&app, db_path)?;
    state.with(&path, |db| db.list_tags())
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

    // Opening a database recorded at schema v1 (pre-puzzles) must create the
    // puzzles + game_tags tables and bump the recorded version — the
    // v1→current migration in one hop (the DDL batch is the migration).
    #[test]
    fn v1_database_migrates_to_current() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE schema_version (version INTEGER NOT NULL);
             INSERT INTO schema_version (version) VALUES (1);",
        )
        .unwrap();
        let db = Db::from_conn(conn).unwrap();
        let version: i64 = db
            .conn
            .query_row("SELECT version FROM schema_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        let puzzles: i64 = db
            .conn
            .query_row("SELECT COUNT(*) FROM puzzles", [], |r| r.get(0))
            .unwrap();
        assert_eq!(puzzles, 0, "puzzles table exists and is empty");
        let tags: i64 = db
            .conn
            .query_row("SELECT COUNT(*) FROM game_tags", [], |r| r.get(0))
            .unwrap();
        assert_eq!(tags, 0, "game_tags table exists and is empty");
    }

    // Tagging (spec 200): add/remove round-trips through the header list, the
    // tag filter narrows to tagged games, and list_tags reports what's in use.
    #[test]
    fn tags_roundtrip_and_filter() {
        let mut db = Db::open_in_memory().unwrap();
        db.import_pgn_str(SAMPLE, "test").unwrap();
        let all = db.list_games(&GameFilter::default(), 100, 0, None, true).unwrap();
        assert!(all.len() >= 2);
        assert!(all.iter().all(|g| g.tags.is_empty()));
        let (a, b) = (all[0].id, all[1].id);

        db.add_tag(a, "favorite").unwrap();
        db.add_tag(a, "endgame study").unwrap();
        db.add_tag(a, "favorite").unwrap(); // duplicate: no-op
        db.add_tag(b, "favorite").unwrap();
        assert!(db.add_tag(a, "  ").is_err(), "blank tag rejected");
        assert!(db.add_tag(999_999, "x").is_err(), "unknown game rejected");

        let hdr = db
            .list_games(&GameFilter::default(), 100, 0, None, true)
            .unwrap()
            .into_iter()
            .find(|g| g.id == a)
            .unwrap();
        assert_eq!(hdr.tags, vec!["endgame study", "favorite"]); // sorted

        let favs = db
            .list_games(
                &GameFilter {
                    tag: Some("favorite".into()),
                    ..Default::default()
                },
                100,
                0,
                None,
                true,
            )
            .unwrap();
        assert_eq!(favs.len(), 2);

        assert_eq!(db.list_tags().unwrap(), vec!["endgame study", "favorite"]);

        db.remove_tag(a, "favorite").unwrap();
        db.remove_tag(a, "favorite").unwrap(); // absent: no-op
        let favs = db
            .list_games(
                &GameFilter {
                    tag: Some("favorite".into()),
                    ..Default::default()
                },
                100,
                0,
                None,
                true,
            )
            .unwrap();
        assert_eq!(favs.len(), 1);
        assert_eq!(favs[0].id, b);
    }

    // Deleting a game cascades its tags away (FK ON DELETE CASCADE).
    #[test]
    fn deleting_game_drops_its_tags() {
        let mut db = Db::open_in_memory().unwrap();
        db.import_pgn_str(SAMPLE, "test").unwrap();
        let id = db.list_games(&GameFilter::default(), 1, 0, None, true).unwrap()[0].id;
        db.add_tag(id, "favorite").unwrap();
        db.delete_games(&[id]).unwrap();
        assert!(db.list_tags().unwrap().is_empty());
    }

    // max_elo caps both players; unrated players pass the cap.
    #[test]
    fn max_elo_filter_caps_both_players() {
        let mut db = Db::open_in_memory().unwrap();
        db.import_pgn_str(
            "[White \"A\"]\n[Black \"B\"]\n[WhiteElo \"2400\"]\n[BlackElo \"2600\"]\n[Result \"1-0\"]\n\n1. e4 e5 1-0\n\n\
             [White \"C\"]\n[Black \"D\"]\n[WhiteElo \"2100\"]\n[BlackElo \"2200\"]\n[Result \"0-1\"]\n\n1. d4 d5 0-1\n\n\
             [White \"E\"]\n[Black \"F\"]\n[Result \"1/2-1/2\"]\n\n1. c4 c5 1/2-1/2\n",
            "test",
        )
        .unwrap();
        let capped = db
            .list_games(
                &GameFilter {
                    max_elo: Some(2300),
                    ..Default::default()
                },
                100,
                0,
                None,
                true,
            )
            .unwrap();
        let names: Vec<&str> = capped.iter().map(|g| g.white.as_str()).collect();
        assert!(names.contains(&"C"), "both under the cap passes");
        assert!(names.contains(&"E"), "unrated players pass the cap");
        assert!(!names.contains(&"A"), "one player over the cap excludes");
    }

    // Full-text matches headers and movetext (comments included).
    #[test]
    fn text_filter_searches_headers_and_movetext() {
        let mut db = Db::open_in_memory().unwrap();
        db.import_pgn_str(
            "[White \"Tal, Mikhail\"]\n[Black \"Botvinnik, Mikhail\"]\n[Result \"1-0\"]\n\n\
             1. e4 {a stunning gambit} e5 1-0\n\n\
             [White \"Petrosian, Tigran\"]\n[Black \"Spassky, Boris\"]\n[Result \"1/2-1/2\"]\n\n\
             1. d4 d5 1/2-1/2\n",
            "test",
        )
        .unwrap();
        let by_comment = db
            .list_games(
                &GameFilter {
                    text: Some("stunning gambit".into()),
                    ..Default::default()
                },
                100,
                0,
                None,
                true,
            )
            .unwrap();
        assert_eq!(by_comment.len(), 1);
        assert_eq!(by_comment[0].white, "Tal, Mikhail");
        let by_player = db
            .list_games(
                &GameFilter {
                    text: Some("spassky".into()),
                    ..Default::default()
                },
                100,
                0,
                None,
                true,
            )
            .unwrap();
        assert_eq!(by_player.len(), 1, "LIKE is case-insensitive for ASCII");
        let none = db
            .list_games(
                &GameFilter {
                    text: Some("no such needle".into()),
                    ..Default::default()
                },
                100,
                0,
                None,
                true,
            )
            .unwrap();
        assert!(none.is_empty());
    }

    // The progress callback must land at least the final snapshot, with counts
    // matching the returned report (fixture is < 1 batch, so exactly one call).
    #[test]
    fn import_progress_callback_reports_final_counts() {
        let mut db = Db::open_in_memory().unwrap();
        let mut snapshots: Vec<(u64, u64)> = Vec::new();
        let rep = db
            .import_reader_progress(
                Cursor::new(SAMPLE.as_bytes()),
                "test",
                DEFAULT_PLY_CAP,
                |r, processed| snapshots.push((processed, r.imported)),
            )
            .unwrap();
        assert_eq!(rep.imported, 3);
        let last = snapshots.last().expect("at least one progress snapshot");
        assert_eq!(*last, (3, 3), "final snapshot carries full counts");
        // processed counts are monotone
        assert!(snapshots.windows(2).all(|w| w[0].0 <= w[1].0));
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

    /// Shorthand: a filter with only `material` set.
    fn material_filter(q: &str) -> GameFilter {
        GameFilter {
            material: Some(q.to_string()),
            ..Default::default()
        }
    }

    #[test]
    fn material_search_finds_endgame_signature() {
        // A rook-and-pawn-vs-rook ending from a FEN start — signatures are
        // computed from the actual positions at import, so a custom start
        // (and any position past the ply-40 index cap) indexes correctly.
        let mut db = Db::open_in_memory().unwrap();
        let pgn = "[Event \"E\"]\n[White \"A\"]\n[Black \"B\"]\n[Result \"*\"]\n\
                   [SetUp \"1\"]\n[FEN \"4k3/4r3/8/8/8/3K4/4P3/4R3 w - - 0 1\"]\n\n1. Kc3 *\n";
        db.import_pgn_str(pgn, "t").unwrap();

        let hit = db.list_games(&material_filter("KRP vs KR"), 10, 0, None, false).unwrap();
        assert_eq!(hit.len(), 1, "canonical query finds the ending");
        // Either orientation, lowercase, and the one-token form all match.
        for q in ["KR vs KRP", "krp-kr", "KRPKR", "RP v R"] {
            let rows = db.list_games(&material_filter(q), 10, 0, None, false).unwrap();
            assert_eq!(rows.len(), 1, "query {q:?} finds the ending");
        }
        // A different signature, and garbage, match nothing.
        assert!(db.list_games(&material_filter("KQ vs K"), 10, 0, None, false).unwrap().is_empty());
        assert!(db.list_games(&material_filter("xyz!"), 10, 0, None, false).unwrap().is_empty());
    }

    #[test]
    fn material_signatures_track_captures() {
        let mut db = Db::open_in_memory().unwrap();
        let pgn = "[Event \"E\"]\n[White \"A\"]\n[Black \"B\"]\n[Result \"*\"]\n\n\
                   1. e4 d5 2. exd5 Qxd5 *\n";
        db.import_pgn_str(pgn, "t").unwrap();
        // Full armies (start), one pawn up (after 2. exd5), level again 7v7
        // (after 2... Qxd5) — every signature along the way is searchable.
        for q in [
            "KQRRBBNNPPPPPPPP vs KQRRBBNNPPPPPPPP",
            "KQRRBBNNPPPPPPPP vs KQRRBBNNPPPPPPP",
            "KQRRBBNNPPPPPPP vs KQRRBBNNPPPPPPP",
        ] {
            let rows = db.list_games(&material_filter(q), 10, 0, None, false).unwrap();
            assert_eq!(rows.len(), 1, "signature {q:?} was reached");
        }
        // A signature never reached does not match.
        assert!(db.list_games(&material_filter("KQ vs KQ"), 10, 0, None, false).unwrap().is_empty());
    }

    #[test]
    fn material_backfill_reindexes_missing_games() {
        // Simulate a pre-v4 database: import (which indexes), wipe the
        // material table, and confirm the open-time backfill restores it.
        let mut db = Db::open_in_memory().unwrap();
        db.import_pgn_str(SAMPLE, "test").unwrap();
        db.conn.execute("DELETE FROM game_material", []).unwrap();
        let start = material_filter("KQRRBBNNPPPPPPPP vs KQRRBBNNPPPPPPPP");
        assert!(db.list_games(&start, 100, 0, None, false).unwrap().is_empty());
        db.backfill_material().unwrap();
        let rows = db.list_games(&start, 100, 0, None, false).unwrap();
        assert!(!rows.is_empty(), "standard-start games regain their start signature");
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

    /// An annotated game (comments, NAGs, [%eval]/[%cal] tags) saved via
    /// `save_game` must round-trip its annotations through `get_game_pgn`
    /// (spec 202 "annotations persist in database").
    #[test]
    fn save_game_round_trips_annotations() {
        let mut db = Db::open_in_memory().unwrap();
        let pgn = "\
[Event \"Analysis\"]\n[White \"Me\"]\n[Black \"Rival\"]\n[Result \"*\"]\n\n\
1. e4 {[%eval 0.25] Best by test. [%cal Ge2e4]} c5 $2 2. Nf3 $1 d6 *\n";
        let rep = db.save_game(pgn, "saved").unwrap();
        assert!(!rep.updated, "first save inserts");
        assert_eq!(db.stats().unwrap().games, 1);

        let out = db.get_game_pgn(rep.id).unwrap().unwrap();
        assert!(out.contains("[%eval 0.25]"), "eval tag survives: {out}");
        assert!(out.contains("Best by test."), "comment survives: {out}");
        assert!(out.contains("[%cal Ge2e4]"), "arrow tag survives: {out}");
        assert!(out.contains("$2"), "NAG on c5 survives: {out}");
        assert!(out.contains("$1"), "NAG on Nf3 survives: {out}");
    }

    /// Re-saving the same mainline with changed annotations/headers updates
    /// the existing row (same id, no duplicate), preserving provenance and
    /// the position index.
    #[test]
    fn save_game_updates_existing_row_in_place() {
        let mut db = Db::open_in_memory().unwrap();
        let v1 = "\
[Event \"Casual\"]\n[White \"Me\"]\n[Black \"Rival\"]\n[Result \"1-0\"]\n\n\
1. e4 e5 2. Nf3 Nc6 1-0\n";
        let first = db.save_game(v1, "saved").unwrap();
        assert!(!first.updated);
        let positions_before = db.stats().unwrap().positions;

        // Same mainline + result, now annotated and with a corrected event.
        let v2 = "\
[Event \"Club Championship\"]\n[White \"Me\"]\n[Black \"Rival\"]\n[Result \"1-0\"]\n\n\
1. e4 {[%eval 0.3]} e5 2. Nf3 $1 {Develops with tempo.} Nc6 1-0\n";
        let second = db.save_game(v2, "saved").unwrap();
        assert!(second.updated, "same mainline+result updates in place");
        assert_eq!(second.id, first.id, "row identity is stable across saves");
        assert_eq!(db.stats().unwrap().games, 1, "no duplicate row");
        assert_eq!(
            db.stats().unwrap().positions,
            positions_before,
            "position index untouched (mainline unchanged)"
        );

        let out = db.get_game_pgn(first.id).unwrap().unwrap();
        assert!(out.contains("Club Championship"), "headers refreshed: {out}");
        assert!(out.contains("Develops with tempo."), "annotations refreshed: {out}");
        assert!(out.contains("[%eval 0.3]"), "eval tag refreshed: {out}");
    }

    /// A different mainline (or result) is a new game, not an update.
    #[test]
    fn save_game_distinct_mainline_inserts_new_row() {
        let mut db = Db::open_in_memory().unwrap();
        let a = db
            .save_game("[Result \"*\"]\n\n1. e4 e5 *\n", "saved")
            .unwrap();
        let b = db
            .save_game("[Result \"*\"]\n\n1. d4 d5 *\n", "saved")
            .unwrap();
        assert!(!a.updated);
        assert!(!b.updated);
        assert_ne!(a.id, b.id);
        assert_eq!(db.stats().unwrap().games, 2);
    }

    /// Garbage in → an error out, never a silent empty row.
    #[test]
    fn save_game_rejects_empty_pgn() {
        let mut db = Db::open_in_memory().unwrap();
        assert!(db.save_game("", "saved").is_err());
        assert_eq!(db.stats().unwrap().games, 0);
    }

    // -- CBH import cancellation (run_cbh_import flag path) -------------------

    /// Minimal stand-in for a converted CBH game; the loop only reads the
    /// PGN text and the two per-game counters.
    fn fake_converted(id: u32) -> crate::cbh::ConvertedGame {
        crate::cbh::ConvertedGame {
            pgn: format!("[White \"P{id}\"]\n\n1. e4 *\n"),
            white: format!("P{id}"),
            black: "?".to_string(),
            mainline_plies: 1,
            has_variations: false,
            has_annotations: false,
            dropped_variations: 0,
            mainline_truncated: false,
        }
    }

    /// Cancel raised during the first batch: the loop stops right after that
    /// batch's flush — the batch is kept, no further record is converted, and
    /// the report says so honestly.
    #[test]
    fn cbh_import_cancel_stops_at_batch_boundary() {
        let cancel = AtomicBool::new(false);
        let mut converted = 0u32;
        let mut flushed_batches: Vec<u32> = Vec::new();
        let rep = run_cbh_import(
            2 * CBH_FLUSH_EVERY + 500,
            &cancel,
            |id| {
                converted += 1;
                Ok(fake_converted(id))
            },
            |rep, buf, processed| {
                flushed_batches.push(processed);
                rep.imported += buf.lines().filter(|l| l.starts_with("[White")).count() as u64;
                buf.clear();
                // Simulate the user clicking Cancel while batch 1 commits.
                cancel.store(true, Ordering::SeqCst);
                Ok(())
            },
        )
        .unwrap();
        assert!(rep.cancelled);
        assert_eq!(converted, CBH_FLUSH_EVERY, "stops after the first batch");
        assert_eq!(flushed_batches, vec![CBH_FLUSH_EVERY]);
        assert_eq!(rep.imported, CBH_FLUSH_EVERY as u64, "committed batch is kept");
    }

    /// No cancel: every record converts, the remainder batch flushes, and the
    /// report is not marked cancelled.
    #[test]
    fn cbh_import_without_cancel_runs_to_completion() {
        let cancel = AtomicBool::new(false);
        let total = 2 * CBH_FLUSH_EVERY + 500;
        let mut flushed_batches: Vec<u32> = Vec::new();
        let rep = run_cbh_import(
            total,
            &cancel,
            |id| Ok(fake_converted(id)),
            |rep, buf, processed| {
                flushed_batches.push(processed);
                rep.imported += buf.lines().filter(|l| l.starts_with("[White")).count() as u64;
                buf.clear();
                Ok(())
            },
        )
        .unwrap();
        assert!(!rep.cancelled);
        assert_eq!(rep.imported, total as u64);
        assert_eq!(
            flushed_batches,
            vec![CBH_FLUSH_EVERY, 2 * CBH_FLUSH_EVERY, total]
        );
    }

    /// Cross-database merge (spec 200 "merge databases"): games already in the
    /// target dedup on dup_hash, new games copy in with their positions,
    /// material signatures and tags re-keyed to the fresh id, and re-merging
    /// is idempotent.
    #[test]
    fn merge_from_dedups_and_copies_side_tables() {
        // The source must live on disk — merge_from ATTACHes it by path.
        let src_path =
            std::env::temp_dir().join(format!("db-merge-test-{}.db", std::process::id()));
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(src_path.with_extension(format!("db{suffix}")));
        }
        {
            let mut src = Db::open(&src_path).unwrap();
            src.import_pgn_str(SAMPLE, "src").unwrap(); // overlap with target
            let extra = src
                .import_pgn_str(
                    "[White \"Only\"]\n[Black \"InSource\"]\n[Result \"1-0\"]\n\n\
                     1. e4 e5 2. Nf3 1-0\n",
                    "src",
                )
                .unwrap();
            assert_eq!(extra.imported, 1);
            let only = src
                .list_games(
                    &GameFilter {
                        white: Some("Only".into()),
                        ..Default::default()
                    },
                    10,
                    0,
                    None,
                    true,
                )
                .unwrap();
            src.add_tag(only[0].id, "merged-tag").unwrap();
        }

        let mut target = Db::open_in_memory().unwrap();
        target.import_pgn_str(SAMPLE, "target").unwrap();
        let before = target.stats().unwrap();

        let mut snapshots = 0u32;
        let report = target
            .merge_from(src_path.to_str().unwrap(), |_, _| snapshots += 1)
            .unwrap();
        assert_eq!(report.imported, 1, "only the non-overlapping game copies");
        assert_eq!(report.dups_skipped, before.games as u64);
        assert!(snapshots >= 1, "progress fires at least once");

        let merged = target
            .list_games(
                &GameFilter {
                    white: Some("Only".into()),
                    ..Default::default()
                },
                10,
                0,
                None,
                true,
            )
            .unwrap();
        assert_eq!(merged.len(), 1);
        let new_id = merged[0].id;
        assert_eq!(merged[0].tags, vec!["merged-tag"], "tags ride along");
        let pos_count: i64 = target
            .conn
            .query_row(
                "SELECT COUNT(*) FROM positions WHERE game_id = ?1",
                [new_id],
                |r| r.get(0),
            )
            .unwrap();
        // 1.e4 e5 2.Nf3 = start + 3 plies indexed.
        assert_eq!(pos_count, 4, "positions re-keyed to the new game id");
        let mat_count: i64 = target
            .conn
            .query_row(
                "SELECT COUNT(*) FROM game_material WHERE game_id = ?1",
                [new_id],
                |r| r.get(0),
            )
            .unwrap();
        assert!(mat_count >= 1, "material signatures ride along");

        // Idempotent: a second merge finds everything already present.
        let again = target.merge_from(src_path.to_str().unwrap(), |_, _| {}).unwrap();
        assert_eq!(again.imported, 0);
        assert_eq!(again.dups_skipped, before.games as u64 + 1);

        let _ = std::fs::remove_file(&src_path);
    }

    /// A random SQLite file without a games table is refused, and the failed
    /// merge leaves the source detached so a later merge can attach again.
    #[test]
    fn merge_from_rejects_non_chessgui_source() {
        let src_path =
            std::env::temp_dir().join(format!("db-merge-bad-test-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&src_path);
        Connection::open(&src_path)
            .unwrap()
            .execute_batch("CREATE TABLE other (x)")
            .unwrap();
        let mut target = Db::open_in_memory().unwrap();
        let err = target.merge_from(src_path.to_str().unwrap(), |_, _| {});
        assert!(err.is_err());
        // Detached despite the error: attaching again must not conflict.
        target
            .conn
            .execute("ATTACH DATABASE ?1 AS merge_src", [src_path.to_str().unwrap()])
            .unwrap();
        target.conn.execute_batch("DETACH DATABASE merge_src").unwrap();
        let _ = std::fs::remove_file(&src_path);
    }
}
