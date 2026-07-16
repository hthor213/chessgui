// GM persona sampling params + honest strength labels for the tournament/
// exhibition Participant dropdown (spec 218 "Exhibition & tournament"
// checklist item 1) — the wire-shape (weights:"bt3", real sampling params)
// twin of lib/roster.ts's `GM_PERSONA_CONFIGS`.
//
// HOW THESE REACH THE APP AT RUNTIME: a plain TypeScript static `import` of
// the committed data/personas/*.config.json files. This mirrors the pattern
// lib/roster.ts already established for the exact same files (its
// `GM_PERSONA_CONFIGS`) — confirmed working there, so no new mechanism is
// invented here; `tsconfig.json`'s `resolveJsonModule` makes each import a
// small (~1KB) typed object bundled at build time, no runtime fetch and no
// Tauri command needed. The multi-MB `*.book.json` files are NOT imported
// here (or in roster.ts) — those load lazily, and the tournament runner has
// no book concept to feed anyway (see lib/tournament-roster.ts's rivalEntry
// comment for that limitation).
//
// WHY A SEPARATE FILE FROM lib/roster.ts's GM_PERSONA_CONFIGS, given both
// import the same JSON: the two surfaces need different DERIVED shapes.
// roster.ts's `gatePersonaLevel` HONESTY GATE clamps every GM persona to the
// top native Maia band for Play vs Bot, because that surface's engine
// (`persona_move`) literally cannot drive a managed net — sending `weights`
// there would silently do nothing (worse: an unreviewed reader might assume
// it works). The tournament/exhibition runner (`match_runner.rs`'s
// `PersonaConfig`) is a DIFFERENT engine that DOES support a managed net via
// `weights: "bt3"` (spec 218 "Managed weights" checklist item, 2026-07-15) —
// so on THIS surface sending `weights` is both possible and required by the
// honesty gate (a GM persona must never be sent level-only). Two engines,
// two honestly-different capabilities, two derived shapes from one JSON
// source of truth.
//
// Regenerates itself automatically — there is no snapshot to go stale: this
// module recomputes `GM_PERSONAS` from the live imports below every time it
// loads, so a data/personas/*.config.json edit takes effect on the next
// build/dev-server restart with no separate script to remember to run.

import type { ErrorModel } from "@chessgui/core/persona-types"

import fischerConfig from "@/data/personas/fischer.config.json"
import kasparovConfig from "@/data/personas/kasparov.config.json"
import karpovConfig from "@/data/personas/karpov.config.json"
import spasskyConfig from "@/data/personas/spassky.config.json"
import fridrikOlafssonConfig from "@/data/personas/fridrik-olafsson.config.json"
import helgiOlafssonConfig from "@/data/personas/helgi-olafsson.config.json"
import johannHjartarsonConfig from "@/data/personas/johann-hjartarson.config.json"
import jonLArnasonConfig from "@/data/personas/jon-l-arnason.config.json"
import margeirPeturssonConfig from "@/data/personas/margeir-petursson.config.json"
import hannesStefanssonConfig from "@/data/personas/hannes-stefansson.config.json"
import hedinnSteingrimssonConfig from "@/data/personas/hedinn-steingrimsson.config.json"
import sigurjonssonPeakConfig from "@/data/personas/sigurjonsson-peak.config.json"

/** Only the fields this module consumes from a data/personas/*.config.json
 *  file (the files carry more — extraction provenance, book stats). */
interface RawPersonaConfig {
  slug: string
  display_name: string
  kind: string
  backend?: { kind: string; net?: { file?: string } }
  sampling: {
    level: number
    temperature?: number
    alpha?: number
    lambda?: number
    top_k?: number
    verify_depth?: number
    /** Corpus error model (spec 214 step 5); null/absent = OFF. Only a
     *  tuner-enabled (held-out +2% bar) config ever carries one. */
    error_model?: ErrorModel | null
  }
  harness?: { "match@1"?: number; "match@3"?: number; n?: number; date?: string }
}

const RAW_CONFIGS = [
  fischerConfig,
  kasparovConfig,
  karpovConfig,
  spasskyConfig,
  fridrikOlafssonConfig,
  helgiOlafssonConfig,
  johannHjartarsonConfig,
  jonLArnasonConfig,
  margeirPeturssonConfig,
  hannesStefanssonConfig,
  hedinnSteingrimssonConfig,
  sigurjonssonPeakConfig,
] as unknown as RawPersonaConfig[]

/** The BT3 managed net's file name (src-tauri/src/maia.rs `MANAGED_NETS`,
 *  name "bt3") — every committed GM config's backend targets this net today;
 *  a config targeting a different/no managed net is skipped below rather
 *  than sent level-only (spec 218 item 1 honesty gate). */
const BT3_NET_FILE = "BT3-768x15x24h-swa-2790000.pb.gz"

export interface GmPersonaManifestEntry {
  slug: string
  displayName: string
  level: number
  temperature: number
  alpha: number
  lambda: number
  topK?: number
  verifyDepth?: number
  /** Corpus error model (spec 214 step 5), tuner-gated; undefined = OFF. */
  errorModel?: ErrorModel
  weights: "bt3"
  /** Held-out move-match rate @1 candidate (spec 216 harness label basis). */
  matchAt1: number
  matchAt3: number | null
  harnessN: number | null
  harnessDate: string | null
}

export const GM_PERSONAS: GmPersonaManifestEntry[] = RAW_CONFIGS.filter((cfg) => {
  // Public figures only (spec 214 hard rule — private individuals never ship
  // committed; belt-and-suspenders alongside data/rivals staying gitignored).
  if (cfg.kind !== "public-figure") return false
  // Only a resolvable managed-net backend; a level-only config never ships
  // as a "runnable" GM entry (the honesty gate this whole file exists for).
  if (cfg.backend?.kind !== "lc0-policy" || cfg.backend?.net?.file !== BT3_NET_FILE) return false
  return typeof cfg.harness?.["match@1"] === "number"
}).map((cfg) => ({
  slug: cfg.slug,
  displayName: cfg.display_name,
  level: cfg.sampling.level,
  temperature: cfg.sampling.temperature ?? 0.5,
  alpha: cfg.sampling.alpha ?? 1.0,
  lambda: cfg.sampling.lambda ?? 0.75,
  topK: cfg.sampling.top_k,
  verifyDepth: cfg.sampling.verify_depth,
  // null in the file = measured-and-rejected by the tuner — same as OFF.
  ...(cfg.sampling.error_model ? { errorModel: cfg.sampling.error_model } : {}),
  weights: "bt3",
  matchAt1: cfg.harness!["match@1"]!,
  matchAt3: cfg.harness?.["match@3"] ?? null,
  harnessN: cfg.harness?.n ?? null,
  harnessDate: cfg.harness?.date ?? null,
}))
