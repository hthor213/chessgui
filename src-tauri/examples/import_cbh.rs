//! Import a ChessBase CBH database into a scratch SQLite DB via the real
//! backend (spec 200 phase 4 acceptance harness).
//!
//! Parses the .cbh/.cbg/.cbp/.cbt/.cba file set (see src/cbh.rs for format
//! provenance), converts each game to PGN and pushes it through the exact
//! `Db::import_pgn_str` path the app uses, so dedup + position indexing are
//! exercised end-to-end. Prints a parse/convert/import breakdown with an
//! error taxonomy and a sample of failing record ids.
//!
//! Run with:
//!   cd src-tauri && cargo run --release --example import_cbh -- \
//!       ~/Documents/ChessBase/Testsets/nunn.cbh /tmp/cbh_scratch.sqlite
//!   ... optionally: --limit 5000
//!
//! The target DB is a scratch path you pass in — never the app database.

use std::collections::BTreeMap;
use std::time::Instant;

use chessgui_lib::cbh::CbhDb;
use chessgui_lib::db::Db;

fn main() {
    let mut cbh_path = None;
    let mut db_path = None;
    let mut limit: Option<u32> = None;
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--limit" => {
                limit = args
                    .next()
                    .and_then(|v| v.parse().ok())
                    .or_else(|| die("--limit needs a number"));
            }
            _ if cbh_path.is_none() => cbh_path = Some(a),
            _ if db_path.is_none() => db_path = Some(a),
            other => {
                die::<()>(&format!("unexpected argument: {other}"));
            }
        }
    }
    let (Some(cbh_path), Some(db_path)) = (cbh_path, db_path) else {
        die::<()>("usage: import_cbh <path.cbh> <scratch.sqlite> [--limit N]");
        return;
    };

    let basename = std::path::Path::new(&cbh_path)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "unknown".to_string());
    let source = format!("cbh:{basename}");

    let t_open = Instant::now();
    let cbh = CbhDb::open(&cbh_path).unwrap_or_else(|e| die(&format!("open {cbh_path}: {e}")));
    let mut db = Db::open(&db_path).unwrap_or_else(|e| die(&format!("open db {db_path}: {e}")));
    let total = cbh.game_count();
    let n = limit.map(|l| l.min(total)).unwrap_or(total);
    println!(
        "opened {cbh_path}: {total} records ({:.2}s); processing {n}",
        t_open.elapsed().as_secs_f64()
    );

    let mut converted = 0u64;
    let mut dropped_vars = 0u64;
    let mut truncated = 0u64;
    let mut with_anns = 0u64;
    let mut taxonomy: BTreeMap<&'static str, u64> = BTreeMap::new();
    let mut failed_samples: BTreeMap<&'static str, Vec<u32>> = BTreeMap::new();
    let mut imported = 0u64;
    let mut dups = 0u64;
    let mut db_errors = 0u64;

    let t0 = Instant::now();
    let mut buf = String::new();
    let flush = |db: &mut Db, buf: &mut String| {
        if buf.is_empty() {
            return (0u64, 0u64, 0u64);
        }
        let rep = db
            .import_pgn_str(buf, &source)
            .unwrap_or_else(|e| die(&format!("sqlite import: {e}")));
        buf.clear();
        (rep.imported, rep.dups_skipped, rep.errors)
    };

    for id in 1..=n {
        match cbh.convert_game(id) {
            Ok(g) => {
                converted += 1;
                dropped_vars += g.dropped_variations as u64;
                truncated += g.mainline_truncated as u64;
                with_anns += g.has_annotations as u64;
                buf.push_str(&g.pgn);
                buf.push('\n');
                if converted % 1000 == 0 {
                    let (i, d, e) = flush(&mut db, &mut buf);
                    imported += i;
                    dups += d;
                    db_errors += e;
                }
            }
            Err(e) => {
                let kind = e.kind();
                *taxonomy.entry(kind).or_default() += 1;
                let sample = failed_samples.entry(kind).or_default();
                if sample.len() < 10 {
                    sample.push(id);
                }
            }
        }
    }
    let (i, d, e) = flush(&mut db, &mut buf);
    imported += i;
    dups += d;
    db_errors += e;
    let dt = t0.elapsed().as_secs_f64();

    let failed: u64 = taxonomy.values().sum();
    println!("\n=== CBH import report ===");
    println!("records processed : {n}");
    println!(
        "parsed+converted  : {converted} ({:.2}%)",
        100.0 * converted as f64 / n.max(1) as f64
    );
    println!("skipped/failed    : {failed}");
    for (kind, count) in &taxonomy {
        println!(
            "  {kind:<22} {count:>8}  sample ids: {:?}",
            failed_samples.get(kind).unwrap()
        );
    }
    println!("imported          : {imported}");
    println!("dups skipped      : {dups}");
    println!("db-layer errors   : {db_errors} (converted PGN that failed re-parse/replay)");
    println!("games w/ comments : {with_anns}");
    println!("variations dropped: {dropped_vars} (decode errors inside variations)");
    println!("mainlines trunc.  : {truncated} (null move on the stored mainline)");
    println!(
        "throughput        : {:.0} games/s ({:.2}s total)",
        converted as f64 / dt.max(1e-9),
        dt
    );
}

fn die<T>(msg: &str) -> T {
    eprintln!("{msg}");
    std::process::exit(2);
}
