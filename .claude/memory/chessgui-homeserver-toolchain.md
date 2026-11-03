---
name: chessgui-homeserver-toolchain
description: "What the homeserver can now build/run for chessgui — rust toolchain, tauri system libs, BT3 net, seat-portable persona tuner"
metadata: 
  node_type: memory
  type: project
  originSessionId: 970ee041-5a3f-4770-96c0-a2fe9a8590a2
  modified: 2026-08-25T02:24:37.718Z
---

Since 2026-08-25 the homeserver can build and test the chessgui Rust backend
and run the spec-214 persona tuner (previously Mac-only):

- rustup installed user-locally (`~/.cargo`, stable); `source ~/.cargo/env`
  before cargo. Tauri's Linux system deps (libgtk-3-dev,
  libwebkit2gtk-4.1-dev, librsvg2-dev) installed via apt. `cargo test` in
  `apps/desktop/src-tauri` needs `PERSONA_STOCKFISH_PATH=~/bin/stockfish`
  and a stockfish copy in the gitignored `src-tauri/binaries/`; one
  pre-existing failure (`puzzles.rs` hardcodes /opt/homebrew/bin/stockfish)
  is normal on this box.
- Persona tuner (`scripts/persona/tune_persona.py`) runs here with
  `CHESSGUI_NET_SCRATCH=$HOME/chess CHESSGUI_LC0=$HOME/bin/lc0
  CHESSGUI_STOCKFISH=$HOME/bin/stockfish`. BT3 strong net staged
  sha-verified at `~/chess/strongnet/`; Maia nets 1400–1900 at
  `~/chess/maia/` (1100–1300 absent). The private rival ("dad") canNOT be
  tuned here — his gitignored data/rivals dossier exists only on the Mac
  seat.
- `./deploy.sh` (repo root) deploys web+arena from the `~/code/chessgui`
  checkout's main via `git pull --ff-only` — work must be merged to main
  before deploy picks it up. The web image build is gated by
  `check-no-tauri` and a root `.dockerignore` allowlist; new build-time
  data assets must be re-added there explicitly.
