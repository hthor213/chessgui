"use client"

import { invoke } from "@tauri-apps/api/core";
import { parseFen, makeFen } from "chessops/fen";
import { Chess } from "chessops";

/** Piece placement, optionally followed by turn/castling/ep/counters. */
const FEN_RE =
  /\b([rnbqkpRNBQKP1-8]{1,8}(?:\/[rnbqkpRNBQKP1-8]{1,8}){7})(?:\s+([wb])\s+([KQkqA-Ha-h]+|-)\s+([a-h][36]|-)(?:\s+(\d+)\s+(\d+))?)?/;

export interface ClipboardImage {
  base64: string;
  mediaType: string;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(",")[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/**
 * Extract an image from a native paste event (e.g. ⌘V inside a dialog).
 * Returns null when the pasted content has no image.
 */
export async function clipboardEventImage(
  e: { clipboardData: DataTransfer | null },
): Promise<ClipboardImage | null> {
  const items = e.clipboardData?.items;
  if (!items) return null;
  for (const item of Array.from(items)) {
    if (!item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (!file) continue;
    return { base64: await blobToBase64(file), mediaType: item.type };
  }
  return null;
}

/**
 * Read an image from the system clipboard, if there is one.
 * Tries the Tauri clipboard plugin first (native app), then the browser
 * Clipboard API (dev in a plain browser). Returns null when the clipboard
 * holds no image — callers fall back to text-paste behavior.
 */
export async function readClipboardImage(): Promise<ClipboardImage | null> {
  try {
    const { readImage } = await import("@tauri-apps/plugin-clipboard-manager");
    const img = await readImage();
    const { width, height } = await img.size();
    const rgba = new Uint8ClampedArray(await img.rgba());
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.putImageData(new ImageData(rgba, width, height), 0, 0);
      const dataUrl = canvas.toDataURL("image/png");
      return { base64: dataUrl.split(",")[1], mediaType: "image/png" };
    }
  } catch {
    // Not running in Tauri, or the clipboard holds no image — try the browser API.
  }

  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const type = item.types.find((t) => t.startsWith("image/"));
      if (!type) continue;
      const blob = await item.getType(type);
      return { base64: await blobToBase64(blob), mediaType: type };
    }
  } catch {
    // Clipboard API unavailable or permission denied.
  }
  return null;
}

/**
 * Recognize a chess position from a pasted screenshot.
 * The Rust side asks Claude for the FEN; here we extract, complete
 * (white to move by default — flip via the position editor if needed),
 * and validate it with chessops. Throws with a user-facing message on failure.
 */
export async function imageToFen(image: ClipboardImage): Promise<string> {
  let text: string;
  try {
    text = await invoke<string>("recognize_fen", {
      imageBase64: image.base64,
      mediaType: image.mediaType,
    });
  } catch (e) {
    throw new Error(typeof e === "string" ? e : "Position recognition failed");
  }

  const m = text.match(FEN_RE);
  if (!m) throw new Error("No chess position found in the pasted image");

  const fen = [m[1], m[2] ?? "w", m[3] ?? "-", m[4] ?? "-", m[5] ?? "0", m[6] ?? "1"].join(" ");
  const setup = parseFen(fen);
  if (setup.isErr) throw new Error("Recognized position isn't a valid FEN");
  const pos = Chess.fromSetup(setup.unwrap());
  if (pos.isErr) throw new Error("Recognized position isn't a legal chess position");
  return makeFen(pos.unwrap().toSetup());
}
