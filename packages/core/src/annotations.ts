// NAG codes, comment-tag handling and [%eval] parsing — pure helpers shared by
// the move list, the annotation bar and the eval graph (spec 202).

import type { AssessmentOrigin, Likelihood, MoveSource, NodeEval } from "./game-tree";

/** NAG code → display glyph (PGN standard subset). */
export const NAG_GLYPHS: Record<number, string> = {
  1: "!",
  2: "?",
  3: "!!",
  4: "??",
  5: "!?",
  6: "?!",
  7: "□", // only move
  10: "=",
  13: "∞",
  14: "⩲",
  15: "⩱",
  16: "±",
  17: "∓",
  18: "+−",
  19: "−+",
};

/** Move-quality NAGs — mutually exclusive with each other. */
export const MOVE_NAGS = [1, 2, 3, 4, 5, 6] as const;

/** Positional-assessment NAGs — mutually exclusive with each other. */
export const POSITION_NAGS = [10, 13, 14, 15, 16, 17, 18, 19] as const;

/**
 * Toggle a NAG on a node's list. Setting a NAG removes any other NAG from the
 * same group (a move is either "!" or "?!", never both); setting one the node
 * already has clears it.
 */
export function toggleNag(nags: number[], nag: number): number[] {
  if (nags.includes(nag)) return nags.filter((n) => n !== nag);
  const group = (MOVE_NAGS as readonly number[]).includes(nag)
    ? (MOVE_NAGS as readonly number[])
    : (POSITION_NAGS as readonly number[]).includes(nag)
      ? (POSITION_NAGS as readonly number[])
      : null;
  const kept = group ? nags.filter((n) => !group.includes(n)) : [...nags];
  return [...kept, nag].sort((a, b) => a - b);
}

/** Glyph string for a node's NAG list, move-quality glyphs first. */
export function nagsToGlyphs(nags: number[]): string {
  const order = (n: number) => ((MOVE_NAGS as readonly number[]).includes(n) ? 0 : 1);
  return [...nags]
    .sort((a, b) => order(a) - order(b) || a - b)
    .map((n) => NAG_GLYPHS[n] ?? `$${n}`)
    .join("");
}

/** Keyboard buffer ("!", "?!", …) → NAG code, or null if not a move NAG. */
export function glyphToNag(glyph: string): number | null {
  const entry = (Object.entries(NAG_GLYPHS) as [string, string][]).find(
    ([code, g]) => g === glyph && (MOVE_NAGS as readonly number[]).includes(Number(code)),
  );
  return entry ? Number(entry[0]) : null;
}

const TAG_RE = /\[%[a-zA-Z]+[^\]]*\]/g;

/**
 * Split a PGN comment into human text and embedded [%…] command tags
 * ([%eval], [%clk], [%cal], [%csl]). The comment editor shows and edits only
 * the text; tags are preserved verbatim and re-joined on save.
 */
export function splitComment(comment: string): { text: string; tags: string[] } {
  const tags = comment.match(TAG_RE) ?? [];
  const text = comment.replace(TAG_RE, "").replace(/\s{2,}/g, " ").trim();
  return { text, tags };
}

/** Recombine edited text with the tags preserved by splitComment. */
export function joinComment(text: string, tags: string[]): string {
  return [text.trim(), ...tags].filter(Boolean).join(" ");
}

// ---- notebook tags (spec 226) -------------------------------------------
//
// Three comment tags on the [%clk]/[%eval] convention, so the notebook needs
// no schema change and rides PGN anywhere: [%lik n] for opponent-reply
// likelihood, [%prov origin,unixseconds] for the provenance of an assessment,
// and [%src db] for a move that came out of a position-indexed corpus rather
// than the player's own head. chessops leaves unknown [%…] tags verbatim in
// the comment text, and TAG_RE above already hides them from the annotation
// editor.
//
// [%src] rides along for the same reason [%prov] does: an export/import round
// trip that forgot it would quietly turn book chess back into "my candidates"
// and inflate the coverage the blind-spot record depends on (spec 226 C).

const LIK_RE = /\[%lik\s+([123])\s*\]/;
const PROV_RE = /\[%prov\s+(human-live|human)(?:\s*,\s*(\d+))?\s*\]/;
const SRC_RE = /\[%src\s+(db|live)\s*\]/;

/** The two directions of the `[%src]` tag. "db" is a move the app served out
 *  of a position-indexed corpus; "live" is one the chess.com sync appended
 *  because it was played. Neither is one of the user's own candidates. */
const SRC_TAGS: Record<MoveSource, string> = { database: "db", played: "live" };
const SRC_VALUES: Record<string, MoveSource> = { db: "database", live: "played" };

export interface NotebookTags {
  lik?: Likelihood;
  assessedBy?: AssessmentOrigin;
  assessedAt?: number;
  src?: MoveSource;
  /** The comment with every notebook tag removed and whitespace collapsed. */
  rest: string;
}

/** Lift [%lik] / [%prov] / [%src] out of a comment string into typed fields. */
export function parseNotebookTags(comment: string): NotebookTags {
  const out: NotebookTags = { rest: "" };
  const lik = comment.match(LIK_RE);
  if (lik) out.lik = Number(lik[1]) as Likelihood;
  const prov = comment.match(PROV_RE);
  if (prov) {
    out.assessedBy = prov[1] as AssessmentOrigin;
    if (prov[2]) out.assessedAt = Number(prov[2]);
  }
  const src = comment.match(SRC_RE);
  if (src) out.src = SRC_VALUES[src[1]];
  out.rest = comment
    .replace(LIK_RE, "")
    .replace(PROV_RE, "")
    .replace(SRC_RE, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return out;
}

/**
 * Emit the notebook tags for a node, in a fixed order so export is
 * byte-stable across import→export→import.
 */
export function makeNotebookTags(node: {
  lik?: Likelihood;
  assessedBy?: AssessmentOrigin;
  assessedAt?: number;
  src?: MoveSource;
}): string {
  const parts: string[] = [];
  if (node.lik !== undefined) parts.push(`[%lik ${node.lik}]`);
  if (node.assessedBy !== undefined) {
    const at = node.assessedAt !== undefined ? `,${node.assessedAt}` : "";
    parts.push(`[%prov ${node.assessedBy}${at}]`);
  }
  if (node.src !== undefined) parts.push(`[%src ${SRC_TAGS[node.src]}]`);
  return parts.join(" ");
}

/**
 * Does this PGN carry notebook content (spec 226 J)?
 *
 * The archive is supposed to hold the game EXACTLY AS PLAYED — byte-comparable
 * with the copy the opponent has — so a `[%lik]`, `[%prov]` or `[%src]` tag in
 * text on its way to the spec 200 database means someone re-serialized the
 * user's working tree instead of archiving the PGN chess.com served. The
 * archive path (apps/desktop/lib/active-games.ts) refuses on this rather than
 * stripping: a contaminated archive is worse than a failed one, and stripping
 * would hide the bug that produced it.
 *
 * Deliberately limited to the three notebook tags. Position NAGs are NOT
 * checked — the same symbols arrive legitimately in an annotated PGN someone
 * downloaded, and refusing those would reject honest games. These three tags
 * are ours alone and can only come from our own serializer.
 */
const NOTEBOOK_TAG_RE = /\[%(?:lik|prov|src)\b/;

export function containsNotebookTags(pgn: string): boolean {
  return NOTEBOOK_TAG_RE.test(pgn);
}

/**
 * The movetext alone: header pairs and comments removed.
 *
 * Both have to go before anything is looked for, because both legitimately
 * carry the characters that mean something in the movetext — `[Event "Match
 * (2)"]` has a bracket and a paren, and a comment can say anything at all.
 */
function movetextOnly(pgn: string): string {
  return pgn
    .replace(/^\s*\[[^\]]*\]\s*$/gm, "") // tag pairs
    .replace(/\{[^}]*\}/g, "") // brace comments (where [%clk] lives)
    .replace(/;[^\n]*/g, ""); // rest-of-line comments
}

/**
 * Why this PGN may not be archived as the game as played, or null if it may
 * (spec 226 J).
 *
 * `containsNotebookTags` is the general helper and stays deliberately narrow —
 * position NAGs arrive legitimately in an annotated game somebody downloaded,
 * so a shared helper cannot refuse them. The ARCHIVE entry point is a
 * different question: what goes in there is supposed to be the text chess.com
 * served for one daily game, which has no variations and no NAGs at all. So it
 * gets the strict check, and the two extra classes it adds are exactly the
 * ones `treeToPgn` emits without a single `[%lik]` in sight:
 *
 *  - a RAV — the user's whole analysis tree, which is the bulk of the
 *    contamination and carries no notebook tag of its own;
 *  - a NAG — including the assessments the spec 202 annotation bar writes
 *    directly, which never get a `[%prov]` stamp and would otherwise sail
 *    through the tag check.
 *
 * Refuses rather than strips, same reasoning as the tag check: a silently
 * laundered archive is worse than a failed one, and stripping would hide the
 * bug that produced it. The way forward for a user who hits this is to paste
 * the game as played — which is the only thing that belongs here anyway.
 */
export function archivePgnImpurity(pgn: string): string | null {
  if (containsNotebookTags(pgn)) return "notebook tags ([%lik]/[%prov]/[%src])";
  const moves = movetextOnly(pgn);
  if (moves.includes("(")) return "analysis variations";
  if (/\$\d/.test(moves)) return "annotation NAGs";
  return null;
}

/**
 * Parse a [%eval …] tag out of a comment: "0.25" (pawns, white-perspective)
 * or "#-3" / "#5" (mate in N). Depth is unknown from PGN, recorded as 0 so a
 * live engine eval always outranks it.
 */
export function parseEvalTag(comment: string): NodeEval | null {
  // The optional ",<depth>" suffix is chess.com's form ("[%eval 0.15,18]");
  // accept it (ignoring the depth) alongside Lichess's plain "[%eval 0.15]".
  const m = comment.match(/\[%eval\s+(#?-?\d+(?:\.\d+)?)(?:,\d+)?\s*\]/);
  if (!m) return null;
  const raw = m[1];
  if (raw.startsWith("#")) {
    const mate = parseInt(raw.slice(1), 10);
    return Number.isFinite(mate) ? { mate, depth: 0 } : null;
  }
  const pawns = parseFloat(raw);
  return Number.isFinite(pawns) ? { cp: Math.round(pawns * 100), depth: 0 } : null;
}

/** Effective eval for a node: the stored engine eval, else its [%eval] tag. */
export function nodeEval(node: { eval?: NodeEval; comment: string }): NodeEval | null {
  return node.eval ?? parseEvalTag(node.comment);
}

/**
 * Lichess-style sigmoid squashing: centipawns → [-1, 1] with most resolution
 * near equality. Mate collapses to the full extent of the winning side.
 */
export function evalToUnit(ev: NodeEval): number {
  if (ev.mate !== undefined) return ev.mate > 0 ? 1 : -1;
  return 2 / (1 + Math.exp(-0.004 * (ev.cp ?? 0))) - 1;
}

/** Short human label: "+0.4", "-1.3", "#5", "#-3". */
export function formatEval(ev: NodeEval): string {
  if (ev.mate !== undefined) return `#${ev.mate}`;
  const pawns = (ev.cp ?? 0) / 100;
  return `${pawns >= 0 ? "+" : ""}${pawns.toFixed(1)}`;
}

/** Move-quality tiers from the eval swing (spec 202 blunder detection). */
export type MoveJudgment = "inaccuracy" | "mistake" | "blunder";

// Evals clamp here before comparing, with mate at the full cap: trading mate
// in 2 for mate in 8 is no drop at all, while throwing a mate away is a
// maximal one, and swings between already-decisive evals don't re-register.
const JUDGMENT_CAP_CP = 1000;

// Exported because the spec 226 H diagnosis grades the same kind of miss and
// must use the SAME cap: two modules with two caps would disagree about how
// bad a thrown mate was, and the diagnosis is supposed to agree with the ?!/?/??
// the move list already shows.
export function judgmentCp(ev: NodeEval): number {
  if (ev.mate !== undefined) return ev.mate > 0 ? JUDGMENT_CAP_CP : -JUDGMENT_CAP_CP;
  return Math.max(-JUDGMENT_CAP_CP, Math.min(JUDGMENT_CAP_CP, ev.cp ?? 0));
}

/**
 * Classify a move by how far the mover's eval dropped (spec 202 thresholds):
 * inaccuracy 0.5–1.0 pawns, mistake 1.0–3.0, blunder >3.0 (the shared 1.0
 * boundary counts as the worse tier). `before` is the position the move was
 * played from, `after` the resulting position, both white-perspective;
 * `moverIsWhite` orients the drop.
 */
export function judgeMove(
  before: NodeEval,
  after: NodeEval,
  moverIsWhite: boolean,
): MoveJudgment | null {
  const swing = judgmentCp(after) - judgmentCp(before);
  const drop = moverIsWhite ? -swing : swing;
  if (drop > 300) return "blunder";
  if (drop >= 100) return "mistake";
  if (drop >= 50) return "inaccuracy";
  return null;
}

/** Judgment tier → PGN move-quality NAG (?! / ? / ??), spec 202/212. */
export const JUDGMENT_NAGS: Record<MoveJudgment, number> = {
  inaccuracy: 6,
  mistake: 2,
  blunder: 4,
};

/**
 * Merge an engine judgment into a node's NAG list: replaces any existing
 * move-quality NAG (a move has exactly one) and keeps positional NAGs
 * untouched. Pure — returns a new sorted array.
 */
export function withJudgmentNag(nags: number[], judgment: MoveJudgment): number[] {
  const kept = nags.filter((n) => !(MOVE_NAGS as readonly number[]).includes(n));
  return [...kept, JUDGMENT_NAGS[judgment]].sort((a, b) => a - b);
}

// The move-quality NAGs the analysis pass assigns (inaccuracy ?!, mistake ?,
// blunder ??) — the marks that make a move a "key move" for review navigation
// and the key-move annotation gate (spec 202).
const JUDGMENT_NAG_SET: ReadonlySet<number> = new Set(Object.values(JUDGMENT_NAGS));

/** True when a node carries an engine judgment NAG (?!/?/??). */
export function hasJudgmentNag(nags: number[]): boolean {
  return nags.some((n) => JUDGMENT_NAG_SET.has(n));
}

/**
 * Index of the next node AFTER `fromIndex` in `nodes` that carries an engine
 * judgment NAG, or -1 when none remain. `nodes` is the mainline (root at [0]);
 * used by the "Next key move" navigation button (spec 202).
 */
export function nextKeyMoveIndex(nodes: { nags: number[] }[], fromIndex: number): number {
  for (let i = Math.max(-1, fromIndex) + 1; i < nodes.length; i++) {
    if (hasJudgmentNag(nodes[i].nags)) return i;
  }
  return -1;
}
