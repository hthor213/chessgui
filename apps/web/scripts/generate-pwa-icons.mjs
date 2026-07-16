// Generates the PWA icons into public/icons/ (spec 223) — a dark tile with
// a centered 4x4 checkerboard in the board-theme brown palette
// (board-theme.css imports chessground.brown.css; these are its two square
// colors). Deterministic output from zero dependencies (hand-rolled PNG
// encoder over node:zlib), same posture as prepare-engine.mjs: generated at
// build/dev time, gitignored, never vendored.
//
// Sizes: 192/512 (manifest "any"), 180 (apple-touch-icon — iOS ignores the
// manifest icons), and a 512 maskable variant with extra padding so the
// checkerboard survives the platform's circle/squircle crop (content must
// fit the central 80% "safe zone").

import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { deflateSync } from "node:zlib"

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "icons")

const BG = [0x0a, 0x0a, 0x0a] // app background (layout.tsx / manifest theme_color)
const LIGHT = [0xf0, 0xd9, 0xb5] // chessground.brown light square
const DARK = [0xb5, 0x88, 0x63] // chessground.brown dark square

// ---- Minimal PNG writer (8-bit RGB, filter 0) ----

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = -1
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, "ascii"), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/** Encode `size`x`size` pixels (fn(x, y) -> [r, g, b]) as a PNG buffer. */
function png(size, pixelAt) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type: truecolor RGB
  const raw = Buffer.alloc(size * (1 + size * 3))
  for (let y = 0; y < size; y++) {
    const row = y * (1 + size * 3)
    raw[row] = 0 // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b] = pixelAt(x, y)
      const i = row + 1 + x * 3
      raw[i] = r
      raw[i + 1] = g
      raw[i + 2] = b
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ])
}

// ---- The icon itself ----

/** `content` = fraction of the tile the checkerboard occupies (centered). */
function icon(size, content) {
  const board = Math.round(size * content)
  const off = Math.round((size - board) / 2)
  const cell = board / 4
  return png(size, (x, y) => {
    const bx = x - off
    const by = y - off
    if (bx < 0 || by < 0 || bx >= board || by >= board) return BG
    const parity = (Math.floor(bx / cell) + Math.floor(by / cell)) % 2
    return parity === 0 ? LIGHT : DARK
  })
}

mkdirSync(outDir, { recursive: true })
const files = [
  ["icon-192.png", icon(192, 0.62)],
  ["icon-512.png", icon(512, 0.62)],
  ["apple-touch-icon.png", icon(180, 0.62)],
  // Maskable: tighter content so the circle crop keeps the whole board.
  ["icon-maskable-512.png", icon(512, 0.5)],
]
for (const [name, buf] of files) writeFileSync(join(outDir, name), buf)
console.log(`pwa icons: wrote ${files.map(([n]) => n).join(", ")} to public/icons/`)
