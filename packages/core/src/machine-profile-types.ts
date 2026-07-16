// Machine speed-profile domain types (spec 216) — extracted to
// @chessgui/core (spec 220 step 5). Field names mirror the Rust
// `MachineProfile` (serde snake_case).

/**
 * The persisted per-machine speed profile (spec 216, Tier 0). Field names mirror
 * the Rust `MachineProfile` (serde snake_case). `curve` is null while the
 * literature prior is in effect; the Tier-1 ladder fills it in.
 * `hw_fingerprint` is an opaque hardware identity (CPU/cores/memory) — compared
 * for equality against the live machine to detect hardware changes (Tier 2).
 */
export interface MachineProfile {
  hostname: string;
  engine_name: string;
  engine_path: string;
  nps: number;
  threads: number;
  measured_at: string; // ISO-8601 UTC
  hw_fingerprint: string;
  curve: unknown | null;
  /**
   * Per-engine measurements keyed by engine `id name` (spec 216 Tier 2
   * "per-engine curves" — Reckless and Stockfish differ in nps and b(t)).
   * The top-level fields stay the most recent bench; absent on profiles
   * written before the map existed (the Rust side seeds it on read).
   */
  engines?: Record<string, EngineSpeed | undefined>;
}

/** One engine's speed measurement on a machine (mirrors Rust `EngineSpeed`).
 *  Fields may be missing on partially-written entries (e.g. a fit_curve.py
 *  curve landed before that engine was benched). */
export interface EngineSpeed {
  engine_path?: string;
  nps?: number;
  threads?: number;
  measured_at?: string; // ISO-8601 UTC
  curve?: unknown | null;
}

/** The bench measurement returned by `machine_bench` (profile is persisted separately). */
export interface BenchResult {
  nps: number;
  threads: number;
  engine_name: string;
  duration_ms: number;
}
