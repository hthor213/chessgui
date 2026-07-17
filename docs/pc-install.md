# Installing ChessGUI on a Windows or Linux PC

Íslensk útgáfa: [pc-install.is.md](pc-install.is.md)

Plain-language install notes for the PC builds (spec 222). These builds are
**unsigned** — that is a deliberate choice for a family-scale app, and it
means Windows will warn you once during install. That warning is expected
and safe to click through; the steps below show exactly where.

## Windows

1. **Download** the installer from the newest release at
   <https://github.com/hthor213/chessgui/releases> — pick the file ending in
   `.msi` (or the `-setup.exe` if you prefer).
2. **Run it.** Windows SmartScreen will show a blue box that says
   *"Windows protected your PC"*. This appears because the app is not
   code-signed, not because anything is wrong.
3. Click **"More info"** (small link in the text).
4. Click **"Run anyway"**.
5. Follow the installer. That's it — ChessGUI appears in the Start menu.

The chess engine (Stockfish) is included inside the app; there is nothing
else to download. (A short automatic speed test of your computer on first
launch is planned but not built yet — until it lands, the app's strength
labels are estimates rather than measured for this machine.)

### If the engine won't start

On PCs older than roughly 2013 the included engine may refuse to run (the
CPU lacks an instruction set called AVX2). The app will tell you in plain
words if that happens. The fix: download a Stockfish build matching your
CPU from <https://stockfishchess.org/download/> (pick a non-AVX2 variant,
e.g. "x86-64-sse41-popcnt"), then in ChessGUI open **Engine settings (gear
icon) → Browse…** and select the downloaded `stockfish.exe`.

## Linux

Requires Ubuntu 22.04+ or an equally recent distribution (webkit2gtk 4.1).

- **AppImage** (simplest, runs anywhere):

  ```bash
  chmod +x ChessGUI_*.AppImage
  ./ChessGUI_*.AppImage
  ```

- **Debian/Ubuntu package**:

  ```bash
  sudo apt install ./ChessGUI_*.deb
  ```

The bundled engine works the same as on Windows, and the same non-AVX2
escape hatch applies (Engine settings → Browse…).
