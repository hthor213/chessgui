//! Import a reference pack into a scratch SQLite DB via the real backend.
//!
//! This is the "promotion" step of the reference-database pipeline: it takes a
//! filtered .pgn produced by `scripts/build_reference_pack.py` (staging) and
//! imports it through the exact same `Db::import_pgn_file` path the app uses,
//! reporting imported / dups_skipped / errors. The target is a scratch DB
//! path you pass in — it never touches any user database.
//!
//! Re-running against the same DB proves idempotency: the second run should
//! report the same count as `dups_skipped` and import 0 (dedup happens in the
//! backend on a content hash).
//!
//! Run with:
//!   cd src-tauri && cargo run --example import_smoke -- \
//!       ../data/reference/pack_2013-01.pgn /tmp/refpack_scratch.sqlite \
//!       "lichess:2013-01 600+5 1900+"

use chessgui_lib::db::Db;

fn main() {
    let mut args = std::env::args().skip(1);
    let pgn = args.next().unwrap_or_else(|| {
        eprintln!("usage: import_smoke <pack.pgn> <scratch.sqlite> [source]");
        std::process::exit(2);
    });
    let db_path = args
        .next()
        .unwrap_or_else(|| "/tmp/refpack_scratch.sqlite".to_string());
    let source = args
        .next()
        .unwrap_or_else(|| "reference-pack".to_string());

    let mut db = Db::open(&db_path).expect("open scratch db");

    let before = db.stats().expect("stats");
    println!(
        "DB {db_path}\n  before: {} games, {} positions",
        before.games, before.positions
    );

    let t = std::time::Instant::now();
    let rep = db
        .import_pgn_file(&pgn, &source)
        .expect("import_pgn_file failed");
    let secs = t.elapsed().as_secs_f64();

    let after = db.stats().expect("stats");
    println!(
        "  import: {} imported, {} dups_skipped, {} errors  ({:.2}s, {:.0} games/s)",
        rep.imported,
        rep.dups_skipped,
        rep.errors,
        secs,
        (rep.imported as f64) / secs.max(1e-6)
    );
    println!(
        "  after : {} games, {} positions",
        after.games, after.positions
    );
}
