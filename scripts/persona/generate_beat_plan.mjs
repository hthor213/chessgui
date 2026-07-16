#!/usr/bin/env node
// Spec 225 Part 2, terminal path: emit data/rivals/<slug>.BEAT.md from the
// profile artifacts, using THE SAME generator the app uses (apps/desktop/
// lib/beat-program.ts — all its imports are type-only, so Node's native
// type-stripping runs it unmodified; single source of truth, no port).
//
// Usage: node scripts/persona/generate_beat_plan.mjs <slug>
// e.g.:  node scripts/persona/generate_beat_plan.mjs arnthor-einarsson

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const { buildBeatPlan } = await import(
  join(repoRoot, "apps", "desktop", "lib", "beat-program.ts")
);

const slug = process.argv[2];
if (!slug || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
  console.error("usage: generate_beat_plan.mjs <slug>   (e.g. arnthor-einarsson)");
  process.exit(2);
}

const rivals = join(repoRoot, "data", "rivals");
const readJson = (name) => {
  const p = join(rivals, name);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
};

const profile = readJson(`${slug}.profile.json`);
if (!profile || !profile.sample) {
  console.error(`error: ${slug}.profile.json not found or not a pipeline profile — run build_player_profile.py first`);
  process.exit(1);
}
const stats = readJson(`${slug}.stats.json`);
const book = readJson(`${slug}.book.json`);
const config = readJson(`${slug}.config.json`);

// hasPersona follows the artifact-existence rule; the level is clamped to
// the published Maia bands like the roster's honesty gate.
const hasPersona = config !== null;
const personaLevel = hasPersona
  ? Math.min(1900, Math.max(1100, config?.sampling?.level ?? 1500))
  : undefined;

const { program, markdown } = buildBeatPlan({ profile, stats, hasPersona, personaLevel, book });
const out = join(rivals, `${slug}.BEAT.md`);
writeFileSync(out, markdown);
console.log(`${program.name}: ${program.chapters.length} chapters -> ${out}`);
console.log(`  persona: ${hasPersona ? `yes (~${personaLevel})` : `no — dossier fallback (verdict: ${profile.sample.verdict})`}`);
