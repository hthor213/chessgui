# 222: PC Client (Windows & Linux)

**Status:** draft
**Depends on:** 220 (shared-core monorepo — this is `apps/desktop` compiled for two
more targets, NOT a new app), 011 (engine analysis + the engine file-picker), 216
(first-start auto-bench, Tier 2)
**Feeds:** 217 (dad's Windows PC as a calibrated play surface), 218 (roster play at
honest strength labels off-macOS)
**Sequencing:** third in the platform wave (220 → 221 → 222 → 223) — the web client
(spec:221) ships first; this follows it, before mobile (spec:223).

## Goal

Windows and Linux builds of the **same** Tauri desktop app that ships on macOS today.
Per the single-source-of-truth rule (spec:220): zero forked UI, zero copied board or
piece assets — the PC client is `apps/desktop` with a different compile target plus a
small per-OS platform-config layer (engine path defaults, bundle format). If a change
to a piece set or board color requires touching anything Windows- or Linux-specific,
this spec has failed.

Why now: spec:217 promised dad a native build on his own PC ("His own PC (future
native build)" — spec:217 Machine calibration section), and spec:216 Tier 2 requires
first-start auto-bench on any new install before strength labels are honest there.
The web arena (spec:221) covers play-vs-persona without this; what the PC client adds
is local engine analysis at full native speed and a machine profile for dad's
hardware.

## Decisions

### One app, per-OS config only

- Tauri 2 already targets Windows (MSVC) and Linux (webkit2gtk). The Rust backend
  (`src-tauri/`) is portable except for path assumptions.
- The one known macOS-ism in shared code: `lib/engine-settings.ts:24` hardcodes
  `DEFAULT_ENGINE_PATH = "/opt/homebrew/bin/stockfish"`. That constant moves to the
  desktop shell's per-platform config (spec:220 does the seam work; this spec supplies
  the Windows/Linux values). Default engine resolution order, all platforms:
  1. bundled sidecar engine (below), 2. user-set path (spec:011 file picker),
  3. PATH lookup (`stockfish` / `stockfish.exe`).

### Engine strategy: bundle Stockfish as a Tauri sidecar

- **Bundle, don't make dad hunt for a binary.** We are GPL-3.0 (Chessground forces
  it, see project CLAUDE.md), Stockfish is GPL-3.0 — redistributing official
  Stockfish binaries inside our bundle is license-clean as long as the app source
  stays available. No legal wall here, unlike the CBH/courses constraints
  (memory: ChessBase parity roadmap).
- Per-target sidecar binaries from the official Stockfish release page, sha256-pinned
  in the build config (same pattern as the lc0 net pinning in
  `server/arena/app/config.py` / `src-tauri/src/maia.rs` MANAGED_NETS):
  - Windows x64: `stockfish-windows-x86-64-avx2.exe`
  - Linux x64: `stockfish-ubuntu-x86-64-avx2`
  - macOS keeps its current homebrew-default behavior until spec:220 unifies it;
    then macOS bundles the sidecar too (one story on all three).
- **AVX2 is the default; the file picker is the escape hatch.** Pre-2013 CPUs
  without AVX2 crash the avx2 build on launch of the engine — we do NOT ship a
  fallback binary matrix. If the bundled engine fails its first `uci` handshake,
  surface a plain-language dialog pointing at the spec:011 engine file picker
  ("download the right Stockfish for your CPU, point me at it"). Dad's PC is recent
  enough; anyone else is a spec:011 power user by definition.
- Maia/lc0 personas (`src-tauri/src/maia.rs`) are **out of scope** for PC v1:
  persona play happens in the web arena (spec:221/217), which runs personas
  server-side. Local persona play on PC is a later tier, gated on an lc0 sidecar
  story per-OS.

### Build & distribution: GitHub Actions, unsigned

Simplest honest option, chosen over the alternatives:

- **GitHub Actions matrix** (`windows-latest`, `ubuntu-22.04`) using the official
  `tauri-apps/tauri-action`, triggered on tag push, artifacts attached to a GitHub
  release. This is the canonical Tauri story and the repo already lives on GitHub
  (`github.com/hthor213/chessgui`).
- Rejected: local cross-compilation from macOS to Windows (Tauri does not support
  it — MSVC toolchain + WebView2 required); a Windows VM on the laptop (works but
  is a manual snowflake; Actions gives repeatable builds for free).
- Note ubuntu-22.04 pins the webkit2gtk baseline — binaries run on 22.04+; that's
  the standard Tauri floor, accept it.
- **No code signing, deliberately.** Windows signing needs an OV/EV cert
  (~$200-400/yr) or Azure Trusted Signing; for a family-distribution app the honest
  answer is: unsigned, and the install doc includes the two SmartScreen clicks
  ("More info" → "Run anyway"). Dad's first install is assisted anyway (same rule
  as his first arena session, spec:217 Tier 0). Revisit only if distribution ever
  goes beyond family — same trigger as the ToU deferral in spec:217.
- Linux: `.deb` + AppImage from tauri-action defaults. No signing culture to
  satisfy; AppImage is the "just runs" path.
- Bundle identifier, icons, window config: already in `src-tauri/tauri.conf.json`,
  shared across targets.

### What spec:217 needs from this build

Dad's Windows PC is a play surface, and spec:217's calibration rule is one sentence:
any surface that fields a persona inherits spec:216's per-machine calibration before
it may claim a strength. Concretely:

- **First-start auto-bench** (spec:216 Tier 2): on first launch with a working
  engine, run `machine_profile` bench automatically (the command exists —
  `src-tauri/src/machine.rs`, `hooks/use-machine-profile.ts`), store the profile,
  display all strength labels as PRIOR until then. No new UI: the PRIOR/MEASURED
  flag plumbing shipped in spec:216 Tier 0/1.
- The measured laptop curve does NOT transfer (spec:216: profiles are per-machine
  by construction); dad's PC gets PRIOR labels + bench nps until/unless a ladder
  ever runs there. That's honest and sufficient.
- Auto-bench must be silent-cheap: Stockfish `bench` is seconds, run it behind a
  one-line toast, never a modal on first launch.

## Platform quirks ledger

- **Paths**: no `/opt/homebrew`; use Tauri's resource/sidecar resolution for the
  bundled engine and `app_data_dir` for `machine_profile.json` (already the storage
  mechanism, verify it resolves per-OS and not to a hardcoded macOS path).
- **Windows process spawn**: UCI child processes must set CREATE_NO_WINDOW or every
  engine start flashes a console window. Check `uci.rs` spawn flags.
- **Line endings**: UCI parsing must tolerate `\r\n` from Windows engine builds
  (trim, don't split on bare `\n` only) — audit `uci.rs` reader.
- **Linux**: webkit2gtk 4.1 dependency documented in the install notes; AppImage
  bundles it.
- **localStorage**: Tauri WebView storage works the same on all three; no change
  (spec:220 KVStore migration is orthogonal).

## Non-goals

- macOS packaging changes (current `scripts/install-app.sh` flow untouched).
- 32-bit, ARM-Linux, or Windows-on-ARM targets.
- Auto-update. Family-scale: "download the new release" is fine; Tauri updater is a
  later tier if release cadence ever hurts.
- Local persona/lc0 play on PC (see engine strategy above).
- App-store distribution of any kind.

## Done when

### Tier 0 — build & boot
- [x] Per-platform engine default replaces the `/opt/homebrew` constant (resolution
      order: sidecar → user path → PATH), behind the spec:220 config seam
      (code-verified 2026-07-15: `src-tauri/src/engine_path.rs` + unit tests;
      Rust-side constant removed from machine.rs; frontend seam in
      lib/platform/tauri.ts stays sync per spec 220)
- [ ] Stockfish sidecar binaries pinned (sha256) and bundled for windows-x64-avx2 +
      linux-x64-avx2; `tauri.conf.json` externalBin wiring
      (partial, code-verified 2026-07-15: `scripts/fetch-stockfish-sidecar.sh`
      carries the sha256 pins and `tauri.windows.conf.json` /
      `tauri.linux.conf.json` wire externalBin — but no Windows/Linux bundle has
      actually been built yet, so "bundled" is unverified)
- [x] AVX2-failure dialog → spec:011 engine file picker fallback path
      (code-verified 2026-07-15: implemented as a plain-language `startError`
      message in use-engine.ts pointing at Engine settings → Browse…, rendered
      next to the settings gear — inline message, not a modal dialog)
- [x] `uci.rs` audited for Windows spawn flags (no console flash) + `\r\n` tolerance
      (code-verified 2026-07-15: spawns routed through `engine_command()` which
      sets CREATE_NO_WINDOW on Windows; all reads trim, so `\r\n` is tolerated)
- [ ] GitHub Actions workflow: tag-triggered matrix build (windows-latest,
      ubuntu-22.04) via tauri-action, artifacts on a GitHub release
      (written 2026-07-15 as `.github/workflows/pc-build.yml` but NOT pushed:
      the hthor213 OAuth token lacks the `workflow` scope — run
      `gh auth refresh -s workflow` then commit/push the file)
- [ ] Linux artifact (.deb + AppImage) boots in a local VM: board renders, engine
      starts, analysis lines stream, game plays end to end
- [ ] Windows artifact (.msi/.exe) boots: same smoke script — **USER-BLOCKED: needs
      a real Windows machine (no Windows box in the shop; candidates: dad's PC with
      assistance, or a one-time VM)**

### Tier 1 — dad's PC (spec:217 handoff)
- [ ] First-start auto-bench wired: working engine detected → bench → profile
      stored → labels flip from "no profile" to PRIOR (spec:216 Tier 2)
- [x] Install doc: download link + the two SmartScreen clicks, in plain language
      (Icelandic optional), suitable for the assisted first install
      (code-verified 2026-07-15: `docs/pc-install.md` — release link, the two
      SmartScreen clicks named verbatim, AVX2 fallback in plain words;
      English only so far)
- [ ] Installed and smoke-tested on dad's actual PC; his `machine_profile.json`
      exists with real nps — **USER-BLOCKED: requires the user + dad session**
- [ ] Confirm arena web login (spec:221) also works from his PC's browser while
      we're there — one trip, both surfaces

### Tier 2 — later, only if pulled
- [ ] Tauri updater with signed update manifests
- [ ] lc0/Maia sidecar per-OS for local persona play
- [ ] Non-AVX2 fallback binary auto-selection
