import { describe, it, expect } from "vitest";
import {
  buildRoster,
  gatePersonaLevel,
  initialsFor,
  GM_PERSONA_CONFIGS,
  MAIA_ROSTER_BANDS,
  PRIVATE_RIVAL_ID,
  PRIVATE_RIVAL_DISPLAY_NAME,
  resolveParticipantBook,
  type LocalRivalPersona,
  type PersonaConfigFile,
} from "@/lib/roster";
import type { RivalBook } from "@/lib/rival-book";
import { MAIA_MAX_NATIVE_BAND } from "@/lib/maia";

const SAMPLE_BOOK: RivalBook = {
  version: 1,
  max_ply: 8,
  rival: "dad",
  entries: [],
};

/** A private-rival config file the way scripts/persona writes them —
 *  runnable in engine v1 (plain Maia band backend). */
function rivalConfig(overrides: Partial<PersonaConfigFile> = {}): PersonaConfigFile {
  return {
    slug: "testrival",
    display_name: "Neighbor",
    kind: "private-rival",
    runnable_in_engine_v1: true,
    backend: { kind: "maia", level: 1300 },
    sampling: { level: 1300, temperature: 0.5, alpha: 1.0, lambda: 0.75 },
    ...overrides,
  };
}

const LOCAL_RIVAL: LocalRivalPersona = {
  config: rivalConfig(),
  book: { version: 1, max_ply: 8, rival: "testrival", entries: [] },
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
    const roster = buildRoster(SAMPLE_BOOK, [LOCAL_RIVAL]);
    for (const p of roster) {
      if (p.id === PRIVATE_RIVAL_ID) continue;
      expect(p.actions).toEqual(["play"]);
    }
  });

  it("surfaces all 12 committed GM personas, config-driven, with their real books", () => {
    expect(GM_PERSONA_CONFIGS.length).toBe(12);
    const roster = buildRoster(null);
    for (const cfg of GM_PERSONA_CONFIGS) {
      const p = roster.find((x) => x.id === cfg.slug);
      expect(p, cfg.slug).toBeDefined();
      expect(p!.displayName).toBe(cfg.display_name);
      // Real opening book — legitimately the player's own recorded moves.
      expect(p!.personaConfig?.book).toBe("persona");
      expect(p!.personaConfig?.bookSlug).toBe(cfg.slug);
    }
    // Gudmundur-peak ships as one of the 12 (peak-era slice).
    expect(roster.find((x) => x.id === "sigurjonsson-peak")).toBeDefined();
  });

  it("HONESTY GATE: BT3-backed GM personas are approximations at the top Maia band, never full strength", () => {
    const roster = buildRoster(null);
    for (const cfg of GM_PERSONA_CONFIGS) {
      // Every committed GM config is BT3-backed and not runnable in v1.
      expect(cfg.runnable_in_engine_v1).toBe(false);
      const p = roster.find((x) => x.id === cfg.slug)!;
      expect(p.personaConfig?.approximate).toBe(true);
      expect(p.personaConfig?.level).toBe(MAIA_MAX_NATIVE_BAND);
      expect(p.strengthLabel).toMatch(/his openings/i);
      expect(p.strengthLabel).toMatch(/approximation/i);
      expect(p.strengthLabel).toMatch(/Tournament/);
      // No wire field smuggles a strong-net backend into persona_move.
      expect("weights" in (p.personaConfig ?? {})).toBe(false);
    }
  });

  it("HONESTY GATE: no roster entry ever exceeds the top native Maia band", () => {
    const roster = buildRoster(SAMPLE_BOOK, [LOCAL_RIVAL]);
    for (const p of roster) {
      if (!p.personaConfig) continue;
      expect(p.personaConfig.level, p.id).toBeLessThanOrEqual(MAIA_MAX_NATIVE_BAND);
    }
  });

  it("includes local private rivals from their configs, at their own band, honestly unmeasured", () => {
    const roster = buildRoster(null, [LOCAL_RIVAL]);
    const p = roster.find((x) => x.id === "rival-testrival");
    expect(p).toBeDefined();
    // Display name comes from the LOCAL config file, never committed code.
    expect(p!.displayName).toBe("Neighbor");
    expect(p!.personaConfig?.level).toBe(1300);
    expect(p!.personaConfig?.approximate).toBeUndefined();
    expect(p!.personaConfig?.book).toBe("local");
    expect(p!.strengthLabel).toMatch(/unmeasured/i);
    expect(p!.actions).toEqual(["play"]);
  });

  it("degrades silently when rival configs are absent — no rival entries, no errors", () => {
    const roster = buildRoster(null, []);
    expect(roster.some((p) => p.id.startsWith("rival-"))).toBe(false);
    expect(roster.find((p) => p.id === PRIVATE_RIVAL_ID)).toBeUndefined();
  });

  it("keeps a config-without-book rival playable, just without a book", () => {
    const roster = buildRoster(null, [{ config: rivalConfig(), book: null }]);
    const p = roster.find((x) => x.id === "rival-testrival")!;
    expect(p.personaConfig?.book).toBeUndefined();
    expect(p.personaConfig?.level).toBe(1300);
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

  it("ships zero avatar art — every entry falls back to initials", () => {
    const roster = buildRoster(SAMPLE_BOOK, [LOCAL_RIVAL]);
    for (const p of roster) expect(p.avatar).toBeUndefined();
  });
});

describe("gatePersonaLevel (the honesty gate, spec 216/214 hard rule)", () => {
  it("passes a runnable Maia-band config through as-is", () => {
    expect(gatePersonaLevel(rivalConfig())).toEqual({ level: 1300, approximate: false });
  });

  it("clamps runnable_in_engine_v1: false to the top band and marks it approximate", () => {
    const cfg = rivalConfig({
      runnable_in_engine_v1: false,
      backend: { kind: "lc0-policy" },
      sampling: { level: 1900 },
    });
    expect(gatePersonaLevel(cfg)).toEqual({ level: MAIA_MAX_NATIVE_BAND, approximate: true });
  });

  it("clamps an out-of-band level even when the config claims runnable", () => {
    const cfg = rivalConfig({
      sampling: { level: 2800 },
      backend: { kind: "maia", level: 2800 },
    });
    expect(gatePersonaLevel(cfg)).toEqual({ level: MAIA_MAX_NATIVE_BAND, approximate: true });
  });

  it("gates a non-Maia backend even when the config claims runnable", () => {
    const cfg = rivalConfig({ backend: { kind: "lc0-policy" }, sampling: { level: 1900 } });
    expect(gatePersonaLevel(cfg)).toEqual({ level: MAIA_MAX_NATIVE_BAND, approximate: true });
  });
});

describe("resolveParticipantBook", () => {
  const deps = { rivalBook: SAMPLE_BOOK, localRivals: [LOCAL_RIVAL] };

  it("returns the already-loaded rival book for the original private rival", async () => {
    await expect(
      resolveParticipantBook({ level: 1700, book: "rival" }, deps),
    ).resolves.toBe(SAMPLE_BOOK);
  });

  it("returns a local rival's book delivered with its config", async () => {
    await expect(
      resolveParticipantBook({ level: 1300, book: "local", bookSlug: "testrival" }, deps),
    ).resolves.toBe(LOCAL_RIVAL.book);
  });

  it("loads a committed GM persona book lazily", async () => {
    const book = await resolveParticipantBook(
      { level: 1900, book: "persona", bookSlug: "fischer" },
      deps,
    );
    expect(book).not.toBeNull();
    expect(book!.rival).toBe("fischer");
    expect(book!.entries.length).toBeGreaterThan(0);
  });

  it("resolves null for book-less participants and unknown slugs", async () => {
    await expect(resolveParticipantBook({ level: 1500 }, deps)).resolves.toBeNull();
    await expect(
      resolveParticipantBook({ level: 1900, book: "persona", bookSlug: "nope" }, deps),
    ).resolves.toBeNull();
    await expect(
      resolveParticipantBook({ level: 1300, book: "local", bookSlug: "nope" }, deps),
    ).resolves.toBeNull();
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
