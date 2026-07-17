import { describe, it, expect } from "vitest";
import {
  buildRoster,
  gatePersonaLevel,
  initialsFor,
  isPipelineProfile,
  GM_PERSONA_CONFIGS,
  MAIA_ROSTER_BANDS,
  PRIVATE_RIVAL_ID,
  PRIVATE_RIVAL_DISPLAY_NAME,
  SELF_PERSONA_ID,
  SELF_PERSONA_DISPLAY_NAME,
  resolveParticipantBook,
  applyPersonaStrength,
  hasStrengthSelector,
  personaStrengthLabel,
  personaStrengthStorageKey,
  loadPersonaStrength,
  savePersonaStrength,
  PERSONA_STRENGTH_BANDS,
  DEFAULT_PERSONA_STRENGTH,
  type LocalPlayerProfile,
  type LocalRivalPersona,
  type PersonaConfigFile,
  type Participant,
} from "@/lib/roster";
import type { StorageProvider } from "@chessgui/core/platform-types";
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

/** The self persona the way scripts/persona/build_self_persona.py writes it
 *  (spec 218 "Own-persona entry") — kind "self", Maia-band backend. */
const SELF_PERSONA: LocalRivalPersona = {
  config: rivalConfig({ slug: "self", display_name: "You", kind: "self", backend: { kind: "maia", level: 1200 }, sampling: { level: 1200 } }),
  book: { version: 1, max_ply: 8, rival: "self", entries: [] },
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

  it("HONESTY GATE: BT3-backed GM personas keep the approximate top-band CLAIM while carrying the resolved backend", () => {
    const roster = buildRoster(null);
    for (const cfg of GM_PERSONA_CONFIGS) {
      // Every committed GM config is BT3-backed and not runnable as a plain
      // Maia band.
      expect(cfg.runnable_in_engine_v1).toBe(false);
      const p = roster.find((x) => x.id === cfg.slug)!;
      expect(p.personaConfig?.approximate).toBe(true);
      expect(p.personaConfig?.level).toBe(MAIA_MAX_NATIVE_BAND);
      // Default card = Full strength (spec 218 2026-07-17): the honest label
      // names the BT3 policy, no stale "available in Tournament" cap.
      expect(p.strengthLabel).toMatch(/his openings/i);
      expect(p.strengthLabel).toMatch(/full-strength policy \(BT3\)/);
      expect(p.strengthLabel).not.toMatch(/Tournament/);
      // The gate-resolved backend selector: persona_move drives the BT3 net
      // when it's present and falls back to the gated Maia band otherwise
      // (spec 218 follow-up) — the claim above stays gated either way.
      expect(p.personaConfig?.weights, cfg.slug).toBe("bt3");
    }
  });

  it("HONESTY GATE: no roster entry ever exceeds the top native Maia band", () => {
    const roster = buildRoster(SAMPLE_BOOK, [LOCAL_RIVAL]);
    for (const p of roster) {
      if (!p.personaConfig) continue;
      expect(p.personaConfig.level, p.id).toBeLessThanOrEqual(MAIA_MAX_NATIVE_BAND);
    }
  });

  it("flows a tuner-enabled error model into the persona config, and ONLY then (spec 214 step 5 gate)", () => {
    // Absent and null (measured-and-rejected) both mean OFF.
    const roster = buildRoster(null, [LOCAL_RIVAL]);
    expect(roster.find((x) => x.id === "rival-testrival")!.personaConfig?.errorModel).toBeUndefined();
    const rejected: LocalRivalPersona = {
      config: rivalConfig({ sampling: { level: 1300, error_model: null } }),
      book: LOCAL_RIVAL.book,
    };
    const r2 = buildRoster(null, [rejected]);
    expect(r2.find((x) => x.id === "rival-testrival")!.personaConfig?.errorModel).toBeUndefined();
    // An enabled fit (only the tuner writes one) flows through verbatim.
    const em = { cells: { "middlegame|+0.0|none": 0.05 }, rate_scale: 1.5 };
    const enabled: LocalRivalPersona = {
      config: rivalConfig({ sampling: { level: 1300, error_model: em } }),
      book: LOCAL_RIVAL.book,
    };
    const r3 = buildRoster(null, [enabled]);
    expect(r3.find((x) => x.id === "rival-testrival")!.personaConfig?.errorModel).toEqual(em);
  });

  it("includes local private rivals from their configs, at their own band, honestly unmeasured", () => {
    const roster = buildRoster(null, [LOCAL_RIVAL]);
    const p = roster.find((x) => x.id === "rival-testrival");
    expect(p).toBeDefined();
    // Display name comes from the LOCAL config file, never committed code.
    expect(p!.displayName).toBe("Neighbor");
    expect(p!.personaConfig?.level).toBe(1300);
    expect(p!.personaConfig?.approximate).toBeUndefined();
    // Maia-band backend — no managed-net selector to resolve.
    expect("weights" in (p!.personaConfig ?? {})).toBe(false);
    expect(p!.personaConfig?.book).toBe("local");
    expect(p!.strengthLabel).toMatch(/unmeasured/i);
    expect(p!.actions).toEqual(["play"]);
  });

  it("surfaces the self persona as 'You', first, when its book artifact exists (spec 218 own-persona entry)", () => {
    const roster = buildRoster(SAMPLE_BOOK, [LOCAL_RIVAL, SELF_PERSONA]);
    const you = roster.find((p) => p.id === SELF_PERSONA_ID);
    expect(you).toBeDefined();
    expect(roster[0]).toBe(you);
    expect(you!.displayName).toBe(SELF_PERSONA_DISPLAY_NAME);
    expect(you!.personaConfig?.level).toBe(1200);
    expect(you!.personaConfig?.approximate).toBeUndefined();
    expect(you!.personaConfig?.book).toBe("local");
    expect(you!.personaConfig?.bookSlug).toBe("self");
    expect(you!.strengthLabel).toMatch(/your real openings/i);
    expect(you!.actions).toEqual(["play"]);
    // Its own card only — never doubled as a generic local-rival entry.
    expect(roster.find((p) => p.id === "rival-self")).toBeUndefined();
  });

  it("omits the self persona entirely while its book is unbuilt (gated on the artifact)", () => {
    const roster = buildRoster(null, [{ config: SELF_PERSONA.config, book: null }]);
    expect(roster.find((p) => p.id === SELF_PERSONA_ID)).toBeUndefined();
    expect(roster.find((p) => p.id === "rival-self")).toBeUndefined();
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
      expect("weights" in (bot!.personaConfig ?? {})).toBe(false);
      expect(bot!.actions).toEqual(["play"]);
    }
    expect(MAIA_ROSTER_BANDS.length).toBe(9);
  });

  it("ships zero avatar art — every entry falls back to initials", () => {
    const roster = buildRoster(SAMPLE_BOOK, [LOCAL_RIVAL]);
    for (const p of roster) expect(p.avatar).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Spec 225: pipeline profiles in the roster (badges + dossier-only gating)
// ---------------------------------------------------------------------------

/** A pipeline profile the way build_player_profile.py writes it. */
function pipelineProfile(overrides: Partial<LocalPlayerProfile["profile"]> = {}): LocalPlayerProfile {
  return {
    profile: {
      slug: "testrival",
      display_name: "Neighbor",
      sample: {
        games: 47,
        verified_games: 47,
        verdict: "full",
        badge: null,
        reasons: [],
      },
      rating: { value: 1500, source: "corpus" },
      ...overrides,
    },
    stats: null,
  };
}

describe("buildRoster with pipeline profiles (spec 225)", () => {
  it("badges a config-armed rival with the STORED low-confidence verdict and arms Beat", () => {
    const profile = pipelineProfile({
      sample: {
        games: 12,
        verified_games: 12,
        verdict: "low-confidence",
        badge: "LOW-CONFIDENCE",
        reasons: ["12 verified games < 30 full-persona floor"],
      },
    });
    const roster = buildRoster(null, [LOCAL_RIVAL], [profile]);
    const p = roster.find((x) => x.id === "rival-testrival")!;
    expect(p.verdictBadge).toBe("LOW-CONFIDENCE");
    expect(p.badgeTitle).toContain("30 full-persona floor");
    expect(p.profileSlug).toBe("testrival");
    expect(p.actions).toEqual(["play", "beat"]);
    // Still a playable persona at its own gated level.
    expect(p.personaConfig?.level).toBe(1300);
  });

  it("leaves a full-verdict profile unbadged but Beat-armed", () => {
    const roster = buildRoster(null, [LOCAL_RIVAL], [pipelineProfile()]);
    const p = roster.find((x) => x.id === "rival-testrival")!;
    expect(p.verdictBadge).toBeUndefined();
    expect(p.actions).toEqual(["play", "beat"]);
  });

  it("surfaces a dossier-only profile as a card that fields NO bot", () => {
    const dossier = pipelineProfile({
      slug: "otbplayer",
      display_name: "OTB Player",
      sample: {
        games: 32,
        verified_games: 26,
        verdict: "dossier-only",
        badge: "DOSSIER-ONLY",
        reasons: ["corpus pending review"],
      },
      rating: { value: 2236, source: "corpus Elo headers" },
    });
    const roster = buildRoster(null, [], [dossier]);
    const p = roster.find((x) => x.id === "profile-otbplayer")!;
    expect(p).toBeDefined();
    expect(p.displayName).toBe("OTB Player");
    expect(p.actions).toEqual(["beat"]); // no Play — it fields no bot
    expect(p.personaConfig).toBeUndefined();
    expect(p.verdictBadge).toBe("DOSSIER-ONLY");
    expect(p.strengthLabel).toContain("fields no bot");
    expect(p.strengthLabel).toContain("26 verified");
  });

  it("never doubles a profile that already has a loaded config as a dossier card", () => {
    const roster = buildRoster(null, [LOCAL_RIVAL], [pipelineProfile()]);
    expect(roster.find((x) => x.id === "profile-testrival")).toBeUndefined();
  });

  it("degrades silently with no profiles — the pre-225 roster, byte for byte", () => {
    expect(buildRoster(SAMPLE_BOOK, [LOCAL_RIVAL], [])).toEqual(
      buildRoster(SAMPLE_BOOK, [LOCAL_RIVAL]),
    );
  });
});

describe("isPipelineProfile (legacy profile.json filter)", () => {
  it("accepts a pipeline record with a stored verdict", () => {
    expect(isPipelineProfile(pipelineProfile().profile)).toBe(true);
  });

  it("rejects the legacy chess.com player dumps (no sample verdict)", () => {
    // The pre-225 hand-built era wrote raw chess.com /player responses to
    // <slug>.profile.json — they must not surface with an invented verdict.
    expect(
      isPipelineProfile({ player_id: 1, username: "someone", name: "Some One" }),
    ).toBe(false);
    expect(isPipelineProfile(null)).toBe(false);
    expect(isPipelineProfile({ slug: "x", display_name: "X" })).toBe(false);
    expect(isPipelineProfile({ slug: "x", display_name: "X", sample: {} })).toBe(false);
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

  it("resolves a BT3-backed config to the weights selector while keeping the claim gated (spec 218 follow-up)", () => {
    const cfg = rivalConfig({
      runnable_in_engine_v1: false,
      backend: { kind: "lc0-policy", net: { file: "BT3-768x15x24h-swa-2790000.pb.gz" } },
      sampling: { level: 2790 },
    });
    // Level stays clamped (it is the Maia FALLBACK band) and approximate
    // stays true — persona_move only best-efforts the net; the decision
    // log's policy_backend reports what actually served.
    expect(gatePersonaLevel(cfg)).toEqual({
      level: MAIA_MAX_NATIVE_BAND,
      approximate: true,
      weights: "bt3",
    });
  });

  it("resolves NO weights for an unknown managed net — a gated-down persona keeps Maia", () => {
    const cfg = rivalConfig({
      runnable_in_engine_v1: false,
      backend: { kind: "lc0-policy", net: { file: "some-other-net.pb.gz" } },
      sampling: { level: 1900 },
    });
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

// ---------------------------------------------------------------------------
// Spec 218 Decision 2026-07-17: explicit GM persona strength (no silent cap)
// ---------------------------------------------------------------------------

/** A BT3-backed GM participant straight from the roster (fischer, config-
 *  driven) — its personaConfig resolves the managed net. */
function gmParticipant(slug = "fischer"): Participant {
  return buildRoster(null).find((p) => p.id === slug)!;
}

/** An in-memory StorageProvider for the persistence round-trip. */
function fakeStorage(): StorageProvider & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get: (k) => (map.has(k) ? map.get(k)! : null),
    set: (k, v) => void map.set(k, v),
    remove: (k) => void map.delete(k),
  };
}

describe("hasStrengthSelector (spec 218 2026-07-17)", () => {
  it("is true for BT3-backed GM personas, false for Maia-band bots and rivals", () => {
    const roster = buildRoster(SAMPLE_BOOK, [LOCAL_RIVAL]);
    expect(hasStrengthSelector(roster.find((p) => p.id === "fischer")!)).toBe(true);
    expect(hasStrengthSelector(roster.find((p) => p.id === "maia-1500")!)).toBe(false);
    expect(hasStrengthSelector(roster.find((p) => p.id === "rival-testrival")!)).toBe(false);
    expect(hasStrengthSelector(roster.find((p) => p.id === PRIVATE_RIVAL_ID)!)).toBe(false);
  });

  it("offers Full plus the five approximation bands, defaulting to Full", () => {
    expect(DEFAULT_PERSONA_STRENGTH).toBe("full");
    expect([...PERSONA_STRENGTH_BANDS]).toEqual([1900, 1700, 1500, 1300, 1100]);
  });
});

describe("personaStrengthLabel (spec 218 2026-07-17)", () => {
  it("names the BT3 policy for Full and the approximation for a band", () => {
    expect(personaStrengthLabel("Kasparov", "full")).toBe(
      "Kasparov — his openings, full-strength policy (BT3)",
    );
    expect(personaStrengthLabel("Kasparov", 1500)).toBe(
      "Kasparov — his openings, ~1500 approximation",
    );
  });

  it("gives the GM card the Full-strength label by default (no stale Tournament copy)", () => {
    const p = gmParticipant("kasparov");
    expect(p.strengthLabel).toBe(`${p.displayName} — his openings, full-strength policy (BT3)`);
    expect(p.strengthLabel).not.toMatch(/Tournament/);
  });
});

describe("applyPersonaStrength (spec 218 2026-07-17)", () => {
  it("Full strength keeps weights:bt3 and the top native fallback band", () => {
    const p = applyPersonaStrength(gmParticipant(), "full");
    expect(p.personaConfig?.weights).toBe("bt3");
    expect(p.personaConfig?.level).toBe(MAIA_MAX_NATIVE_BAND);
    // The player's own book still plays.
    expect(p.personaConfig?.book).toBe("persona");
    expect(p.personaConfig?.bookSlug).toBe("fischer");
    expect(p.strengthLabel).toMatch(/full-strength policy \(BT3\)/);
  });

  it("a band pick drops weights (pure Maia) and plays at the picked band", () => {
    const p = applyPersonaStrength(gmParticipant(), 1500);
    expect("weights" in (p.personaConfig ?? {})).toBe(false);
    expect(p.personaConfig?.level).toBe(1500);
    // Book preserved — his openings play at every strength.
    expect(p.personaConfig?.book).toBe("persona");
    expect(p.strengthLabel).toBe(`${p.displayName} — his openings, ~1500 approximation`);
  });

  it("every offered band round-trips to a valid native level and drops weights", () => {
    for (const band of PERSONA_STRENGTH_BANDS) {
      const p = applyPersonaStrength(gmParticipant(), band);
      expect(p.personaConfig?.level).toBe(band);
      expect(p.personaConfig?.level).toBeLessThanOrEqual(MAIA_MAX_NATIVE_BAND);
      expect("weights" in (p.personaConfig ?? {})).toBe(false);
    }
  });

  it("passes non-selectable participants (Maia bands, rivals) through untouched", () => {
    const roster = buildRoster(SAMPLE_BOOK, [LOCAL_RIVAL]);
    const bot = roster.find((p) => p.id === "maia-1500")!;
    expect(applyPersonaStrength(bot, 1100)).toBe(bot);
    const rival = roster.find((p) => p.id === "rival-testrival")!;
    expect(applyPersonaStrength(rival, "full")).toBe(rival);
  });
});

describe("persona strength persistence (spec 218 2026-07-17)", () => {
  it("keys per persona under chessgui:persona-strength:<id>", () => {
    expect(personaStrengthStorageKey("fischer")).toBe("chessgui:persona-strength:fischer");
  });

  it("round-trips Full and a band, defaulting to Full when absent or corrupt", () => {
    const storage = fakeStorage();
    // Absent → Full.
    expect(loadPersonaStrength(storage, "fischer")).toBe("full");
    // Band round-trip.
    savePersonaStrength(storage, "fischer", 1300);
    expect(storage.map.get("chessgui:persona-strength:fischer")).toBe("1300");
    expect(loadPersonaStrength(storage, "fischer")).toBe(1300);
    // Full round-trip.
    savePersonaStrength(storage, "fischer", "full");
    expect(loadPersonaStrength(storage, "fischer")).toBe("full");
    // Corrupt / out-of-set → Full.
    storage.set("chessgui:persona-strength:fischer", "9999");
    expect(loadPersonaStrength(storage, "fischer")).toBe("full");
    storage.set("chessgui:persona-strength:fischer", "garbage");
    expect(loadPersonaStrength(storage, "fischer")).toBe("full");
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
