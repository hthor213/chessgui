// Manual regression test for screenshot→FEN recognition (live Anthropic API, ~15-25¢ per run).
//
// Run from the repo root:
//   pnpm dlx esbuild lib/fen-consensus.ts --bundle --format=esm --outfile=/tmp/fen-consensus.mjs
//   node scripts/test-recognition-consensus.mjs
//
// Exercises the same consensus algorithm as lib/recognize-position.ts:
// two parallel transcriptions; on disagreement a third call adjudicates
// the disputed squares. PROMPT must stay in sync with src-tauri/src/vision.rs.
import { readFileSync } from "node:fs";
import {
  parseReading, diffSquares, buildTiebreakPrompt, applyVerdicts, parseTurnVerdict,
} from "/tmp/fen-consensus.mjs";

const key = (() => {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY.trim();
  const env = readFileSync(`${process.env.HOME}/Documents/GitHub/ai-dev-framework/.env`, "utf8");
  return env.split("\n").find((l) => l.startsWith("ANTHROPIC_API_KEY=")).split("=")[1].trim();
})();

// Keep in sync with src-tauri/src/vision.rs PROMPT
const PROMPT = `This image is a screenshot of a chess position on a 2D board. Transcribe it exactly.
Important: do NOT assume a standard starting arrangement — the position may be mid-game or Chess960, with pieces on unusual squares. Read each square individually.
Step 1 — ranks: work rank by rank from rank 8 down to rank 1, using the board coordinates if visible (otherwise assume white plays up the board). For each rank, list files a through h — empty, or the exact piece and color you SEE on that square.
Step 2 — cross-check: now read the board again column by column (file a from rank 8 down to rank 1, then file b, and so on). Where the column reading disagrees with your rank reading, look at that square again carefully and correct it.
Step 3 — turn: if a last move is highlighted, use it to decide whose turn it is; otherwise assume white to move.
Finish your reply with a single last line in exactly this form:
FEN: <piece placement> <w or b> - - 0 1`;

async function callModel(imageB64, prompt) {
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-opus-4-8",
      max_tokens: 8000,
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: imageB64 } },
        { type: "text", text: prompt },
      ]}],
    }),
  });
  const v = await resp.json();
  if (!resp.ok) throw new Error(JSON.stringify(v.error));
  return v.content.find((b) => b.type === "text").text;
}

async function consensus(imagePath) {
  const img = readFileSync(imagePath).toString("base64");
  const [tA, tB] = await Promise.all([callModel(img, PROMPT), callModel(img, PROMPT)]);
  const a = parseReading(tA), b = parseReading(tB);
  if (a.placement === b.placement) {
    console.log("  readings agreed");
    return { placement: a.placement, side: a.side ?? b.side ?? "w" };
  }
  const disputes = diffSquares(a.placement, b.placement);
  console.log("  disputed squares:", disputes.map((x) => x.square).join(", "));
  const askTurn = a.side !== b.side;
  const verdict = await callModel(img, buildTiebreakPrompt(disputes, askTurn));
  return {
    placement: applyVerdicts(a.placement, disputes, verdict),
    side: askTurn ? (parseTurnVerdict(verdict) ?? "w") : (a.side ?? "w"),
  };
}

// Chess960 game after 1.Nf3 (user-reported bug: standard-setup hallucination)
const CASES = [
  ["scripts/fixtures/chess960-nf3-screenshot.png",
   "rqkrbnnb/pp1ppp1p/6p1/2p5/2PP4/5N2/PP2PPPP/RQKRBN1B", "b"],
];
for (const [img, expected, expSide] of CASES) {
  console.log(img + ":");
  const res = await consensus(img);
  const ok = res.placement === expected;
  console.log("  placement", ok ? "MATCH" : `MISMATCH got=${res.placement}`);
  console.log("  side:", res.side, "(expected", expSide + ")");
  if (!ok) process.exit(1);
}
console.log("CONSENSUS TESTS PASSED");
