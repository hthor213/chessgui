# material-backfill

Out-of-process material-signature indexer for ChessGUI's `games.db`
(spec 200 material search). Exists because the in-app v4 backfill hung the
desktop app: replaying ~1M pre-v4 games in one transaction inside `Db::open`
pegged a core for the whole run and rolled everything back on force-quit.
The app no longer backfills at open; this tool does it, in 1,000-game
committed batches, resumable from wherever it stopped.

```bash
cargo build --release   # deps: rusqlite (bundled sqlite) + shakmaty only

# Index everything un-indexed; safe to interrupt at any time (loses <1 batch)
material-backfill backfill /path/to/games.db [--batch 1000]

# Portable dump of game_material as (dup_hash <TAB> signature) rows.
# Works mid-backfill — you get whatever is committed so far.
material-backfill export /path/to/games.db sigs.tsv

# Merge a dump into another copy of the database. Joins on games.dup_hash
# (stable across DBs; rowids are not). INSERT OR IGNORE — reruns are free.
material-backfill import /path/to/games.db sigs.tsv [--batch 1000]
```

## Performance

Release build: ~23k games/s on Apple Silicon — a 956k-game database indexes
in under a minute, run locally. The export/import pair and the remote flow
below exist for jobs that are genuinely long, not for this one.

## Remote flow (homeserver)

For heavy future reindexing jobs where the laptop shouldn't do the work:

```bash
sqlite3 games.db ".backup /tmp/snapshot.db"        # consistent copy, app may run
rsync /tmp/snapshot.db hjalti@homeserver:work/
ssh hjalti@homeserver systemd-run --user --unit=material-backfill \
    -p CPUQuota=15% work/material-backfill backfill work/snapshot.db
# ...later, trickle results back (idempotent, partial is fine):
ssh hjalti@homeserver work/material-backfill export work/snapshot.db work/sigs.tsv
rsync hjalti@homeserver:work/sigs.tsv /tmp/ && material-backfill import games.db /tmp/sigs.tsv
```

The signature logic (`material_signature`, `replay_material_sigs`, the `''`
sentinel for unreplayable FEN-start games) is duplicated from
`apps/desktop/src-tauri/src/db.rs` — keep them in sync.
