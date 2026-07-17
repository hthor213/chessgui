//! Read-only importer for the ChessBase CBH database family (spec 200 phase 4).
//!
//! Parses the classic multi-file set — `.cbh` (46-byte game header records),
//! `.cbg` (variable-length encoded move data with variations), `.cbp`/`.cbt`
//! (player/tournament name indices) and, best-effort, `.cba` (text comments,
//! evaluation symbols and graphical squares/arrows) — and converts each game
//! to a PGN string that is fed
//! through the existing `Db::import_pgn*` machinery, so dedup and position
//! indexing come for free.
//!
//! # Provenance (clean-room requirement)
//!
//! This implementation was written strictly from *published third-party*
//! documentation of the format. No ChessBase software was inspected,
//! disassembled or executed, and encrypted `.cbz` archives are not touched.
//! Sources:
//!
//! - The Morphy project's bundled format specification (Markdown docs at
//!   `morphy-cbh/docs/cbh-format/` in <https://github.com/Yarin78/morphy>):
//!   CBH header/record layout, CBG game data + setup-position encoding, the
//!   canonical single-byte move code table for encoding mode 0, entity index
//!   file layout (.cbp/.cbt), and the CBA annotation record layout.
//! - The MIT-licensed `cbh2pgn` Python converter by Dominik Klein
//!   (<https://github.com/asdfjkl/cbh2pgn>): the 256-byte mode-0 translation
//!   ("de-obfuscation") table reproduced below as `TRANSLATE`, plus
//!   cross-checks of the header field offsets and piece-list bookkeeping.
//!
//! The two sources were cross-validated: composing `TRANSLATE` with the
//! canonical code table reproduces every per-piece byte mapping published in
//! `cbh2pgn` (verified in unit tests below).
//!
//! # Scope
//!
//! Supported: standard chess games in CBG encoding mode 0 (virtually all games
//! in real databases), including games from setup positions and with nested
//! variations; text comments, symbol NAGs and graphical square/arrow
//! annotations from `.cba` (the latter emitted as PGN `[%csl]`/`[%cal]`
//! comment tags, which the frontend importer maps onto board shapes).
//! Skipped-and-counted
//! rather than failed: guiding texts, games marked deleted, Chess960 and other
//! encoding modes. Games whose move data fails to decode are counted as errors;
//! a decode failure *inside a variation* drops only that variation.

use std::collections::HashMap;
use std::fmt;
use std::io;
use std::num::NonZeroU32;
use std::path::Path;

use shakmaty::fen::Fen;
use shakmaty::san::SanPlus;
use shakmaty::uci::UciMove;
use shakmaty::{
    Bitboard, CastlingMode, Chess, Color, EnPassantMode, FromSetup, Piece, Position, Rank, Role,
    Setup, Square,
};

// ---------------------------------------------------------------------------
// Errors / per-game outcomes
// ---------------------------------------------------------------------------

/// Why a CBH record was skipped or failed to convert. `kind()` gives a stable
/// bucket name for the import report's error taxonomy.
#[derive(Debug, Clone, PartialEq)]
pub enum CbhError {
    /// The record is a guiding text, not a chess game.
    GuidingText,
    /// The game is marked as deleted in the CBH record.
    Deleted,
    /// CBG move data uses an encoding mode other than 0 (the argument is the
    /// mode byte, or 0x80 for the "rare game flag" we don't support).
    UnsupportedEncoding(u8),
    /// Chess960 game (encoding modes 10/11).
    Chess960,
    /// Offsets/lengths point outside the .cbg (or .cbh) file — fragment/corrupt.
    BadOffset,
    /// The setup position could not be decoded into a legal position.
    BadSetup(String),
    /// The move data could not be decoded (illegal move, garbage byte, ...).
    MoveDecode(String),
    /// Game id outside the file's record range.
    RecordOutOfRange,
}

impl CbhError {
    pub fn kind(&self) -> &'static str {
        match self {
            CbhError::GuidingText => "guiding_text",
            CbhError::Deleted => "deleted",
            CbhError::UnsupportedEncoding(_) => "unsupported_encoding",
            CbhError::Chess960 => "chess960",
            CbhError::BadOffset => "bad_offset",
            CbhError::BadSetup(_) => "bad_setup",
            CbhError::MoveDecode(_) => "move_decode",
            CbhError::RecordOutOfRange => "record_out_of_range",
        }
    }
}

impl fmt::Display for CbhError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CbhError::GuidingText => write!(f, "guiding text record"),
            CbhError::Deleted => write!(f, "marked as deleted"),
            CbhError::UnsupportedEncoding(m) => write!(f, "unsupported encoding mode {m:#x}"),
            CbhError::Chess960 => write!(f, "Chess960 game"),
            CbhError::BadOffset => write!(f, "offset/length out of bounds"),
            CbhError::BadSetup(e) => write!(f, "bad setup position: {e}"),
            CbhError::MoveDecode(e) => write!(f, "move decode error: {e}"),
            CbhError::RecordOutOfRange => write!(f, "record out of range"),
        }
    }
}

/// A successfully converted game, ready for `Db::import_pgn_str`.
#[derive(Debug, Clone)]
pub struct ConvertedGame {
    /// Complete PGN: tags, blank line, movetext with result token.
    pub pgn: String,
    pub white: String,
    pub black: String,
    pub mainline_plies: u32,
    pub has_variations: bool,
    pub has_annotations: bool,
    /// A variation failed to decode and was dropped (mainline is intact).
    pub dropped_variations: u32,
    /// The stored mainline contained a null move (a ChessBase idiom, e.g. for
    /// games decided without a reply); the mainline was truncated there.
    pub mainline_truncated: bool,
}

// ---------------------------------------------------------------------------
// The database (all files slurped into memory; Mega's .cbh+.cbg is ~90 MB)
// ---------------------------------------------------------------------------

pub struct CbhDb {
    cbh: Vec<u8>,
    cbg: Vec<u8>,
    cba: Option<Vec<u8>>,
    players: Option<EntityFile>,
    tournaments: Option<EntityFile>,
}

const CBH_RECORD: usize = 46;

impl CbhDb {
    /// Open a database given the path to its `.cbh` file. Sibling files are
    /// derived by extension; `.cbg` is required, the rest are optional (names
    /// resolve to "?" and annotations are skipped when absent).
    pub fn open<P: AsRef<Path>>(cbh_path: P) -> io::Result<CbhDb> {
        let base = cbh_path.as_ref();
        let cbh = std::fs::read(base)?;
        if cbh.len() < CBH_RECORD {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "cbh file shorter than its 46-byte header",
            ));
        }
        let sibling = |ext: &str| base.with_extension(ext);
        let cbg = std::fs::read(sibling("cbg"))?;
        let cba = std::fs::read(sibling("cba")).ok();
        let players = std::fs::read(sibling("cbp")).ok().and_then(EntityFile::parse);
        let tournaments = std::fs::read(sibling("cbt")).ok().and_then(EntityFile::parse);
        Ok(CbhDb {
            cbh,
            cbg,
            cba,
            players,
            tournaments,
        })
    }

    /// Number of game/text records (ids run 1..=count). Trusts the physical
    /// record count; the header's "next id" field is cross-checked when sane.
    pub fn game_count(&self) -> u32 {
        let by_size = (self.cbh.len() / CBH_RECORD).saturating_sub(1) as u32;
        let next_id = be_u32(&self.cbh[6..10]);
        if next_id > 0 && next_id - 1 <= by_size {
            next_id - 1
        } else {
            by_size
        }
    }

    fn record(&self, id: u32) -> Result<&[u8], CbhError> {
        let start = id as usize * CBH_RECORD;
        self.cbh
            .get(start..start + CBH_RECORD)
            .filter(|_| id >= 1)
            .ok_or(CbhError::RecordOutOfRange)
    }

    fn player_name(&self, id: u32) -> String {
        let payload = self.players.as_ref().and_then(|f| f.payload(id));
        match payload {
            Some(p) => {
                let last = zstring(&p[..30.min(p.len())]);
                let first = zstring(&p[30.min(p.len())..50.min(p.len())]);
                match (last.is_empty(), first.is_empty()) {
                    (true, true) => "?".to_string(),
                    (false, true) => last,
                    (true, false) => first,
                    (false, false) => format!("{last}, {first}"),
                }
            }
            None => "?".to_string(),
        }
    }

    fn event_site(&self, id: u32) -> (String, String) {
        match self.tournaments.as_ref().and_then(|f| f.payload(id)) {
            Some(p) => (
                zstring(&p[..40.min(p.len())]),
                zstring(&p[40.min(p.len())..70.min(p.len())]),
            ),
            None => ("?".to_string(), "?".to_string()),
        }
    }

    /// Convert game `id` (1-based) to PGN. Skips (with a typed error) records
    /// that are not standard, importable chess games.
    pub fn convert_game(&self, id: u32) -> Result<ConvertedGame, CbhError> {
        let rec = self.record(id)?;
        let flags = rec[0];
        if flags & 0x02 != 0 {
            return Err(CbhError::GuidingText);
        }
        if flags & 0x80 != 0 {
            return Err(CbhError::Deleted);
        }

        let white = self.player_name(be_u24(&rec[9..12]));
        let black = self.player_name(be_u24(&rec[12..15]));
        let (event, site) = self.event_site(be_u24(&rec[15..18]));
        let date = decode_date(be_u24(&rec[24..27]));
        let result = decode_result(rec[27]);
        let round = rec[29];
        let subround = rec[30];
        let white_elo = be_u16(&rec[31..33]);
        let black_elo = be_u16(&rec[33..35]);
        let eco = decode_eco(be_u16(&rec[35..37]));

        // --- move data ---
        let cbg_ofs = be_u32(&rec[1..5]) as usize;
        let head = self.cbg.get(cbg_ofs..cbg_ofs + 4).ok_or(CbhError::BadOffset)?;
        let b0 = head[0];
        let total_len = be_u24(&head[1..4]) as usize;
        if b0 & 0x80 != 0 {
            return Err(CbhError::UnsupportedEncoding(0x80));
        }
        let mode = b0 & 0x3F;
        if mode == 10 || mode == 11 {
            return Err(CbhError::Chess960);
        }
        if mode != 0 {
            return Err(CbhError::UnsupportedEncoding(mode));
        }
        let blob = self
            .cbg
            .get(cbg_ofs..cbg_ofs + total_len)
            .filter(|_| total_len >= 4)
            .ok_or(CbhError::BadOffset)?;

        let has_setup = b0 & 0x40 != 0;
        let (pos, cb, fen_tag, start_fullmove, start_white) = if has_setup {
            let setup_bytes = blob.get(4..32).ok_or(CbhError::BadOffset)?;
            decode_setup(setup_bytes)?
        } else {
            (
                Chess::default(),
                CbState::initial(),
                None,
                1,
                true,
            )
        };
        let move_bytes = &blob[4 + if has_setup { 28 } else { 0 }..];

        // --- annotations (best effort; never fails the game) ---
        let cba_ofs = be_u32(&rec[5..9]) as usize;
        let anns = if cba_ofs != 0 {
            self.cba
                .as_ref()
                .and_then(|cba| parse_annotations(cba, cba_ofs, id))
                .unwrap_or_default()
        } else {
            HashMap::new()
        };
        let has_annotations = !anns.is_empty();

        let tree = decode_moves(move_bytes, pos, cb, &anns)?;

        // --- assemble PGN ---
        let mut pgn = String::with_capacity(512);
        let esc = |s: &str| s.replace('\\', "\\\\").replace('"', "\\\"");
        let tag = |out: &mut String, k: &str, v: &str| {
            out.push_str(&format!("[{k} \"{}\"]\n", esc(v)));
        };
        tag(&mut pgn, "Event", &event);
        tag(&mut pgn, "Site", &site);
        tag(&mut pgn, "Date", &date);
        let round_str = match (round, subround) {
            (0, _) => "?".to_string(),
            (r, 0) => r.to_string(),
            (r, s) => format!("{r}.{s}"),
        };
        tag(&mut pgn, "Round", &round_str);
        tag(&mut pgn, "White", &white);
        tag(&mut pgn, "Black", &black);
        tag(&mut pgn, "Result", &result);
        if !eco.is_empty() {
            tag(&mut pgn, "ECO", &eco);
        }
        if white_elo > 0 {
            tag(&mut pgn, "WhiteElo", &white_elo.to_string());
        }
        if black_elo > 0 {
            tag(&mut pgn, "BlackElo", &black_elo.to_string());
        }
        if let Some(fen) = &fen_tag {
            tag(&mut pgn, "SetUp", "1");
            tag(&mut pgn, "FEN", fen);
        }
        pgn.push('\n');

        if let Some(a0) = anns.get(&0) {
            // Key 0 = pre-game: text plus any start-position shapes.
            let mut pre = a0.text_joined().unwrap_or_default();
            if let Some(g) = a0.graphics_tag() {
                if !pre.is_empty() {
                    pre.push(' ');
                }
                pre.push_str(&g);
            }
            if !pre.is_empty() {
                pgn.push_str(&format!("{{{pre}}} "));
            }
        }
        let mut ser = Serializer {
            tree: &tree,
            out: String::with_capacity(256),
            start_fullmove,
            start_white,
        };
        ser.write_line(0, true);
        pgn.push_str(&ser.out);
        if !ser.out.is_empty() {
            pgn.push(' ');
        }
        pgn.push_str(&result);
        pgn.push('\n');

        Ok(ConvertedGame {
            pgn,
            white,
            black,
            mainline_plies: tree.mainline_plies(),
            has_variations: tree.nodes.iter().any(|n| n.edges.len() > 1),
            has_annotations,
            dropped_variations: tree.dropped_variations,
            mainline_truncated: tree.mainline_truncated,
        })
    }
}

// ---------------------------------------------------------------------------
// Small field decoders
// ---------------------------------------------------------------------------

fn be_u16(b: &[u8]) -> u16 {
    u16::from_be_bytes([b[0], b[1]])
}
fn be_u24(b: &[u8]) -> u32 {
    u32::from_be_bytes([0, b[0], b[1], b[2]])
}
fn be_u32(b: &[u8]) -> u32 {
    u32::from_be_bytes([b[0], b[1], b[2], b[3]])
}
fn le_u32(b: &[u8]) -> u32 {
    u32::from_le_bytes([b[0], b[1], b[2], b[3]])
}

/// ISO-8859-1 zero-terminated fixed field to UTF-8 String.
fn zstring(bytes: &[u8]) -> String {
    bytes
        .iter()
        .take_while(|&&b| b != 0)
        .map(|&b| b as char)
        .collect::<String>()
        .trim()
        .to_string()
}

/// 24-bit packed date: bits 0-4 day, 5-8 month, 9-20 year; 0 = unspecified.
fn decode_date(v: u32) -> String {
    let day = v & 0x1F;
    let month = (v >> 5) & 0x0F;
    let year = (v >> 9) & 0xFFF;
    let y = if year == 0 {
        "????".to_string()
    } else {
        format!("{year:04}")
    };
    let m = if month == 0 {
        "??".to_string()
    } else {
        format!("{month:02}")
    };
    let d = if day == 0 {
        "??".to_string()
    } else {
        format!("{day:02}")
    };
    format!("{y}.{m}.{d}")
}

/// CBH result byte to PGN result. Forfeit codes map onto the equivalent score;
/// "Line" (3) and double-forfeit (7) have no PGN equivalent and become "*".
fn decode_result(code: u8) -> String {
    match code {
        0 | 4 => "0-1",
        1 | 5 => "1/2-1/2",
        2 | 6 => "1-0",
        _ => "*",
    }
    .to_string()
}

/// 16-bit ECO: bits 7-15 code (1 = A00 .. 500 = E99, 0 = unset); sub-code
/// (bits 0-6) is ignored. Values in the Chess960 range decode to empty.
fn decode_eco(v: u16) -> String {
    let eco = v >> 7;
    if (1..=500).contains(&eco) {
        let letter = (b'A' + ((eco - 1) / 100) as u8) as char;
        format!("{letter}{:02}", (eco - 1) % 100)
    } else {
        String::new()
    }
}

// ---------------------------------------------------------------------------
// Entity index files (.cbp players, .cbt tournaments)
// ---------------------------------------------------------------------------

/// One `.cbp`/`.cbt`-style entity file: 28/32-byte header, then records of
/// 9 bytes AVL-tree metadata + fixed-size payload. We only read payloads by id.
struct EntityFile {
    data: Vec<u8>,
    header_len: usize,
    record_len: usize,
    capacity: u32,
    payload_len: usize,
}

impl EntityFile {
    fn parse(data: Vec<u8>) -> Option<EntityFile> {
        if data.len() < 28 {
            return None;
        }
        let capacity = le_u32(&data[0..4]);
        let payload_len = le_u32(&data[12..16]) as usize;
        let extra = le_u32(&data[24..28]) as usize;
        if payload_len == 0 || payload_len > 4096 || extra > 1024 {
            return None;
        }
        Some(EntityFile {
            data,
            header_len: 28 + extra,
            record_len: 9 + payload_len,
            capacity,
            payload_len,
        })
    }

    fn payload(&self, id: u32) -> Option<&[u8]> {
        if id >= self.capacity {
            return None;
        }
        let start = self.header_len + id as usize * self.record_len + 9;
        self.data.get(start..start + self.payload_len)
    }
}

// ---------------------------------------------------------------------------
// CBG move decoding — encoding mode 0
// ---------------------------------------------------------------------------

/// Mode-0 translation table: maps the obfuscated byte (after subtracting the
/// running move count) to the canonical move code documented in the Morphy
/// format spec. Table values as published in the MIT-licensed cbh2pgn project
/// (`DEOBFUSCATE_2B` in game.py), where it is used for both one- and two-byte
/// moves. Cross-checked against cbh2pgn's per-piece byte maps in unit tests.
#[rustfmt::skip]
const TRANSLATE: [u8; 256] = [
    0xA2, 0x95, 0x43, 0xF5, 0xC1, 0x3D, 0x4A, 0x6C, //   0 -   7
    0x53, 0x83, 0xCC, 0x7C, 0xFF, 0xAE, 0x68, 0xAD, //   8 -  15
    0xD1, 0x92, 0x8B, 0x8D, 0x35, 0x81, 0x5E, 0x74, //  16 -  23
    0x26, 0x8E, 0xAB, 0xCA, 0xFD, 0x9A, 0xF3, 0xA0, //  24 -  31
    0xA5, 0x15, 0xFC, 0xB1, 0x1E, 0xED, 0x30, 0xEA, //  32 -  39
    0x22, 0xEB, 0xA7, 0xCD, 0x4E, 0x6F, 0x2E, 0x24, //  40 -  47
    0x32, 0x94, 0x41, 0x8C, 0x6E, 0x58, 0x82, 0x50, //  48 -  55
    0xBB, 0x02, 0x8A, 0xD8, 0xFA, 0x60, 0xDE, 0x52, //  56 -  63
    0xBA, 0x46, 0xAC, 0x29, 0x9D, 0xD7, 0xDF, 0x08, //  64 -  71
    0x21, 0x01, 0x66, 0xA3, 0xF1, 0x19, 0x27, 0xB5, //  72 -  79
    0x91, 0xD5, 0x42, 0x0E, 0xB4, 0x4C, 0xD9, 0x18, //  80 -  87
    0x5F, 0xBC, 0x25, 0xA6, 0x96, 0x04, 0x56, 0x6A, //  88 -  95
    0xAA, 0x33, 0x1C, 0x2B, 0x73, 0xF0, 0xDD, 0xA4, //  96 - 103
    0x37, 0xD3, 0xC5, 0x10, 0xBF, 0x5A, 0x23, 0x34, // 104 - 111
    0x75, 0x5B, 0xB8, 0x55, 0xD2, 0x6B, 0x09, 0x3A, // 112 - 119
    0x57, 0x12, 0xB3, 0x77, 0x48, 0x85, 0x9B, 0x0F, // 120 - 127
    0x9E, 0xC7, 0xC8, 0xA1, 0x7F, 0x7A, 0xC0, 0xBD, // 128 - 135
    0x31, 0x6D, 0xF6, 0x3E, 0xC3, 0x11, 0x71, 0xCE, // 136 - 143
    0x7D, 0xDA, 0xA8, 0x54, 0x90, 0x97, 0x1F, 0x44, // 144 - 151
    0x40, 0x16, 0xC9, 0xE3, 0x2C, 0xCB, 0x84, 0xEC, // 152 - 159
    0x9F, 0x3F, 0x5C, 0xE6, 0x76, 0x0B, 0x3C, 0x20, // 160 - 167
    0xB7, 0x36, 0x00, 0xDC, 0xE7, 0xF9, 0x4F, 0xF7, // 168 - 175
    0xAF, 0x06, 0x07, 0xE0, 0x1A, 0x0A, 0xA9, 0x4B, // 176 - 183
    0x0C, 0xD6, 0x63, 0x87, 0x89, 0x1D, 0x13, 0x1B, // 184 - 191
    0xE4, 0x70, 0x05, 0x47, 0x67, 0x7B, 0x2F, 0xEE, // 192 - 199
    0xE2, 0xE8, 0x98, 0x0D, 0xEF, 0xCF, 0xC4, 0xF4, // 200 - 207
    0xFB, 0xB0, 0x17, 0x99, 0x64, 0xF2, 0xD4, 0x2A, // 208 - 215
    0x03, 0x4D, 0x78, 0xC6, 0xFE, 0x65, 0x86, 0x88, // 216 - 223
    0x79, 0x45, 0x3B, 0xE5, 0x49, 0x8F, 0x2D, 0xB9, // 224 - 231
    0xBE, 0x62, 0x93, 0x14, 0xE9, 0xD0, 0x38, 0x9C, // 232 - 239
    0xB2, 0xC2, 0x59, 0x5D, 0xB6, 0x72, 0x51, 0xF8, // 240 - 247
    0x28, 0x7E, 0x61, 0x39, 0xE1, 0xDB, 0x69, 0x80, // 248 - 255
];

// Canonical special codes (Morphy moves.md).
const CODE_TWO_BYTE: u8 = 235;
const CODE_IGNORE: u8 = 236;
const CODE_START_VAR: u8 = 254;
const CODE_END_VAR: u8 = 255;

/// Piece kinds addressable by one-byte codes. Discriminants index CbState lists.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    King = 0,
    Queen = 1,
    Rook = 2,
    Bishop = 3,
    Knight = 4,
    Pawn = 5,
}

impl Kind {
    fn role(self) -> Role {
        match self {
            Kind::King => Role::King,
            Kind::Queen => Role::Queen,
            Kind::Rook => Role::Rook,
            Kind::Bishop => Role::Bishop,
            Kind::Knight => Role::Knight,
            Kind::Pawn => Role::Pawn,
        }
    }
}

/// A decoded canonical move code, before piece-list resolution.
#[derive(Debug, Clone, Copy)]
enum Op {
    Null,
    /// King move by (dx, dy) — absolute direction, mod 8.
    King(i8, i8),
    /// true = O-O, false = O-O-O.
    Castle(bool),
    /// (kind, list index 0..2, dx, dy) — absolute direction, mod 8.
    Piece(Kind, u8, i8, i8),
    /// (original file 0..7, dx, dy) — from the mover's own perspective.
    Pawn(u8, i8, i8),
    TwoByte,
    Ignore,
    StartVar,
    EndVar,
    Unknown(u8),
}

/// Canonical code table for encoding mode 0, from the Morphy format docs
/// ("Decoding the moves" table in moves.md). Deltas are mod 8.
fn canon_to_op(c: u8) -> Op {
    const KING: [(i8, i8); 8] = [
        (0, 1),
        (1, 1),
        (1, 0),
        (1, -1),
        (0, -1),
        (-1, -1),
        (-1, 0),
        (-1, 1),
    ];
    const KNIGHT: [(i8, i8); 8] = [
        (2, 1),
        (1, 2),
        (-1, 2),
        (-2, 1),
        (-2, -1),
        (-1, -2),
        (1, -2),
        (2, -1),
    ];
    const PAWN: [(i8, i8); 4] = [(0, 1), (0, 2), (1, 1), (-1, 1)];
    // Queen: 0-6 vertical, 7-13 horizontal, 14-20 NE diagonal, 21-27 SE diagonal.
    fn queen_delta(i: u8) -> (i8, i8) {
        match i {
            0..=6 => (0, i as i8 + 1),
            7..=13 => (i as i8 - 6, 0),
            14..=20 => (i as i8 - 13, i as i8 - 13),
            _ => (i as i8 - 20, -(i as i8 - 20)),
        }
    }
    fn rook_delta(i: u8) -> (i8, i8) {
        if i <= 6 {
            (0, i as i8 + 1)
        } else {
            (i as i8 - 6, 0)
        }
    }
    fn bishop_delta(i: u8) -> (i8, i8) {
        if i <= 6 {
            (i as i8 + 1, i as i8 + 1)
        } else {
            (i as i8 - 6, -(i as i8 - 6))
        }
    }
    match c {
        0 => Op::Null,
        1..=8 => {
            let (dx, dy) = KING[(c - 1) as usize];
            Op::King(dx, dy)
        }
        9 => Op::Castle(true),
        10 => Op::Castle(false),
        11..=38 => {
            let (dx, dy) = queen_delta(c - 11);
            Op::Piece(Kind::Queen, 0, dx, dy)
        }
        39..=52 => {
            let (dx, dy) = rook_delta(c - 39);
            Op::Piece(Kind::Rook, 0, dx, dy)
        }
        53..=66 => {
            let (dx, dy) = rook_delta(c - 53);
            Op::Piece(Kind::Rook, 1, dx, dy)
        }
        67..=80 => {
            let (dx, dy) = bishop_delta(c - 67);
            Op::Piece(Kind::Bishop, 0, dx, dy)
        }
        81..=94 => {
            let (dx, dy) = bishop_delta(c - 81);
            Op::Piece(Kind::Bishop, 1, dx, dy)
        }
        95..=102 => {
            let (dx, dy) = KNIGHT[(c - 95) as usize];
            Op::Piece(Kind::Knight, 0, dx, dy)
        }
        103..=110 => {
            let (dx, dy) = KNIGHT[(c - 103) as usize];
            Op::Piece(Kind::Knight, 1, dx, dy)
        }
        111..=142 => {
            let file = (c - 111) / 4;
            let (dx, dy) = PAWN[((c - 111) % 4) as usize];
            Op::Pawn(file, dx, dy)
        }
        143..=170 => {
            let (dx, dy) = queen_delta(c - 143);
            Op::Piece(Kind::Queen, 1, dx, dy)
        }
        171..=198 => {
            let (dx, dy) = queen_delta(c - 171);
            Op::Piece(Kind::Queen, 2, dx, dy)
        }
        199..=212 => {
            let (dx, dy) = rook_delta(c - 199);
            Op::Piece(Kind::Rook, 2, dx, dy)
        }
        213..=226 => {
            let (dx, dy) = bishop_delta(c - 213);
            Op::Piece(Kind::Bishop, 2, dx, dy)
        }
        227..=234 => {
            let (dx, dy) = KNIGHT[(c - 227) as usize];
            Op::Piece(Kind::Knight, 2, dx, dy)
        }
        CODE_TWO_BYTE => Op::TwoByte,
        CODE_IGNORE => Op::Ignore,
        CODE_START_VAR => Op::StartVar,
        CODE_END_VAR => Op::EndVar,
        other => Op::Unknown(other),
    }
}

// ---------------------------------------------------------------------------
// CB piece tracking (mirrors the format's piece-list semantics)
// ---------------------------------------------------------------------------

/// Square index in CB order: file * 8 + rank (a1=0, a2=1, ..., h8=63).
type CbSq = u8;

fn sq_file(sq: CbSq) -> i8 {
    (sq / 8) as i8
}
fn sq_rank(sq: CbSq) -> i8 {
    (sq % 8) as i8
}
fn sq_from(file: i8, rank: i8) -> CbSq {
    (file.rem_euclid(8) * 8 + rank.rem_euclid(8)) as u8
}
fn to_shak(sq: CbSq) -> Square {
    Square::from_coords(
        shakmaty::File::new(sq_file(sq) as u32),
        Rank::new(sq_rank(sq) as u32),
    )
}

#[derive(Clone, Copy, PartialEq)]
struct CbPiece {
    white: bool,
    kind: Kind,
    /// Index into the piece list for this (colour, kind); pawns by original file.
    idx: u8,
}

/// Board + piece lists as the CB encoding sees them. Follows the format's
/// bookkeeping exactly: captured non-pawn pieces shift later same-kind pieces
/// down one slot; pawn list slots are fixed by starting file and never reused;
/// en-passant victims are left in place (later overwritten), as documented.
#[derive(Clone)]
struct CbState {
    board: [Option<CbPiece>; 64],
    /// lists[white? 0:6 + kind][slot] = square. King uses slot 0 only.
    lists: [[Option<CbSq>; 8]; 12],
}

impl CbState {
    fn empty() -> CbState {
        CbState {
            board: [None; 64],
            lists: [[None; 8]; 12],
        }
    }

    fn initial() -> CbState {
        let mut s = CbState::empty();
        let back: [(Kind, i8); 8] = [
            (Kind::Rook, 0),
            (Kind::Knight, 1),
            (Kind::Bishop, 2),
            (Kind::Queen, 3),
            (Kind::King, 4),
            (Kind::Bishop, 5),
            (Kind::Knight, 6),
            (Kind::Rook, 7),
        ];
        for white in [true, false] {
            let home = if white { 0 } else { 7 };
            let pawn_rank = if white { 1 } else { 6 };
            for &(kind, file) in &back {
                s.place(white, kind, sq_from(file, home));
            }
            for file in 0..8 {
                s.place(white, Kind::Pawn, sq_from(file, pawn_rank));
            }
        }
        s
    }

    fn list_index(white: bool, kind: Kind) -> usize {
        (if white { 0 } else { 6 }) + kind as usize
    }

    /// Add a piece in "encounter order": first free slot of its list. This is
    /// the documented setup-position rule — the order pieces are listed in the
    /// setup bitstream determines which is the "first piece", *including
    /// pawns* (the a-pawn/…/h-pawn codes address the 1st..8th pawn in that
    /// order). From the initial position, encounter order in a1..h8 scan
    /// order coincides with the a..h file order the code table describes.
    fn place(&mut self, white: bool, kind: Kind, sq: CbSq) {
        let li = Self::list_index(white, kind);
        let slot = if kind == Kind::King {
            0
        } else {
            match self.lists[li].iter().position(|s| s.is_none()) {
                Some(p) => p,
                None => return, // more than 8 of a kind: unaddressable, drop
            }
        };
        self.lists[li][slot] = Some(sq);
        self.board[sq as usize] = Some(CbPiece {
            white,
            kind,
            idx: slot as u8,
        });
    }

    fn list_get(&self, white: bool, kind: Kind, slot: u8) -> Option<CbSq> {
        self.lists[Self::list_index(white, kind)][slot as usize]
    }

    /// Handle a capture on `sq`: non-pawn, non-king victims shift later
    /// same-kind pieces down one list slot (the documented "pieces shift one
    /// step" rule). Pawns/kings are simply overwritten.
    fn capture_at(&mut self, sq: CbSq) {
        let Some(victim) = self.board[sq as usize] else {
            return;
        };
        if victim.kind == Kind::Pawn || victim.kind == Kind::King {
            return;
        }
        let li = Self::list_index(victim.white, victim.kind);
        for slot in victim.idx as usize..7 {
            self.lists[li][slot] = self.lists[li][slot + 1];
        }
        self.lists[li][7] = None;
        for cell in self.board.iter_mut() {
            if let Some(p) = cell {
                if p.white == victim.white && p.kind == victim.kind && p.idx > victim.idx {
                    p.idx -= 1;
                }
            }
        }
    }

    /// Move the piece on `from` to `to`, updating list + board (no promotion).
    fn shift_piece(&mut self, from: CbSq, to: CbSq) -> Result<(), String> {
        let piece = self.board[from as usize].ok_or("no piece on source square")?;
        self.capture_at(to);
        self.board[from as usize] = None;
        self.lists[Self::list_index(piece.white, piece.kind)][piece.idx as usize] = Some(to);
        self.board[to as usize] = Some(piece);
        Ok(())
    }

    /// Promotion: pawn disappears (its list slot is retired, as documented —
    /// pawn references never change), promoted piece takes the first free slot.
    fn promote(&mut self, from: CbSq, to: CbSq, kind: Kind) -> Result<(), String> {
        let piece = self.board[from as usize].ok_or("no pawn on source square")?;
        if piece.kind != Kind::Pawn {
            return Err("promotion source is not a pawn".into());
        }
        self.capture_at(to);
        self.board[from as usize] = None;
        let li = Self::list_index(piece.white, kind);
        let slot = self.lists[li].iter().position(|s| s.is_none());
        if let Some(slot) = slot {
            self.lists[li][slot] = Some(to);
            self.board[to as usize] = Some(CbPiece {
                white: piece.white,
                kind,
                idx: slot as u8,
            });
        } else {
            self.board[to as usize] = None; // >8 of a kind: untracked
        }
        Ok(())
    }

    /// Rook relocation for castling: corner rook (relative to `white`) moves
    /// next to the king; mirrors the documented castling side effect.
    fn castle_rook(&mut self, white: bool, short: bool) {
        let home: i8 = if white { 0 } else { 7 };
        let (from, to) = if short {
            (sq_from(7, home), sq_from(5, home))
        } else {
            (sq_from(0, home), sq_from(3, home))
        };
        if self.board[from as usize].is_some() {
            let _ = self.shift_piece(from, to);
        }
    }
}

// ---------------------------------------------------------------------------
// Setup positions
// ---------------------------------------------------------------------------

/// MSB-first bit reader over the 24-byte setup bitstream.
struct BitReader<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> BitReader<'a> {
    fn take(&mut self, n: usize) -> Option<u32> {
        let mut v = 0u32;
        for _ in 0..n {
            let byte = *self.data.get(self.pos / 8)?;
            let bit = (byte >> (7 - self.pos % 8)) & 1;
            v = (v << 1) | bit as u32;
            self.pos += 1;
        }
        Some(v)
    }
}

/// Decode the 28-byte setup-position block (Morphy moves.md, "Setup position").
/// Returns the start position, CB tracking state, FEN tag, and move numbering.
fn decode_setup(
    data: &[u8],
) -> Result<(Chess, CbState, Option<String>, u32, bool), CbhError> {
    let bad = |m: &str| CbhError::BadSetup(m.to_string());
    let ep_file = data[1] & 0x0F;
    let black_to_move = data[1] & 0x10 != 0;
    let castle = data[2];
    let next_move = data[3] as u32;

    let mut cb = CbState::empty();
    let mut board = shakmaty::Board::empty();
    let mut bits = BitReader {
        data: &data[4..28],
        pos: 0,
    };
    for sq in 0u8..64 {
        match bits.take(1) {
            Some(0) => continue,
            Some(_) => {}
            None => break, // stream padded with zeros / exhausted
        }
        let code = 16 + bits.take(4).ok_or_else(|| bad("truncated bitstream"))?;
        let (white, kind) = match code {
            17 => (true, Kind::King),
            18 => (true, Kind::Queen),
            19 => (true, Kind::Knight),
            20 => (true, Kind::Bishop),
            21 => (true, Kind::Rook),
            22 => (true, Kind::Pawn),
            25 => (false, Kind::King),
            26 => (false, Kind::Queen),
            27 => (false, Kind::Knight),
            28 => (false, Kind::Bishop),
            29 => (false, Kind::Rook),
            30 => (false, Kind::Pawn),
            _ => return Err(bad("invalid piece code in setup bitstream")),
        };
        cb.place(white, kind, sq);
        board.set_piece_at(
            to_shak(sq),
            Piece {
                color: if white { Color::White } else { Color::Black },
                role: kind.role(),
            },
        );
    }

    // Castling rights only where king+rook actually stand on their standard
    // home squares (standard-chess subset; anything else is unrepresentable).
    let mut rights = Bitboard::EMPTY;
    let piece_at = |b: &shakmaty::Board, s: Square, c: Color, r: Role| {
        b.piece_at(s) == Some(Piece { color: c, role: r })
    };
    let wk = piece_at(&board, Square::E1, Color::White, Role::King);
    let bk = piece_at(&board, Square::E8, Color::Black, Role::King);
    if castle & 0x01 != 0 && wk && piece_at(&board, Square::A1, Color::White, Role::Rook) {
        rights |= Bitboard::from(Square::A1);
    }
    if castle & 0x02 != 0 && wk && piece_at(&board, Square::H1, Color::White, Role::Rook) {
        rights |= Bitboard::from(Square::H1);
    }
    if castle & 0x04 != 0 && bk && piece_at(&board, Square::A8, Color::Black, Role::Rook) {
        rights |= Bitboard::from(Square::A8);
    }
    if castle & 0x08 != 0 && bk && piece_at(&board, Square::H8, Color::Black, Role::Rook) {
        rights |= Bitboard::from(Square::H8);
    }

    let ep_square = if (1..=8).contains(&ep_file) {
        Some(Square::from_coords(
            shakmaty::File::new(ep_file as u32 - 1),
            if black_to_move { Rank::Third } else { Rank::Sixth },
        ))
    } else {
        None
    };

    let fullmoves = next_move.max(1);
    let mut setup = Setup::empty();
    setup.board = board;
    setup.turn = if black_to_move {
        Color::Black
    } else {
        Color::White
    };
    setup.castling_rights = rights;
    setup.ep_square = ep_square;
    setup.halfmoves = 0;
    setup.fullmoves = NonZeroU32::new(fullmoves).unwrap();

    // Some real databases carry stale ep/castling bits; degrade gracefully.
    let pos = Chess::from_setup(setup.clone(), CastlingMode::Standard)
        .or_else(|_e| {
            let mut s = setup.clone();
            s.ep_square = None;
            Chess::from_setup(s, CastlingMode::Standard)
        })
        .or_else(|_e| {
            let mut s = setup.clone();
            s.ep_square = None;
            s.castling_rights = Bitboard::EMPTY;
            Chess::from_setup(s, CastlingMode::Standard)
        })
        .map_err(|e: shakmaty::PositionError<Chess>| bad(&e.to_string()))?;

    let fen = Fen::from_position(&pos, EnPassantMode::Legal).to_string();
    Ok((pos, cb, Some(fen), fullmoves, !black_to_move))
}

// ---------------------------------------------------------------------------
// Game tree (built during decode, serialized to PGN movetext)
// ---------------------------------------------------------------------------

struct Edge {
    san: String,
    /// Absolute half-move index of this move (0 = first move of the game).
    ply: u32,
    child: usize,
    nags: Vec<u8>,
    comment_before: Option<String>,
    comment_after: Option<String>,
}

#[derive(Default)]
struct Node {
    edges: Vec<Edge>,
}

struct Tree {
    nodes: Vec<Node>,
    dropped_variations: u32,
    mainline_truncated: bool,
}

impl Tree {
    fn mainline_plies(&self) -> u32 {
        let mut n = 0;
        let mut cur = 0usize;
        while let Some(e) = self.nodes[cur].edges.first() {
            n += 1;
            cur = e.child;
        }
        n
    }
}

/// Annotations for one move (or the game start at key 0).
#[derive(Default)]
struct Ann {
    before: Vec<String>,
    after: Vec<String>,
    nags: Vec<u8>,
    /// Colored square highlights, raw `(color, square)` bytes (type 0x04).
    gfx_squares: Vec<(u8, u8)>,
    /// Colored arrows, raw `(color, from, to)` bytes (type 0x05).
    gfx_arrows: Vec<(u8, u8, u8)>,
}

impl Ann {
    fn text_joined(&self) -> Option<String> {
        let all: Vec<&str> = self
            .before
            .iter()
            .chain(self.after.iter())
            .map(|s| s.as_str())
            .collect();
        if all.is_empty() {
            None
        } else {
            Some(all.join(" "))
        }
    }

    /// Render graphical squares/arrows as PGN `[%csl]`/`[%cal]` comment tags —
    /// the target format the frontend PGN importer already maps onto game-tree
    /// node arrows (packages/core/src/pgn.ts), so imported shapes render like
    /// user-drawn ones. `[%csl]` precedes `[%cal]`, mirroring the chessops
    /// `makeComment` order the importer canonicalizes to.
    fn graphics_tag(&self) -> Option<String> {
        let csl: Vec<String> = self
            .gfx_squares
            .iter()
            .filter_map(|&(c, sq)| Some(format!("{}{}", gfx_color(c)?, gfx_square(sq)?)))
            .collect();
        let cal: Vec<String> = self
            .gfx_arrows
            .iter()
            .filter_map(|&(c, from, to)| {
                Some(format!("{}{}{}", gfx_color(c)?, gfx_square(from)?, gfx_square(to)?))
            })
            .collect();
        let mut out = String::new();
        if !csl.is_empty() {
            out.push_str(&format!("[%csl {}]", csl.join(",")));
        }
        if !cal.is_empty() {
            out.push_str(&format!("[%cal {}]", cal.join(",")));
        }
        (!out.is_empty()).then_some(out)
    }
}

/// 1-based graphical-annotation square (1=a1, 2=a2, 9=b1, ..., 64=h8 — the
/// same file-major order as move encoding, per the morphy cbh-format docs
/// cited in the module header) to algebraic; None if out of range.
fn gfx_square(b: u8) -> Option<String> {
    let i = b.checked_sub(1)?;
    if i >= 64 {
        return None;
    }
    Some(format!("{}{}", (b'a' + i / 8) as char, (b'1' + i % 8) as char))
}

/// Graphical-annotation color byte to a `[%csl]`/`[%cal]` brush letter
/// (morphy docs: 2=green, 3=yellow, 4=red). Unknown non-zero values stay
/// visible on the default green brush — the same fallback the frontend
/// applies to unrecognized brushes; 0 means "no shape".
fn gfx_color(c: u8) -> Option<char> {
    match c {
        0 => None,
        3 => Some('Y'),
        4 => Some('R'),
        _ => Some('G'),
    }
}

const MAX_MOVES: u32 = 20_000;
const MAX_DEPTH: usize = 64;

struct Decoder<'a> {
    bytes: &'a [u8],
    idx: usize,
    /// Running move count modulo 256 — the de-obfuscation offset.
    count: u8,
    /// Absolute move sequence number in stream order (annotation key).
    seq: u32,
}

impl<'a> Decoder<'a> {
    fn canon_at(&self, i: usize) -> Option<u8> {
        self.bytes
            .get(i)
            .map(|&b| TRANSLATE[b.wrapping_sub(self.count) as usize])
    }
}

/// Decode a mode-0 move stream into a game tree. Mainline decode errors fail
/// the game; errors inside a variation drop that variation only (the stream is
/// resynchronised at the variation's end marker, which is identifiable without
/// board state).
fn decode_moves(
    bytes: &[u8],
    start_pos: Chess,
    start_cb: CbState,
    anns: &HashMap<u32, Ann>,
) -> Result<Tree, CbhError> {
    let mut tree = Tree {
        nodes: vec![Node::default()],
        dropped_variations: 0,
        mainline_truncated: false,
    };
    let mut dec = Decoder {
        bytes,
        idx: 0,
        count: 0,
        seq: 0,
    };
    let mut pos = start_pos;
    let mut cb = start_cb;
    let mut node = 0usize;
    let mut ply = 0u32;
    let mut mainline_done = false;
    // Branch points: (tree node, position, cb state, ply).
    let mut stack: Vec<(usize, Chess, CbState, u32)> = Vec::new();

    while dec.idx < dec.bytes.len() {
        let canon = dec.canon_at(dec.idx).unwrap();
        match canon_to_op(canon) {
            Op::Ignore => {
                dec.idx += 1;
            }
            Op::StartVar => {
                if stack.len() >= MAX_DEPTH {
                    return Err(CbhError::MoveDecode("variation nesting too deep".into()));
                }
                stack.push((node, pos.clone(), cb.clone(), ply));
                dec.idx += 1;
            }
            Op::EndVar => {
                dec.idx += 1;
                match stack.pop() {
                    Some((n, p, c, pl)) => {
                        node = n;
                        pos = p;
                        cb = c;
                        ply = pl;
                        mainline_done = true;
                    }
                    None => break, // end of game
                }
            }
            Op::Unknown(c) => {
                if !mainline_done {
                    return Err(CbhError::MoveDecode(format!("unknown move code {c}")));
                }
                tree.dropped_variations += 1;
                // Unknown codes still advance the move counter (they are not
                // special codes), keeping later bytes decodable.
                dec.idx += 1;
                dec.count = dec.count.wrapping_add(1);
                if !skim_variation(&mut dec) {
                    break;
                }
                match stack.pop() {
                    Some((n, p, c2, pl)) => {
                        node = n;
                        pos = p;
                        cb = c2;
                        ply = pl;
                    }
                    None => break,
                }
            }
            Op::Null if !mainline_done => {
                // Null move on the mainline: a ChessBase idiom (e.g. the game
                // was decided without a reply). The db layer can only replay
                // legal SAN, so truncate the mainline here; variations of
                // earlier moves (which follow in the stream) still decode.
                dec.idx += 1;
                dec.count = dec.count.wrapping_add(1);
                dec.seq += 1;
                tree.mainline_truncated = true;
                mainline_done = true;
                if !skim_variation(&mut dec) {
                    break;
                }
                match stack.pop() {
                    Some((n, p, c, pl)) => {
                        node = n;
                        pos = p;
                        cb = c;
                        ply = pl;
                    }
                    None => break,
                }
            }
            op => {
                // A move token (1-byte, 2-byte latch, or null in a variation).
                let result = apply_move_token(&mut dec, op, &mut pos, &mut cb);
                match result {
                    Ok((san, _is_null)) => {
                        let ann = anns.get(&dec.seq);
                        let child = tree.nodes.len();
                        tree.nodes.push(Node::default());
                        tree.nodes[node].edges.push(Edge {
                            san,
                            ply,
                            child,
                            nags: ann.map(|a| a.nags.clone()).unwrap_or_default(),
                            comment_before: ann.and_then(|a| join_texts(&a.before)),
                            // Graphical shapes ride in the after-comment as
                            // [%csl]/[%cal] tags next to any text.
                            comment_after: ann.and_then(|a| {
                                match (join_texts(&a.after), a.graphics_tag()) {
                                    (Some(t), Some(g)) => Some(format!("{t} {g}")),
                                    (Some(t), None) => Some(t),
                                    (None, g) => g,
                                }
                            }),
                        });
                        node = child;
                        ply += 1;
                        if dec.seq > MAX_MOVES {
                            return Err(CbhError::MoveDecode("too many moves".into()));
                        }
                    }
                    Err(e) => {
                        if !mainline_done {
                            return Err(CbhError::MoveDecode(e));
                        }
                        // Drop the rest of this variation, resync at its end.
                        tree.dropped_variations += 1;
                        if !skim_variation(&mut dec) {
                            break;
                        }
                        match stack.pop() {
                            Some((n, p, c, pl)) => {
                                node = n;
                                pos = p;
                                cb = c;
                                ply = pl;
                            }
                            None => break,
                        }
                    }
                }
            }
        }
    }
    Ok(tree)
}

fn join_texts(v: &[String]) -> Option<String> {
    if v.is_empty() {
        None
    } else {
        Some(v.join(" "))
    }
}

/// After a decode failure inside a variation: consume tokens (keeping the move
/// counter aligned) until the end marker that closes the current — broken —
/// line. Start markers seen while skimming open nested variations of the broken
/// line; their matching end markers are consumed too. Returns false if the
/// stream ran out.
fn skim_variation(dec: &mut Decoder) -> bool {
    let mut depth = 0usize;
    while dec.idx < dec.bytes.len() {
        let canon = dec.canon_at(dec.idx).unwrap();
        match canon {
            CODE_START_VAR => {
                depth += 1;
                dec.idx += 1;
            }
            CODE_END_VAR => {
                dec.idx += 1;
                if depth == 0 {
                    return true;
                }
                depth -= 1;
            }
            CODE_IGNORE => dec.idx += 1,
            CODE_TWO_BYTE => {
                dec.idx += 3;
                dec.count = dec.count.wrapping_add(1);
                dec.seq += 1;
            }
            c if c <= 234 => {
                dec.idx += 1;
                dec.count = dec.count.wrapping_add(1);
                dec.seq += 1;
            }
            _ => {
                // Unknown garbage: consume and count (not a special code).
                dec.idx += 1;
                dec.count = dec.count.wrapping_add(1);
            }
        }
    }
    false
}

/// Consume one move token (already classified as a move `Op`), resolve it
/// against the CB piece lists, validate + play it with shakmaty, and return
/// its SAN. On any inconsistency the caller decides whether it fails the game
/// (mainline) or just the enclosing variation.
fn apply_move_token(
    dec: &mut Decoder,
    op: Op,
    pos: &mut Chess,
    cb: &mut CbState,
) -> Result<(String, bool), String> {
    let white = pos.turn() == Color::White;
    // Two-byte moves read their payload with the *pre-increment* counter.
    let (from, to, promo): (CbSq, CbSq, Option<Kind>) = match op {
        Op::Null => {
            dec.idx += 1;
            dec.count = dec.count.wrapping_add(1);
            dec.seq += 1;
            // Null move: flip side to move (annotation lines use these).
            let mut setup = pos.to_setup(EnPassantMode::Legal);
            setup.turn = !setup.turn;
            setup.ep_square = None;
            *pos = Chess::from_setup(setup, CastlingMode::Standard)
                .map_err(|e| format!("null move: {e}"))?;
            return Ok(("--".to_string(), true));
        }
        Op::TwoByte => {
            if dec.idx + 2 >= dec.bytes.len() {
                dec.idx = dec.bytes.len();
                return Err("truncated two-byte move".into());
            }
            let b1 = TRANSLATE[dec.bytes[dec.idx + 1].wrapping_sub(dec.count) as usize];
            let b2 = TRANSLATE[dec.bytes[dec.idx + 2].wrapping_sub(dec.count) as usize];
            dec.idx += 3;
            dec.count = dec.count.wrapping_add(1);
            dec.seq += 1;
            let word = u16::from_be_bytes([b1, b2]);
            let from = (word & 0x3F) as CbSq;
            let to = ((word >> 6) & 0x3F) as CbSq;
            let promo_code = (word >> 12) & 0x3;
            if from == to {
                // src == dst encodes Chess960 castling; not valid in mode 0.
                return Err("two-byte move with identical squares".into());
            }
            let src = cb.board[from as usize].ok_or("two-byte move from empty square")?;
            let last_rank = if src.white { 7 } else { 0 };
            let promo = if src.kind == Kind::Pawn && sq_rank(to) == last_rank {
                Some(match promo_code {
                    0 => Kind::Queen,
                    1 => Kind::Rook,
                    2 => Kind::Bishop,
                    _ => Kind::Knight,
                })
            } else {
                None
            };
            (from, to, promo)
        }
        Op::King(dx, dy) => {
            dec.idx += 1;
            dec.count = dec.count.wrapping_add(1);
            dec.seq += 1;
            let from = cb.list_get(white, Kind::King, 0).ok_or("king not tracked")?;
            (from, sq_from(sq_file(from) + dx, sq_rank(from) + dy), None)
        }
        Op::Castle(short) => {
            dec.idx += 1;
            dec.count = dec.count.wrapping_add(1);
            dec.seq += 1;
            let from = cb.list_get(white, Kind::King, 0).ok_or("king not tracked")?;
            let dx = if short { 2 } else { -2 };
            let to = sq_from(sq_file(from) + dx, sq_rank(from));
            // Apply: move king, relocate rook, then validate via shakmaty.
            cb.shift_piece(from, to)?;
            cb.castle_rook(white, short);
            return play_and_san(pos, from, to, None);
        }
        Op::Piece(kind, slot, dx, dy) => {
            dec.idx += 1;
            dec.count = dec.count.wrapping_add(1);
            dec.seq += 1;
            let from = cb
                .list_get(white, kind, slot)
                .ok_or("referenced piece not on board")?;
            (from, sq_from(sq_file(from) + dx, sq_rank(from) + dy), None)
        }
        Op::Pawn(file, dx, dy) => {
            dec.idx += 1;
            dec.count = dec.count.wrapping_add(1);
            dec.seq += 1;
            let from = cb
                .list_get(white, Kind::Pawn, file)
                .ok_or("referenced pawn not on board")?;
            // Pawn deltas are from the mover's own perspective.
            let (dx, dy) = if white { (dx, dy) } else { (-dx, -dy) };
            (from, sq_from(sq_file(from) + dx, sq_rank(from) + dy), None)
        }
        Op::Ignore | Op::StartVar | Op::EndVar | Op::Unknown(_) => {
            unreachable!("non-move ops handled by caller")
        }
    };

    match promo {
        Some(kind) => cb.promote(from, to, kind)?,
        None => cb.shift_piece(from, to)?,
    }
    play_and_san(pos, from, to, promo)
}

/// Validate the resolved (from, to, promotion) against the real position and
/// play it, returning the SAN. This is the ground-truth legality gate: any
/// desync between CB tracking and the actual game surfaces here.
fn play_and_san(
    pos: &mut Chess,
    from: CbSq,
    to: CbSq,
    promo: Option<Kind>,
) -> Result<(String, bool), String> {
    let uci = UciMove::Normal {
        from: to_shak(from),
        to: to_shak(to),
        promotion: promo.map(Kind::role),
    };
    let m = uci
        .to_move(pos)
        .map_err(|e| format!("illegal move {uci}: {e}"))?;
    let san = SanPlus::from_move_and_play_unchecked(pos, m);
    Ok((san.to_string(), false))
}

// ---------------------------------------------------------------------------
// PGN movetext serialization
// ---------------------------------------------------------------------------

struct Serializer<'a> {
    tree: &'a Tree,
    out: String,
    start_fullmove: u32,
    start_white: bool,
}

impl<'a> Serializer<'a> {
    fn push_token(&mut self, tok: &str) {
        if !self.out.is_empty() {
            self.out.push(' ');
        }
        self.out.push_str(tok);
    }

    fn move_prefix(&self, ply: u32, force: bool) -> String {
        let white_to_move = if self.start_white {
            ply % 2 == 0
        } else {
            ply % 2 == 1
        };
        let fullmove = if self.start_white {
            self.start_fullmove + ply / 2
        } else {
            self.start_fullmove + (ply + 1) / 2
        };
        if white_to_move {
            format!("{fullmove}. ")
        } else if force {
            format!("{fullmove}... ")
        } else {
            String::new()
        }
    }

    /// Emit one move edge (comment-before, number, SAN, NAGs, comment-after);
    /// returns whether the *next* move needs a forced number.
    fn write_edge(&mut self, e: &Edge, force: bool) -> bool {
        let mut force = force;
        if let Some(c) = &e.comment_before {
            self.push_token(&format!("{{{}}}", sanitize_comment(c)));
            force = true;
        }
        let prefix = self.move_prefix(e.ply, force);
        self.push_token(&format!("{prefix}{}", e.san));
        let mut next_force = false;
        for nag in &e.nags {
            self.push_token(&format!("${nag}"));
            next_force = true;
        }
        if let Some(c) = &e.comment_after {
            self.push_token(&format!("{{{}}}", sanitize_comment(c)));
            next_force = true;
        }
        next_force
    }

    /// Emit the line starting at `node`: primary move, then each sibling
    /// variation parenthesized, then the primary continuation. The primary
    /// chain is iterative; recursion depth equals variation nesting only.
    fn write_line(&mut self, mut node: usize, mut force: bool) {
        loop {
            let n = &self.tree.nodes[node];
            let Some(primary) = n.edges.first() else {
                return;
            };
            // Null moves ("--") only ever appear inside variations here (a
            // mainline null fails the game upstream); pgn-reader tokenizes
            // them fine and the db layer never replays variation moves.
            let mut next_force = self.write_edge(primary, force);
            let child = primary.child;
            let var_count = n.edges.len() - 1;
            for e in &self.tree.nodes[node].edges[1..] {
                self.push_token("(");
                let f = self.write_edge(e, true);
                self.write_line(e.child, f);
                self.push_token(")");
            }
            if var_count > 0 {
                next_force = true;
            }
            node = child;
            force = next_force;
        }
    }
}

fn sanitize_comment(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            '{' => '(',
            '}' => ')',
            c if (c as u32) < 0x20 => ' ',
            c => c,
        })
        .collect::<String>()
        .trim()
        .to_string()
}

// ---------------------------------------------------------------------------
// Annotations (.cba) — text comments + symbol NAGs, best effort
// ---------------------------------------------------------------------------

/// Parse the annotation block for one game. Key 0 holds game-level/pre-game
/// text; key n (n >= 1) annotates the n-th move in stream order. Any
/// inconsistency aborts quietly (annotations are decorative).
fn parse_annotations(cba: &[u8], ofs: usize, game_id: u32) -> Option<HashMap<u32, Ann>> {
    let head = cba.get(ofs..ofs + 14)?;
    if be_u24(&head[0..3]) != game_id {
        return None;
    }
    let total = be_u32(&head[10..14]) as usize;
    let block = cba.get(ofs..ofs + total)?;
    let mut map: HashMap<u32, Ann> = HashMap::new();
    let mut p = 14usize;
    while p + 6 <= block.len() {
        let pos_raw = be_u24(&block[p..p + 3]);
        let kind = block[p + 3];
        // Length of the whole item including its 6-byte header. (Observed
        // big-endian in real databases, e.g. Mega, contrary to one doc note.)
        let len = be_u16(&block[p + 4..p + 6]) as usize;
        if len < 6 || p + len > block.len() {
            break;
        }
        let item = &block[p..p + len];
        // 0xFFFFFF = -1 = "game general"; treat like position 0 (pre-game).
        let key = if pos_raw == 0xFF_FFFF { 0 } else { pos_raw };
        match kind {
            0x02 | 0x82 => {
                // Text annotation: [6]=0, [7]=language, [8..]=text. Modern
                // bases store UTF-8; older ones ISO-8859-1 (0x9E = diagram).
                if item.len() > 8 {
                    let raw = &item[8..];
                    let text = match std::str::from_utf8(raw) {
                        Ok(s) => s.to_string(),
                        Err(_) => raw
                            .iter()
                            .map(|&b| if b == 0x9E { '#' } else { b as char })
                            .collect(),
                    };
                    let text = sanitize_comment(&text);
                    if !text.is_empty() {
                        let e = map.entry(key).or_default();
                        if kind == 0x82 {
                            e.before.push(text);
                        } else {
                            e.after.push(text);
                        }
                    }
                }
            }
            0x03 => {
                // Symbols: up to three single-byte standard NAG values
                // (move comment, position evaluation, prefix).
                let e = map.entry(key).or_default();
                for &b in item.iter().take(9).skip(6) {
                    if b != 0 {
                        e.nags.push(b);
                    }
                }
            }
            0x04 => {
                // Graphical squares: 2-byte entries (color, square), squares
                // 1-based file-major (1=a1, 2=a2, 9=b1). Layout per the morphy
                // cbh-format docs (annotations.md; see module header). A
                // trailing partial entry is ignored (best effort).
                let e = map.entry(key).or_default();
                for entry in item[6..].chunks_exact(2) {
                    e.gfx_squares.push((entry[0], entry[1]));
                }
            }
            0x05 => {
                // Graphical arrows: 3-byte entries (color, from, to), same
                // color/square conventions as 0x04.
                let e = map.entry(key).or_default();
                for entry in item[6..].chunks_exact(3) {
                    e.gfx_arrows.push((entry[0], entry[1], entry[2]));
                }
            }
            _ => {} // clocks, training, multimedia, ... out of MVP scope
        }
        p += len;
    }
    Some(map)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;
    use std::path::PathBuf;

    // -- table integrity ----------------------------------------------------

    #[test]
    fn translate_is_a_permutation() {
        let mut seen = [false; 256];
        for &v in TRANSLATE.iter() {
            assert!(!seen[v as usize], "duplicate value {v:#x}");
            seen[v as usize] = true;
        }
    }

    /// Composing TRANSLATE with the canonical code table must reproduce the
    /// per-piece byte maps published in cbh2pgn (spot checks across piece
    /// groups and every special code).
    #[test]
    fn translate_matches_published_piece_maps() {
        let canon = |raw: u8| TRANSLATE[raw as usize];
        // Special codes.
        assert_eq!(canon(0x29), CODE_TWO_BYTE);
        assert_eq!(canon(0xDC), CODE_START_VAR);
        assert_eq!(canon(0x0C), CODE_END_VAR);
        assert_eq!(canon(0x9F), CODE_IGNORE);
        assert_eq!(canon(0xAA), 0); // null move
        // King: 0x49 -> (0,1) is canonical code 1; castles.
        assert!(matches!(canon_to_op(canon(0x49)), Op::King(0, 1)));
        assert!(matches!(canon_to_op(canon(0x76)), Op::Castle(true)));
        assert!(matches!(canon_to_op(canon(0xB5)), Op::Castle(false)));
        // Queens 1..3 vertical step: (0,1).
        assert!(matches!(canon_to_op(canon(0xA5)), Op::Piece(Kind::Queen, 0, 0, 1)));
        assert!(matches!(canon_to_op(canon(0xE5)), Op::Piece(Kind::Queen, 1, 0, 1)));
        assert!(matches!(canon_to_op(canon(0x1A)), Op::Piece(Kind::Queen, 2, 0, 1)));
        // Rooks / bishops / knights across the three slots.
        assert!(matches!(canon_to_op(canon(0x4E)), Op::Piece(Kind::Rook, 0, 0, 1)));
        assert!(matches!(canon_to_op(canon(0x14)), Op::Piece(Kind::Rook, 1, 0, 1)));
        assert!(matches!(canon_to_op(canon(0x81)), Op::Piece(Kind::Rook, 2, 0, 1)));
        assert!(matches!(canon_to_op(canon(0x02)), Op::Piece(Kind::Bishop, 0, 1, 1)));
        assert!(matches!(canon_to_op(canon(0xF6)), Op::Piece(Kind::Bishop, 1, 1, 1)));
        assert!(matches!(canon_to_op(canon(0x51)), Op::Piece(Kind::Bishop, 2, 1, 1)));
        assert!(matches!(canon_to_op(canon(0x58)), Op::Piece(Kind::Knight, 0, 2, 1)));
        assert!(matches!(canon_to_op(canon(0xC4)), Op::Piece(Kind::Knight, 1, 2, 1)));
        assert!(matches!(canon_to_op(canon(0x9B)), Op::Piece(Kind::Knight, 2, 2, 1)));
        // Pawns: a-pawn single step / h-pawn capture left.
        assert!(matches!(canon_to_op(canon(0x2D)), Op::Pawn(0, 0, 1)));
        assert!(matches!(canon_to_op(canon(0x19)), Op::Pawn(7, -1, 1)));
        // Queen SE diagonal wraps mod 8: canonical 32 = (1,-1).
        assert!(matches!(canon_to_op(32), Op::Piece(Kind::Queen, 0, 1, -1)));
    }

    #[test]
    fn field_decoders() {
        assert_eq!(decode_result(2), "1-0");
        assert_eq!(decode_result(1), "1/2-1/2");
        assert_eq!(decode_result(0), "0-1");
        assert_eq!(decode_result(3), "*");
        // 1985.11.24 -> year 1985 << 9 | 11 << 5 | 24
        assert_eq!(decode_date(1985 << 9 | 11 << 5 | 24), "1985.11.24");
        assert_eq!(decode_date(1985 << 9), "1985.??.??");
        assert_eq!(decode_date(0), "????.??.??");
        // ECO: 1 = A00, 500 = E99; stored in bits 7-15.
        assert_eq!(decode_eco(1 << 7), "A00");
        assert_eq!(decode_eco(500 << 7), "E99");
        assert_eq!(decode_eco(198 << 7), "B97");
        assert_eq!(decode_eco(0), "");
    }

    // -- graphical annotations (.cba types 0x04/0x05) -------------------------

    /// Raw stream byte that decodes to canonical code `canon` at counter
    /// `count` (TRANSLATE is a permutation, so the inverse is unique).
    fn obfuscate(canon: u8, count: u8) -> u8 {
        let idx = TRANSLATE.iter().position(|&v| v == canon).unwrap() as u8;
        idx.wrapping_add(count)
    }

    #[test]
    fn graphical_squares_and_arrows_land_on_the_annotated_ply() {
        // Hand-built .cba block for game 1: annotation key 2 (the second move
        // in stream order) carries a squares record (green c4, red e5) and an
        // arrows record (green e2->e4). Square bytes are 1-based file-major:
        // c4 = 2*8+3+1 = 20, e5 = 37, e2 = 34, e4 = 36.
        let mut cba = vec![0u8, 0, 1]; // game id (BE u24)
        cba.extend_from_slice(&[0; 7]); // header bytes 3..10 (unused here)
        cba.extend_from_slice(&33u32.to_be_bytes()); // total block length
        // squares item: pos=2, kind=0x04, len=10, entries (2,c4) (4,e5)
        cba.extend_from_slice(&[0, 0, 2, 0x04, 0, 10, 2, 20, 4, 37]);
        // arrows item: pos=2, kind=0x05, len=9, entry (2,e2,e4)
        cba.extend_from_slice(&[0, 0, 2, 0x05, 0, 9, 2, 34, 36]);
        assert_eq!(cba.len(), 33);

        let anns = parse_annotations(&cba, 0, 1).expect("annotation block parses");

        // Move stream: 1. a3 a6, then end-of-game. TRANSLATE[0x2D] is
        // Pawn(0,0,1) (see the piece-map test above); black pawn deltas are
        // mirrored by the decoder, so the same op plays ...a6.
        let pawn_a_fwd = TRANSLATE[0x2D];
        let moves = [
            obfuscate(pawn_a_fwd, 0),
            obfuscate(pawn_a_fwd, 1),
            obfuscate(CODE_END_VAR, 2),
        ];
        let tree = decode_moves(&moves, Chess::default(), CbState::initial(), &anns)
            .expect("move stream decodes");

        let first = &tree.nodes[0].edges[0];
        assert_eq!(first.san, "a3");
        assert_eq!(first.comment_after, None, "shapes must not leak onto ply 0");
        let second = &tree.nodes[first.child].edges[0];
        assert_eq!(second.san, "a6");
        assert_eq!(second.ply, 1);
        assert_eq!(
            second.comment_after.as_deref(),
            Some("[%csl Gc4,Re5][%cal Ge2e4]")
        );
    }

    // -- fixture-backed golden tests -----------------------------------------

    fn testset(name: &str) -> Option<PathBuf> {
        let home = std::env::var("HOME").ok()?;
        let p = PathBuf::from(home).join("Documents/ChessBase/Testsets").join(name);
        if p.exists() {
            Some(p)
        } else {
            eprintln!("SKIP: fixture {} not present", p.display());
            None
        }
    }

    /// Convert every game; return (converted, per-kind skip/error counts).
    fn convert_all(db: &CbhDb) -> (Vec<ConvertedGame>, HashMap<&'static str, u32>) {
        let mut ok = Vec::new();
        let mut errs: HashMap<&'static str, u32> = HashMap::new();
        for id in 1..=db.game_count() {
            match db.convert_game(id) {
                Ok(g) => ok.push(g),
                Err(e) => *errs.entry(e.kind()).or_default() += 1,
            }
        }
        (ok, errs)
    }

    #[test]
    fn nunn_fixture_full_conversion() {
        let Some(path) = testset("nunn.cbh") else { return };
        let db = CbhDb::open(&path).unwrap();
        assert_eq!(db.game_count(), 10, "nunn.cbh is a 10-game test set");
        let (ok, errs) = convert_all(&db);
        assert_eq!(ok.len(), 10, "all games convert: errors={errs:?}");
        // Names resolve through the .cbp index. nunn.cbh is an opening test
        // set: "White" carries the position name ("Sveshnikov", "French", …)
        // and Black is a genuinely empty player entity.
        assert!(
            ok.iter().all(|g| g.white != "?"),
            "white names resolve: {:?}",
            ok.iter().map(|g| g.white.as_str()).collect::<Vec<_>>()
        );
        assert!(
            ok.iter().any(|g| g.white == "Sveshnikov"),
            "known fixture name present"
        );
        // Every game replays legally end-to-end through the real import path.
        let mut sqlite = Db::open_in_memory().unwrap();
        let all_pgn: String = ok.iter().map(|g| g.pgn.as_str()).collect::<Vec<_>>().join("\n");
        let rep = sqlite.import_pgn_str(&all_pgn, "cbh:nunn").unwrap();
        assert_eq!(rep.errors, 0, "no illegal movetext");
        assert_eq!(rep.imported + rep.dups_skipped, 10);
        assert!(ok.iter().all(|g| g.mainline_plies > 0));
    }

    #[test]
    fn nunn2_fixture_full_conversion() {
        let Some(path) = testset("Nunn2.cbh") else { return };
        let db = CbhDb::open(&path).unwrap();
        assert_eq!(db.game_count(), 25, "Nunn2.cbh is a 25-game test set");
        let (ok, errs) = convert_all(&db);
        assert_eq!(ok.len(), 25, "all games convert: errors={errs:?}");
        let mut sqlite = Db::open_in_memory().unwrap();
        let all_pgn: String = ok.iter().map(|g| g.pgn.as_str()).collect::<Vec<_>>().join("\n");
        let rep = sqlite.import_pgn_str(&all_pgn, "cbh:nunn2").unwrap();
        assert_eq!(rep.errors, 0);
        assert_eq!(rep.imported + rep.dups_skipped, 25);
    }

    #[test]
    fn marathon_fixture_conversion_and_reimport() {
        let Some(path) = testset("Marathon.cbh") else { return };
        let db = CbhDb::open(&path).unwrap();
        assert_eq!(db.game_count(), 210, "Marathon.cbh has 210 records");
        let (ok, errs) = convert_all(&db);
        // Marathon mixes annotated games and odd records; demand a high rate
        // but don't hard-require 100% — unexplained residue shows up in errs.
        assert!(
            ok.len() as f64 >= 0.95 * 210.0,
            "≥95% of games convert; got {} with errors={errs:?}",
            ok.len()
        );
        let mut sqlite = Db::open_in_memory().unwrap();
        let all_pgn: String = ok.iter().map(|g| g.pgn.as_str()).collect::<Vec<_>>().join("\n");
        let rep = sqlite.import_pgn_str(&all_pgn, "cbh:marathon").unwrap();
        assert_eq!(
            rep.errors, 0,
            "everything we converted replays legally through pgn-reader"
        );
        assert_eq!(rep.imported + rep.dups_skipped, ok.len() as u64);
    }

    #[test]
    fn marathon_first_and_last_games_look_sane() {
        let Some(path) = testset("Marathon.cbh") else { return };
        let db = CbhDb::open(&path).unwrap();
        let first = db.convert_game(1).unwrap();
        let last = db.convert_game(db.game_count()).unwrap();
        for g in [&first, &last] {
            assert!(g.pgn.contains("[White \""));
            assert!(g.pgn.contains("[Result \""));
            assert!(g.mainline_plies > 0, "non-empty mainline: {}", g.pgn);
        }
    }
}
