import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

/**
 * The persisted per-machine speed profile (spec 216, Tier 0). Field names mirror
 * the Rust `MachineProfile` (serde snake_case). `curve` is null while the
 * literature prior is in effect; the Tier-1 ladder fills it in.
 */
export interface MachineProfile {
  hostname: string;
  engine_name: string;
  engine_path: string;
  nps: number;
  threads: number;
  measured_at: string; // ISO-8601 UTC
  curve: unknown | null;
}

/** The bench measurement returned by `machine_bench` (profile is persisted separately). */
export interface BenchResult {
  nps: number;
  threads: number;
  engine_name: string;
  duration_ms: number;
}

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Loads this machine's engine-speed profile on mount and lets the caller
 * re-measure it. `runBench()` runs the engine's `bench` (which persists a fresh
 * profile) and then reloads it. Outside Tauri the hook is inert (`profile` stays
 * null) so the frontend can render in a plain browser.
 */
export function useMachineProfile() {
  const [profile, setProfile] = useState<MachineProfile | null>(null);
  const [benching, setBenching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const benchingRef = useRef(false); // guards against overlapping bench runs

  const refresh = useCallback(async () => {
    if (!isTauri()) return;
    try {
      const p = await invoke<MachineProfile | null>("machine_profile_get");
      setProfile(p ?? null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const runBench = useCallback(
    async (enginePath?: string) => {
      if (!isTauri() || benchingRef.current) return;
      benchingRef.current = true;
      setBenching(true);
      setError(null);
      try {
        await invoke<BenchResult>("machine_bench", { enginePath: enginePath ?? null });
        await refresh(); // machine_bench persisted the profile — reload it
      } catch (e) {
        setError(String(e));
      } finally {
        benchingRef.current = false;
        setBenching(false);
      }
    },
    [refresh],
  );

  return { profile, benching, error, runBench };
}
