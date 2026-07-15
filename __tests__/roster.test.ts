import { describe, it, expect } from "vitest";
import {
  buildRoster,
  initialsFor,
  MAIA_ROSTER_BANDS,
  PRIVATE_RIVAL_ID,
  PRIVATE_RIVAL_DISPLAY_NAME,
} from "@/lib/roster";
import type { RivalBook } from "@/lib/rival-book";
import { MAIA_MAX_NATIVE_BAND } from "@/lib/maia";

const SAMPLE_BOOK: RivalBook = {
  version: 1,
  max_ply: 8,
  rival: "dad",
  entries: [],
};

describe("buildRoster", () => {
  it("omits the private rival when the local book hasn't loaded (spec 214 hard rule)", () => {
    const roster = buildRoster(null);
    expect(roster.find((p) => p.id === PRIVATE_RIVAL_ID)).toBeUndefined();
  });

  it("includes the private rival, generically labeled, once the book exists", () => {
    const roster = buildRoster(SAMPLE_BOOK);
    const rival = roster.find((p) => p.id === PRIVATE_RIVAL_ID);
    expect(rival).toBeDefined();
    expect(rival!.displayName).toBe(PRIVATE_RIVAL_DISPLAY_NAME);
    // Generic — never the rival's real name (spec 214/218 hard rule).
    expect(rival!.displayName.toLowerCase()).not.toContain("dad");
    expect(rival!.actions).toEqual(["play", "improve"]);
    expect(rival!.personaConfig?.book).toBe("rival");
  });

  it("gives every non-rival entry Play only", () => {
    const roster = buildRoster(SAMPLE_BOOK);
    for (const p of roster) {
      if (p.id === PRIVATE_RIVAL_ID) continue;
      expect(p.actions).toEqual(["play"]);
    }
  });

  it("labels Fischer and Kasparov as honest approximations, not real strength", () => {
    const roster = buildRoster(null);
    const fischer = roster.find((p) => p.id === "fischer");
    const kasparov = roster.find((p) => p.id === "kasparov");
    expect(fischer).toBeDefined();
    expect(kasparov).toBeDefined();
    for (const p of [fischer!, kasparov!]) {
      expect(p.personaConfig?.approximate).toBe(true);
      expect(p.personaConfig?.level).toBe(MAIA_MAX_NATIVE_BAND);
      expect(p.strengthLabel).toMatch(/approximation/i);
      expect(p.strengthLabel).toMatch(/pending/i);
      // No move-by-move book extracted yet (spec 218 checklist item 2).
      expect(p.personaConfig?.book).toBeUndefined();
    }
  });

  it("surfaces every published Maia band as a generic bot", () => {
    const roster = buildRoster(null);
    for (const level of MAIA_ROSTER_BANDS) {
      const bot = roster.find((p) => p.id === `maia-${level}`);
      expect(bot).toBeDefined();
      expect(bot!.displayName).toBe(`Bot ${level}`);
      expect(bot!.personaConfig?.level).toBe(level);
      expect(bot!.personaConfig?.approximate).toBeUndefined();
      expect(bot!.actions).toEqual(["play"]);
    }
    expect(MAIA_ROSTER_BANDS.length).toBe(9);
  });

  it("ships zero avatar art in v1 — every entry falls back to initials", () => {
    const roster = buildRoster(SAMPLE_BOOK);
    for (const p of roster) expect(p.avatar).toBeUndefined();
  });
});

describe("initialsFor", () => {
  it("takes the first two letters of a single word", () => {
    expect(initialsFor("Fischer")).toBe("FI");
  });

  it("takes the first letter of the first two words", () => {
    expect(initialsFor("Private rival")).toBe("PR");
    expect(initialsFor("Bot 1500")).toBe("B1");
  });

  it("falls back to '?' for an empty name", () => {
    expect(initialsFor("   ")).toBe("?");
  });
});
