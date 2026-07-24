// Concept Lessons — OPTIONAL assist-graded free-text (specs/227, D6).
//
// A LATER-TIER, OPTIONAL feature layered on top of the D2/D3 self-graded
// free_text flow. It is OFF by default (a boolean in the settings store) and is
// NEVER on a required path: the module still completes identically via the
// self-grade control whether assist is on, off, or unavailable. All this module
// does is turn a student's prose + the study question's own model answer/rubric
// into a prompt, and turn the model's reply back into a {tier, feedback} pair.
//
// Fair-play boundary (spec 227 D5): PURE. String in / structured out. It reads
// ONLY the question's revealed modelAnswer + rubric and the user's typed prose —
// never a FEN, never live-game or engine state — so the lesson surface stays
// structurally decoupled from the live game. No network, no ambient state; the
// actual Anthropic call lives behind the platform seam (the existing AI plumbing
// reused, not reinvented).

import type { SelfGrade } from "./lesson-grade";

/** The assist grader's verdict tier. Deliberately the SAME union as the
 *  self-grade (`SelfGrade`) so a returned tier can PRE-SELECT the matching
 *  self-grade button — which remains the user-overridable source of truth. */
export type AssistTier = SelfGrade; // "got_it" | "partial" | "missed"

/** The structured result of grading one prose answer. `feedback` is always a
 *  non-empty human string (a fallback is substituted rather than throwing). */
export interface AssistGrade {
  tier: AssistTier;
  feedback: string;
}

const VALID_TIERS: readonly AssistTier[] = ["got_it", "partial", "missed"];

/**
 * Whether the "Assist grade" affordance should be offered at all. Pure gate so
 * the default-off guarantee is testable without a browser: the setting must be
 * explicitly ON *and* the shell must have the native AI host (the browser/web
 * shell has none, so it degrades to self-grade only). Anything falsy → false.
 */
export function shouldOfferAssist(
  settingEnabled: boolean | undefined | null,
  hasNativeEngine: boolean | undefined | null,
): boolean {
  return settingEnabled === true && hasNativeEngine === true;
}

/**
 * Build the grader prompt from the student's prose and the question's own
 * revealed evidence (model answer + rubric). No board state is referenced — the
 * grader compares prose against prose. The strict output contract (VERDICT: /
 * FEEDBACK:) is what `parseAssistResponse` reads back; the fallback there means
 * a model that ignores the format still degrades gracefully.
 */
export function buildAssistPrompt(
  userAnswer: string,
  modelAnswer: string,
  rubric: readonly string[],
): string {
  const written = (userAnswer ?? "").trim() || "(the student wrote nothing)";
  const model = (modelAnswer ?? "").trim() || "(no model answer provided)";
  const rubricBlock =
    rubric && rubric.length
      ? rubric.map((r, i) => `${i + 1}. ${String(r).trim()}`).join("\n")
      : "(no rubric provided)";

  return [
    "You are grading a chess student's written answer to a study question. You " +
      "are given a MODEL ANSWER and a RUBRIC of the points a full answer should " +
      "cover. Judge ONLY how well the student's prose matches the model answer " +
      "and rubric — do not bring in outside analysis, and never invent board " +
      "facts. Reward the ideas the student got right; name what they missed.",
    "MODEL ANSWER:\n" + model,
    "RUBRIC (the points a full answer should cover):\n" + rubricBlock,
    "THE STUDENT'S ANSWER:\n" + written,
    "Grade it against the rubric. Reply in EXACTLY this format and nothing else:\n" +
      "VERDICT: got_it | partial | missed\n" +
      "FEEDBACK: two or three sentences addressed to the student as \"you\", " +
      "naming which rubric points they covered and which they missed.\n\n" +
      "Use got_it when they hit the main rubric points, partial when they got " +
      "some, missed when they got few or none.",
  ].join("\n\n");
}

/** Normalize a raw verdict token to a tier, or null if unrecognized. */
function normalizeTier(token: string): AssistTier | null {
  const norm = token.toLowerCase().trim().replace(/[\s-]+/g, "_");
  if (norm.startsWith("got")) return "got_it";
  if (norm === "partial") return "partial";
  if (norm === "missed") return "missed";
  return (VALID_TIERS as readonly string[]).includes(norm)
    ? (norm as AssistTier)
    : null;
}

/**
 * Parse the model's reply into `{tier, feedback}`. ROBUST BY CONTRACT — it must
 * NEVER throw into the UI:
 *  - A well-formed "VERDICT: partial\nFEEDBACK: …" reply parses exactly.
 *  - A reply missing the verdict falls back to tier "partial" (the neutral,
 *    non-advancing self-grade — assist never silently marks a lesson passed).
 *  - A reply missing the FEEDBACK label uses the whole reply as feedback.
 *  - An empty / non-string reply yields a default feedback string.
 * The returned tier only PRE-SELECTS a self-grade the user can override.
 */
export function parseAssistResponse(raw: unknown): AssistGrade {
  const text = typeof raw === "string" ? raw : "";

  // Verdict: first "verdict … got_it|partial|missed" (tolerant of :/-/spaces).
  let tier: AssistTier = "partial";
  const vMatch = text.match(/verdict\s*[:\-]?\s*(got[\s_-]?it|partial|missed)/i);
  if (vMatch) {
    const t = normalizeTier(vMatch[1]);
    if (t) tier = t;
  }

  // Feedback: everything after a "FEEDBACK:" label; else the whole reply.
  let feedback = "";
  const fMatch = text.match(/feedback\s*[:\-]?\s*([\s\S]+)/i);
  if (fMatch) {
    feedback = fMatch[1].trim();
  } else {
    // No label — take the raw text but drop a leading VERDICT line if present,
    // so the tier token doesn't leak into the shown feedback.
    feedback = text.replace(/^\s*verdict\s*[:\-]?\s*\S+\s*/i, "").trim();
  }
  if (!feedback) feedback = "The assist grader returned no feedback.";

  return { tier, feedback };
}

/** Identity today (the tiers ARE the self-grade union), but named so the call
 *  site is explicit and stays correct if the two vocabularies ever diverge. */
export function assistTierToSelfGrade(tier: AssistTier): SelfGrade {
  return tier;
}
