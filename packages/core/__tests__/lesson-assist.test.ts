// Concept Lessons — OPTIONAL assist-graded free-text (specs/227, D6).
//
// The assist grader is PURE: build a prompt, parse a reply, gate the affordance.
// These tests cover it WITHOUT any network — the exact discipline coach.rs uses
// for its build/parse split. The gating tests prove the feature is off by
// default and that scoreModule / lesson completion never depend on it.

import { describe, it, expect } from "vitest";
import {
  buildAssistPrompt,
  parseAssistResponse,
  shouldOfferAssist,
  assistTierToSelfGrade,
} from "../src/lesson-assist";
import { scoreModule } from "../src/lesson-grade";
import { loadCourse, type Module } from "../src/lessons";

describe("buildAssistPrompt — prose in, prompt out (no network)", () => {
  it("includes the model answer, every rubric point, and the user's prose", () => {
    const prompt = buildAssistPrompt(
      "White should play on the kingside with f4-f5.",
      "Black is better; the plan is the minority attack b5-b4.",
      ["Identify the closed centre", "Name the correct wing", "Cite the pawn break"],
    );
    // User prose present.
    expect(prompt).toContain("White should play on the kingside with f4-f5.");
    // Model answer present.
    expect(prompt).toContain("Black is better; the plan is the minority attack b5-b4.");
    // Every rubric point present.
    expect(prompt).toContain("Identify the closed centre");
    expect(prompt).toContain("Name the correct wing");
    expect(prompt).toContain("Cite the pawn break");
    // The strict output contract the parser relies on is instructed.
    expect(prompt).toContain("VERDICT:");
    expect(prompt).toContain("FEEDBACK:");
  });

  it("renders sane placeholders when the student wrote nothing / no rubric", () => {
    const prompt = buildAssistPrompt("   ", "The model answer.", []);
    expect(prompt).toContain("(the student wrote nothing)");
    expect(prompt).toContain("(no rubric provided)");
    expect(prompt).toContain("The model answer.");
  });
});

describe("parseAssistResponse — well-formed and malformed both handled (never throws)", () => {
  it("parses a well-formed VERDICT/FEEDBACK reply", () => {
    const g = parseAssistResponse(
      "VERDICT: partial\nFEEDBACK: You spotted the closed centre but named the wrong wing.",
    );
    expect(g.tier).toBe("partial");
    expect(g.feedback).toBe("You spotted the closed centre but named the wrong wing.");
    // The verdict token must not leak into the shown feedback.
    expect(g.feedback).not.toMatch(/verdict/i);
  });

  it("normalizes verdict spelling variants (got it / GOT_IT / hyphens)", () => {
    expect(parseAssistResponse("VERDICT: got it\nFEEDBACK: Nice.").tier).toBe("got_it");
    expect(parseAssistResponse("verdict - GOT-IT\nfeedback: ok").tier).toBe("got_it");
    expect(parseAssistResponse("Verdict: Missed\nFeedback: no").tier).toBe("missed");
  });

  it("falls back to tier 'partial' when no verdict is present (malformed)", () => {
    const g = parseAssistResponse("I think you did reasonably well here, honestly.");
    expect(g.tier).toBe("partial");
    // The whole reply becomes the feedback rather than being dropped.
    expect(g.feedback).toBe("I think you did reasonably well here, honestly.");
  });

  it("uses the whole reply as feedback when the FEEDBACK label is absent", () => {
    const g = parseAssistResponse("VERDICT: missed\nYou missed the minority attack entirely.");
    expect(g.tier).toBe("missed");
    expect(g.feedback).toBe("You missed the minority attack entirely.");
    expect(g.feedback).not.toMatch(/verdict/i);
  });

  it("never throws and yields a default feedback on empty / non-string input", () => {
    for (const bad of ["", "   ", null, undefined, 42, {}]) {
      const g = parseAssistResponse(bad as unknown);
      expect(g.tier).toBe("partial");
      expect(typeof g.feedback).toBe("string");
      expect(g.feedback.length).toBeGreaterThan(0);
    }
  });

  it("assistTierToSelfGrade maps a tier to the matching self-grade", () => {
    expect(assistTierToSelfGrade("got_it")).toBe("got_it");
    expect(assistTierToSelfGrade("partial")).toBe("partial");
    expect(assistTierToSelfGrade("missed")).toBe("missed");
  });
});

describe("gating — assist is OFF by default and never a required path", () => {
  it("shouldOfferAssist requires BOTH the setting ON and a native AI host", () => {
    // Default-off: with the setting false, assist is never offered — regardless
    // of the shell. This is the load-bearing default.
    expect(shouldOfferAssist(false, true)).toBe(false);
    expect(shouldOfferAssist(false, false)).toBe(false);
    // Web/no-native shell: even with the setting on, no host → no assist.
    expect(shouldOfferAssist(true, false)).toBe(false);
    // Only both true offers it.
    expect(shouldOfferAssist(true, true)).toBe(true);
    // Undefined/null (unread setting, missing flag) → off.
    expect(shouldOfferAssist(undefined, undefined)).toBe(false);
    expect(shouldOfferAssist(null, null)).toBe(false);
  });

  it("scoreModule / completion do NOT depend on assist grading", () => {
    // A module whose only question is free_text: it self-grades and completes
    // with no assist involved. The assist grader has no scoreModule parameter —
    // it CANNOT change the tally. Prove the score is identical whether the
    // self-grade came from a human tap or an assist pre-select.
    const module: Module = loadCourse({
      id: "c",
      title: "C",
      blurb: "b",
      level: "intermediate",
      modules: [
        {
          id: "m",
          title: "M",
          principle: { markdown: "p", remember: "r" },
          illustrations: [
            {
              title: "L",
              source: "src",
              pgn: "1. d4 d5 *",
              orientation: "white",
              focus: [],
            },
          ],
          questions: [
            {
              kind: "free_text",
              prompt: "What is the plan?",
              modelAnswer: "Minority attack.",
              rubric: ["name the break"],
            },
          ],
        },
      ],
    }).modules[0];

    // free_text is excluded from the auto tally regardless of self-grade source.
    const viaHuman = scoreModule(module, [{ kind: "free_text", selfGrade: "got_it" }]);
    const viaAssist = scoreModule(module, [{ kind: "free_text", selfGrade: "partial" }]);
    expect(viaHuman.total).toBe(0);
    expect(viaHuman.score).toBe(0);
    expect(viaAssist.total).toBe(0);
    expect(viaAssist.score).toBe(0);
    // The per-question outcome is present but never counts toward score.
    expect(viaHuman.outcomes[0].countsTowardScore).toBe(false);
    expect(viaAssist.outcomes[0].countsTowardScore).toBe(false);
  });
});
