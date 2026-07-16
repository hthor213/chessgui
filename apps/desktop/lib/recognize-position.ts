"use client"

import { getProviders } from "@/lib/platform";
import { blobToBase64 } from "@/lib/platform/clipboard";
import { parseFen, makeFen } from "chessops/fen";
import { Chess } from "chessops";
import {
  parseReading,
  diffSquares,
  buildTiebreakPrompt,
  applyVerdicts,
  parseTurnVerdict,
  homeSquareCastling,
} from "@/lib/fen-consensus";

// Extracted to @chessgui/core (spec 220 step 5); re-exported so existing
// importers keep working.
import type { ClipboardImage } from "@chessgui/core/clipboard-types";
export type { ClipboardImage };

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
 * Read an image from the system clipboard, if there is one. The desktop
 * provider tries the native clipboard plugin first, then the browser
 * Clipboard API. Returns null when the clipboard holds no image — callers
 * fall back to text-paste behavior.
 */
export async function readClipboardImage(): Promise<ClipboardImage | null> {
  return getProviders().dialog.readClipboardImage();
}

/**
 * Read plain text from the system clipboard, if any (native plugin first on
 * desktop, browser Clipboard API otherwise). Returns null when no text is
 * available — callers fall back to an empty import dialog.
 */
export async function readClipboardText(): Promise<string | null> {
  return getProviders().dialog.readClipboardText();
}

async function recognizeOnce(image: ClipboardImage, prompt?: string): Promise<string> {
  try {
    return await getProviders().engine.recognizeFen(image.base64, image.mediaType, prompt);
  } catch (e) {
    throw new Error(typeof e === "string" ? e : "Position recognition failed");
  }
}

/**
 * Recognize a chess position from a pasted screenshot.
 *
 * Two independent transcriptions run in parallel; if they agree the reading
 * is accepted, otherwise a third call adjudicates exactly the disputed
 * squares (single reads occasionally flip visually confusable squares).
 * We trust the model for placement and side to move only — castling is
 * derived from home squares, en passant and counters are reset — then the
 * result is validated with chessops. Throws a user-facing message on failure.
 */
export async function imageToFen(image: ClipboardImage): Promise<string> {
  const [textA, textB] = await Promise.all([recognizeOnce(image), recognizeOnce(image)]);
  const a = parseReading(textA);
  const b = parseReading(textB);
  if (!a && !b) throw new Error("No chess position found in the pasted image");

  let placement: string;
  let side: "w" | "b";
  if (a && b && a.placement !== b.placement) {
    const disputes = diffSquares(a.placement, b.placement);
    if (disputes.length > 16) {
      throw new Error("Couldn't read the board reliably — try a clearer screenshot");
    }
    const askTurn = a.side !== b.side;
    const verdict = await recognizeOnce(image, buildTiebreakPrompt(disputes, askTurn));
    placement = applyVerdicts(a.placement, disputes, verdict);
    side = askTurn ? (parseTurnVerdict(verdict) ?? "w") : (a.side ?? "w");
  } else {
    const r = (a ?? b)!;
    placement = r.placement;
    side = r.side ?? b?.side ?? "w";
  }

  const fen = [placement, side, homeSquareCastling(placement), "-", "0", "1"].join(" ");
  const setup = parseFen(fen);
  if (setup.isErr) throw new Error(`Recognized position isn't a valid FEN (${placement})`);
  const pos = Chess.fromSetup(setup.unwrap());
  if (pos.isErr) throw new Error(`Recognized position isn't legal: ${pos.error.message} (${placement})`);
  return makeFen(pos.unwrap().toSetup());
}
