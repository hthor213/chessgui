import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// The board is a next/dynamic({ ssr: false }) import; stub it so the roster
// screen renders without pulling in Chessground (neither the roster nor the
// config screen shows a board anyway).
vi.mock("next/dynamic", () => ({
  default: () => () => null,
}));

import { SparTab, samplingParamsFor } from "@chessgui/ui/spar-tab";
import { buildRoster, GM_PERSONA_CONFIGS, applyPersonaStrength } from "@/lib/roster";

describe("SparTab entry point renders", () => {
  it("renders the roster (Play vs Bot) as the initial screen", () => {
    // Effects don't run under renderToStaticMarkup, so the rival book stays
    // unloaded and the private rival's card is absent (spec 214 hard rule:
    // his entry appears only once the local book has loaded) — this render
    // shows Fischer, Kasparov, and the Maia strength bands.
    const html = renderToStaticMarkup(createElement(SparTab));
    expect(html).toContain('data-testid="spar-roster"');
    expect(html).toContain("Play vs Bot");
    expect(html).toContain('data-testid="roster-grid"');

    // GM personas: Play only (no Improve profile), and — spec 218 Decision
    // 2026-07-17 — an explicit strength selector defaulting to Full strength
    // (BT3), not a silent cap. The stale "available in Tournament" copy is gone.
    expect(html).toContain('data-testid="roster-card-fischer"');
    expect(html).toContain('data-testid="roster-play-fischer"');
    expect(html).not.toContain('data-testid="roster-improve-fischer"');
    expect(html).toContain('data-testid="roster-card-kasparov"');
    expect(html).toContain('data-testid="roster-card-sigurjonsson-peak"');
    expect(html).not.toContain("full-strength persona available in Tournament");

    // The strength selector renders on each GM card, defaulting to Full
    // strength: the card label names the BT3 policy and the first-use download
    // note shows (no TS-side net presence check — static copy per the decision).
    expect(html).toContain('data-testid="roster-strength-fischer"');
    expect(html).toContain("Full strength");
    expect(html).toContain("~1100 approximation"); // the low band option
    expect(html).toContain('data-testid="roster-label-kasparov"');
    expect(html).toContain("full-strength policy (BT3)");
    expect(html).toContain('data-testid="roster-strength-note-fischer"');
    expect(html).toContain("Downloads a ~190MB net on first use");

    // Maia band bots carry no selector — they aren't BT3-backed.
    expect(html).not.toContain('data-testid="roster-strength-maia-1500"');

    // Maia strength bands as generic bots, full 1100-1900 set.
    expect(html).toContain('data-testid="roster-card-maia-1100"');
    expect(html).toContain('data-testid="roster-card-maia-1900"');
    expect(html).toContain("Bot 1500");

    // The private rival's card is NOT present in this unloaded-book render.
    expect(html).not.toContain('data-testid="roster-card-rival"');
    expect(html).not.toContain("Spar vs Dad");
  });
});

describe("samplingParamsFor — persona_move wire params (spec 218 follow-up)", () => {
  it("includes `weights` exactly when the config has a bt3 backend", () => {
    const roster = buildRoster(null);
    // Every committed GM persona is BT3-backed: the roster's honesty gate
    // resolves the managed net, so the persona_move params carry the
    // `weights` selector (with the gated Maia band as its fallback level).
    for (const cfg of GM_PERSONA_CONFIGS) {
      const p = roster.find((x) => x.id === cfg.slug)!;
      expect(samplingParamsFor(p.personaConfig).weights, cfg.slug).toBe("bt3");
    }
    // Maia band bots have no managed-net backend — no weights key at all,
    // so persona_move serves the plain Maia band.
    const bot = roster.find((x) => x.id === "maia-1500")!;
    expect("weights" in samplingParamsFor(bot.personaConfig)).toBe(false);
    // No persona config — no weights either.
    expect("weights" in samplingParamsFor(undefined)).toBe(false);
  });

  it("carries weights on Full strength and drops it on a band pick (spec 218 2026-07-17)", () => {
    const kasparov = buildRoster(null).find((x) => x.id === "kasparov")!;
    // Full strength → weights:"bt3" + top native fallback band.
    const full = samplingParamsFor(applyPersonaStrength(kasparov, "full").personaConfig);
    expect(full.weights).toBe("bt3");
    // Band pick → NO weights, and the level rides through as the picked band.
    const band = applyPersonaStrength(kasparov, 1500);
    expect("weights" in samplingParamsFor(band.personaConfig)).toBe(false);
    expect(band.personaConfig?.level).toBe(1500);
  });
});
