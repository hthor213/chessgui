import { describe, it, expect } from "vitest";
import {
  buildArenaRoster,
  mergeApiPersonas,
  TIER0_PERSONA_SLUGS,
  TIER1_PERSONA_SLUGS,
  UNLOCKED_PERSONA_SLUGS,
  type ArenaRosterEntry,
} from "@/lib/arena-roster";
import type { ArenaPersonaInfo } from "@chessgui/core/arena-api";

/** An /api/personas entry the way server/arena/app/main.py shapes it after
 *  lib/arena-api.ts's wire mapping. */
function apiPersona(overrides: Partial<ArenaPersonaInfo> = {}): ArenaPersonaInfo {
  return {
    slug: "fischer",
    displayName: "Bobby Fischer",
    bio: "",
    isPrivate: false,
    strengthLabel: null,
    ...overrides,
  };
}

/** The backend's private-persona shape (spec 217 Promise 1): the logged-in
 *  player's own persona, honest build_rival_configs-style label. */
const OWN_PERSONA = apiPersona({
  slug: "yourself",
  displayName: "Yourself",
  isPrivate: true,
  strengthLabel: "own book + Maia 1400, unmeasured",
});

describe("buildArenaRoster", () => {
  it("puts the Tier-0 playable personas first, in spec order", () => {
    const roster = buildArenaRoster();
    expect(roster.slice(0, TIER0_PERSONA_SLUGS.length).map((e) => e.slug)).toEqual([
      ...TIER0_PERSONA_SLUGS,
    ]);
    expect(roster.slice(0, TIER0_PERSONA_SLUGS.length).every((e) => e.available)).toBe(true);
  });

  it("unlocks the Tier-1 roster (spec 217: Karpov, Spassky, Icelandic canon) after Tier 0", () => {
    const roster = buildArenaRoster();
    expect(roster.slice(0, UNLOCKED_PERSONA_SLUGS.length).map((e) => e.slug)).toEqual([
      ...UNLOCKED_PERSONA_SLUGS,
    ]);
    for (const slug of TIER1_PERSONA_SLUGS) {
      const entry = roster.find((e) => e.slug === slug);
      // Every Tier-1 slug must be backed by a committed, gate-passing
      // manifest entry — an unlock without artifacts would be a lie.
      expect(entry, `missing manifest entry for ${slug}`).toBeDefined();
      expect(entry!.available).toBe(true);
      expect(entry!.strengthLabel).toContain("move-match");
    }
  });
});

describe("mergeApiPersonas (spec 217 Promise 1: per-user private persona)", () => {
  it("leaves the roster unchanged when the API adds nothing (fetch-failure path)", () => {
    const roster = buildArenaRoster();
    expect(mergeApiPersonas(roster, [])).toEqual(roster);
  });

  it("does not duplicate or relabel GM slugs the manifest already knows", () => {
    const roster = buildArenaRoster();
    const merged = mergeApiPersonas(roster, [apiPersona()]);
    expect(merged).toEqual(roster);
    // The manifest's measured label wins over the server's null.
    const fischer = merged.find((e) => e.slug === "fischer")!;
    expect(fischer.strengthLabel).toContain("move-match");
  });

  it("prepends the player's own private persona as a playable card", () => {
    const merged = mergeApiPersonas(buildArenaRoster(), [OWN_PERSONA, apiPersona()]);
    const own = merged[0];
    expect(own.slug).toBe("yourself");
    expect(own.available).toBe(true);
    expect(own.isPrivate).toBe(true);
    expect(own.initials).toBe("YO"); // lib/roster.ts initialsFor single-word form
    // spec 216 hard rule: the card carries the server's honest label verbatim.
    expect(own.strengthLabel).toBe("own book + Maia 1400, unmeasured");
  });

  it("appends non-private server-only personas after the static roster", () => {
    // A slug the client manifest does not know (e.g. a friend-on-request
    // persona, spec 217 Promise 4, deployed server-side only).
    const extra = apiPersona({ slug: "dads-friend", displayName: "Dads Friend" });
    const merged = mergeApiPersonas(buildArenaRoster(), [extra]);
    const last = merged[merged.length - 1] as ArenaRosterEntry;
    expect(last.slug).toBe("dads-friend");
    expect(last.available).toBe(true);
    expect(last.strengthLabel).toBe("unmeasured");
  });
});
