#!/usr/bin/env node
// Spec 225 Part 2, terminal path: emit data/rivals/<slug>.BEAT.md from the
// profile artifacts, using THE SAME generator the app uses (apps/desktop/
// lib/beat-program.ts — all its imports are type-only, so Node's native
// type-stripping runs it unmodified; single source of truth, no port).
//
// Two input shapes:
//   - pipeline profiles (<slug>.profile.json with a `sample` verdict) — the
//     build_player_profile.py output, used as-is;
//   - legacy rivals (pre-pipeline artifacts: chess.com dumps for profile/
//     stats, but a real book.json + config.json + identities.json row) — a
//     BeatTarget is synthesized honestly from the book corpus, and the doc's
//     verdict record SAYS it was derived that way, not stored.
//
// The trainee side of the rating gap comes from data/rivals/
// training_metrics.json (latest maia_rapid point) when one exists — the
// spec 225 honest-framing rule ("beat" means score against, not outrate).
//
// Usage: node scripts/persona/generate_beat_plan.mjs <slug>
// e.g.:  node scripts/persona/generate_beat_plan.mjs arnthor-einarsson
// Env:   CHESSGUI_RIVALS_DIR overrides the data/rivals location.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const { buildBeatPlan, traineeFromMetrics } = await import(
  join(repoRoot, "apps", "desktop", "lib", "beat-program.ts")
);

const slug = process.argv[2];
if (!slug || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
  console.error("usage: generate_beat_plan.mjs <slug>   (e.g. arnthor-einarsson)");
  process.exit(2);
}

const rivals = process.env.CHESSGUI_RIVALS_DIR ?? join(repoRoot, "data", "rivals");
const readJson = (name) => {
  const p = join(rivals, name);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
};

const rawProfile = readJson(`${slug}.profile.json`);
const stats = readJson(`${slug}.stats.json`);
const book = readJson(`${slug}.book.json`);
const config = readJson(`${slug}.config.json`);

// Same thresholds as build_player_profile.py — named constants, not vibes.
const FULL_PERSONA_FLOOR = 30;
const PERSONA_MIN_GAMES = 10;

/** Legacy fallback: no pipeline profile, but a book built from the rival's
 *  real games plus an identities.json row. The synthesized verdict states
 *  its own provenance (derived from the book corpus, not a stored record). */
function synthesizeLegacyTarget() {
  const identity = readJson("identities.json")?.[slug];
  const games = book?.stats?.games_used ?? 0;
  if (!identity || !book || games === 0) return null;
  const verdict =
    games >= FULL_PERSONA_FLOOR ? "full" : games >= PERSONA_MIN_GAMES ? "low-confidence" : "dossier-only";
  const profile = {
    slug,
    display_name: config?.display_name ?? identity.display ?? slug,
    relationship: identity.relationship,
    sample: {
      games,
      verified_games: games,
      unverified_games: 0,
      thresholds: { full_persona_floor: FULL_PERSONA_FLOOR, persona_min_games: PERSONA_MIN_GAMES },
      verdict,
      badge: verdict === "full" ? null : verdict === "low-confidence" ? "LOW-CONFIDENCE" : "DOSSIER-ONLY",
      reasons: [
        `legacy (pre-pipeline) artifacts: verdict derived from the book corpus (${games} games), ` +
          `not a stored pipeline record — rerun build_player_profile.py for the full dossier`,
      ],
    },
    rating:
      identity.rating != null
        ? { value: identity.rating, source: identity.rating_source ?? "identities.json" }
        : null,
  };
  // The legacy stats dump (chess.com API blob) carries no line data, but the
  // book does: its deepest most-weighted entries ARE his most-played lines.
  // Book entries sit AFTER a rival move, so white entries live on odd plies
  // and black entries on even ones — aim at his 3rd move either way.
  const linesFor = (color) => {
    let ply = Math.min(6, book.max_ply);
    if (ply % 2 !== (color === "white" ? 1 : 0)) ply -= 1;
    return (book.entries ?? [])
      .filter((e) => e.rival_color === color && e.ply === ply)
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 3)
      .map((e) => ({ line: e.line, games: e.weight }));
  };
  const legacyStats = {
    slug,
    top_lines: { as_white: linesFor("white"), as_black: linesFor("black") },
  };
  return { profile, stats: legacyStats };
}

let profile = rawProfile;
let effStats = stats;
let legacy = false;
if (!profile || !profile.sample) {
  const synth = synthesizeLegacyTarget();
  if (!synth) {
    console.error(
      `error: ${slug} has neither a pipeline profile (run build_player_profile.py) nor ` +
        `legacy book + identities.json artifacts to synthesize from`,
    );
    process.exit(1);
  }
  ({ profile, stats: effStats } = synth);
  legacy = true;
}

// hasPersona follows the artifact-existence rule; the level is clamped to
// the published Maia bands like the roster's honesty gate.
const hasPersona = config !== null;
const personaLevel = hasPersona
  ? Math.min(1900, Math.max(1100, config?.sampling?.level ?? 1500))
  : undefined;

// Trainee side of the rating gap: the newest measured maia_rapid, if any.
const trainee = traineeFromMetrics(readJson("training_metrics.json")?.points ?? null);

const { program, markdown } = buildBeatPlan({
  profile,
  stats: effStats,
  hasPersona,
  personaLevel,
  book,
  trainee,
});
const out = join(rivals, `${slug}.BEAT.md`);
writeFileSync(out, markdown);
console.log(`${program.name}: ${program.chapters.length} chapters -> ${out}`);
console.log(`  persona: ${hasPersona ? `yes (~${personaLevel})` : `no — dossier fallback (verdict: ${profile.sample.verdict})`}`);
if (legacy) console.log(`  source: legacy artifacts (book corpus + identities.json) — verdict synthesized, and the doc says so`);
if (trainee) console.log(`  trainee: ${trainee.rating} (${trainee.source}) — rating gap framed when >= 100`);
