import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

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

/** The user's configured engine, matching what the rest of the app benches with. */
function storedEnginePath(): string | undefined {
  if (typeof window === "undefined") return undefined;
  return localStorage.getItem("engine-path") ?? undefined;
}

// The startup auto-bench (spec 216 Tier 2: first-start bench on a new install,
// re-bench on hardware change) runs at most once per app session, no matter how
// many components mount the hook or how often they remount.
let autoBenchAttempted = false;

// Lets every mounted instance of the hook reload after any of them benches, so
// e.g. the analysis panel's PRIOR/MEASURED label doesn't lag a bench started
// from the tournament tab.
const PROFILE_UPDATED_EVENT = "machine-profile-updated";

/**
 * Loads this machine's engine-speed profile on mount and lets the caller
 * re-measure it. `runBench()` runs the engine's `bench` (which persists a fresh
 * profile) and then reloads it. On first app start (no profile yet) or when the
 * stored hardware fingerprint no longer matches this machine, a bench runs
 * automatically — `hwChanged` tells the UI why. Outside Tauri the hook is inert
 * (`profile` stays null) so the frontend can render in a plain browser.
 */
export function useMachineProfile() {
  const [profile, setProfile] = useState<MachineProfile | null>(null);
  const [benching, setBenching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hwChanged, setHwChanged] = useState(false);
  const benchingRef = useRef(false); // guards against overlapping bench runs

  // Resolves to the loaded profile, null when none exists yet, or undefined on
  // a read error — the startup effect needs "missing" and "unreadable" distinct.
  const refresh = useCallback(async (): Promise<MachineProfile | null | undefined> => {
    if (!isTauri()) return undefined;
    try {
      const p = await invoke<MachineProfile | null>("machine_profile_get");
      setProfile(p ?? null);
      return p ?? null;
    } catch (e) {
      setError(String(e));
      return undefined;
    }
  }, []);

  const runBench = useCallback(
    async (enginePath?: string) => {
      if (!isTauri() || benchingRef.current) return;
      benchingRef.current = true;
      setBenching(true);
      setError(null);
      try {
        await invoke<BenchResult>("machine_bench", { enginePath: enginePath ?? null });
        await refresh(); // machine_bench persisted the profile — reload it
        setHwChanged(false); // fresh profile carries this machine's fingerprint
        window.dispatchEvent(new Event(PROFILE_UPDATED_EVENT));
      } catch (e) {
        setError(String(e));
      } finally {
        benchingRef.current = false;
        setBenching(false);
      }
    },
    [refresh],
  );

  // Startup: load the profile, then auto-bench if this install has none yet
  // (first start) or the profile was measured on different hardware.
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    (async () => {
      const p = await refresh();
      let changed = false;
      if (p && p.hw_fingerprint) {
        try {
          const current = await invoke<string>("machine_fingerprint");
          changed = current !== "" && p.hw_fingerprint !== current;
        } catch {
          // fingerprint unavailable — assume unchanged rather than re-bench blind
        }
        if (!cancelled) setHwChanged(changed);
      }
      if (cancelled || autoBenchAttempted) return;
      // Only a definite "no profile" (null, not an undefined read error)
      // triggers the first-start bench; an error must not overwrite a possibly
      // valid file.
      if (p === null || changed) {
        autoBenchAttempted = true;
        runBench(storedEnginePath());
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh, runBench]);

  // Follow benches performed by other instances of this hook.
  useEffect(() => {
    if (!isTauri()) return;
    const onUpdated = () => {
      refresh();
      setHwChanged(false);
    };
    window.addEventListener(PROFILE_UPDATED_EVENT, onUpdated);
    return () => window.removeEventListener(PROFILE_UPDATED_EVENT, onUpdated);
  }, [refresh]);

  return { profile, benching, error, hwChanged, runBench };
}
