"use client"

// "Add player profile…" (spec 225 Part 1, desktop UI step): name + identifier
// fields + PGN files in, the profile pipeline run in place with streamed
// output, and an HONEST verdict screen out — games found, the stored sample
// verdict (full / LOW-CONFIDENCE / DOSSIER-ONLY, with the pipeline's own
// reasons), and which artifacts were built. Lives where the roster lives
// (Play vs Bot), reached from the roster screen.
//
// Desktop dev-checkout capability, like the Training tab's monthly run: the
// pipeline spawns scripts/persona/build_player_profile.py, so shells without
// a native process host show the honest terminal-run hint instead.

import { useCallback, useEffect, useRef, useState } from "react"
import { Button } from "@chessgui/ui/ui/button"
import { Input } from "@chessgui/ui/ui/input"
import { getProviders } from "@/lib/platform"
import { appendLogLine } from "@/lib/training-measure"
import {
  artifactRows,
  canRunProfile,
  parseProfileJson,
  profileRunMessage,
  type PlayerProfileFile,
  type ProfileRunRequest,
} from "@/lib/player-profile"

interface AddProfileScreenProps {
  onBack: () => void
  /** Called after a successful run so the parent reloads personas+profiles
   *  (the new card appears through the same artifact-existence gate). */
  onCreated: () => void
}

/** Badge chip classes per stored verdict (the same three levels the roster
 *  cards render — one honesty, many surfaces). */
export function verdictChipClass(verdict: string): string {
  switch (verdict) {
    case "full":
      return "border-emerald-400/40 bg-emerald-400/10 text-emerald-300"
    case "low-confidence":
      return "border-amber-400/40 bg-amber-400/10 text-amber-300"
    default: // dossier-only
      return "border-sky-400/40 bg-sky-400/10 text-sky-300"
  }
}

export function AddProfileScreen({ onBack, onCreated }: AddProfileScreenProps) {
  const [name, setName] = useState("")
  const [fideId, setFideId] = useState("")
  const [chesscom, setChesscom] = useState("")
  const [lichess, setLichess] = useState("")
  const [pgns, setPgns] = useState<string[]>([])
  const [running, setRunning] = useState(false)
  const [log, setLog] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<PlayerProfileFile | null>(null)
  // Spawn capability, read on the client so the static render stays stable
  // (the training tab's canSpawnMeasure pattern).
  const [canSpawn, setCanSpawn] = useState(false)
  useEffect(() => setCanSpawn(getProviders().engine.hasNativeEngine), [])

  const logRef = useRef<HTMLPreElement>(null)
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [log])

  const req: ProfileRunRequest = {
    name,
    ...(fideId.trim() ? { fideId: fideId.trim() } : {}),
    ...(chesscom.trim() ? { chesscom: chesscom.trim() } : {}),
    ...(lichess.trim() ? { lichess: lichess.trim() } : {}),
    ...(pgns.length ? { pgns } : {}),
  }
  const canRun = canSpawn && canRunProfile(req) && !running

  const addPgn = useCallback(() => {
    getProviders()
      .dialog.pickFile({ title: "Add PGN file", filters: [{ name: "PGN", extensions: ["pgn"] }] })
      .then((path) => {
        if (path) setPgns((prev) => (prev.includes(path) ? prev : [...prev, path]))
      })
      .catch(() => {
        /* no native picker — the field group explains the desktop requirement */
      })
  }, [])

  const run = useCallback(() => {
    if (!canRun) return
    setRunning(true)
    setError(null)
    setResult(null)
    setLog([])
    getProviders()
      .engine.playerProfileRun(req, (l) => setLog((prev) => appendLogLine(prev, l.line)))
      .then((report) => {
        const msg = profileRunMessage(report)
        if (msg) {
          setError(msg)
          return
        }
        try {
          setResult(parseProfileJson(report.profile_json ?? ""))
          onCreated()
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e))
        }
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setRunning(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canRun, name, fideId, chesscom, lichess, pgns, onCreated])

  const cancel = useCallback(() => {
    getProviders()
      .engine.playerProfileCancel()
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [])

  return (
    <div className="flex-1 min-h-0 overflow-auto p-6" data-testid="add-profile">
      <div className="max-w-xl mx-auto space-y-5">
        <div>
          <button
            onClick={onBack}
            className="text-xs text-muted-foreground hover:text-foreground"
            data-testid="add-profile-back"
          >
            ‹ Roster
          </button>
          <h1 className="text-2xl font-bold mt-1">Add player profile</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            A name plus any game source builds the full local profile — corpus, stats dossier,
            opening book, and (only when the sample honestly suffices) a playable persona. Profiles
            of private individuals stay on this machine, never bundled or committed.
          </p>
        </div>

        {!canSpawn && (
          <p className="text-xs text-muted-foreground" data-testid="add-profile-nospawn">
            Building profiles needs the desktop app — run{" "}
            <code className="font-mono">scripts/persona/build_player_profile.py</code> in a terminal
            instead; the roster picks the artifacts up on next load.
          </p>
        )}

        <div className="grid sm:grid-cols-2 gap-3">
          <label className="space-y-1 text-xs text-muted-foreground">
            <span>Player name (required)</span>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Arnþór Einarsson"
              disabled={running}
              data-testid="add-profile-name"
            />
          </label>
          <label className="space-y-1 text-xs text-muted-foreground">
            <span>FIDE ID (identity only — no games)</span>
            <Input
              value={fideId}
              onChange={(e) => setFideId(e.target.value)}
              placeholder="e.g. 2300540"
              disabled={running}
              data-testid="add-profile-fide"
            />
          </label>
          <label className="space-y-1 text-xs text-muted-foreground">
            <span>chess.com username</span>
            <Input
              value={chesscom}
              onChange={(e) => setChesscom(e.target.value)}
              disabled={running}
              data-testid="add-profile-chesscom"
            />
          </label>
          <label className="space-y-1 text-xs text-muted-foreground">
            <span>lichess username</span>
            <Input
              value={lichess}
              onChange={(e) => setLichess(e.target.value)}
              disabled={running}
              data-testid="add-profile-lichess"
            />
          </label>
        </div>

        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">PGN files (the OTB import path):</span>
            <Button size="sm" variant="outline" onClick={addPgn} disabled={running} data-testid="add-profile-pgn-add">
              Add PGN…
            </Button>
          </div>
          {pgns.map((p) => (
            <div key={p} className="flex items-center gap-2 text-xs font-mono text-muted-foreground">
              <span className="truncate">{p}</span>
              <button
                className="text-red-400/80 hover:text-red-300"
                onClick={() => setPgns((prev) => prev.filter((x) => x !== p))}
                disabled={running}
                title="Remove"
              >
                ✕
              </button>
            </div>
          ))}
        </div>

        <div className="flex items-center gap-2">
          {running ? (
            <Button size="sm" variant="outline" onClick={cancel} data-testid="add-profile-cancel">
              Cancel build
            </Button>
          ) : (
            <Button size="sm" disabled={!canRun} onClick={run} data-testid="add-profile-run">
              Build profile
            </Button>
          )}
          {!running && !canRunProfile(req) && (
            <span className="text-[11px] text-muted-foreground">
              Needs a name plus at least one game source (chess.com, lichess, or PGN).
            </span>
          )}
          {running && (
            <span className="text-xs text-muted-foreground" data-testid="add-profile-running">
              <span className="inline-block h-2 w-2 rounded-full bg-emerald-400 animate-pulse mr-1.5 align-middle" />
              Building — fetch, merge, stats, book, verdict…
            </span>
          )}
        </div>

        {(running || log.length > 0) && (
          <pre
            ref={logRef}
            data-testid="add-profile-log"
            className="max-h-40 overflow-auto rounded bg-black/40 p-2 text-[10px] leading-4 font-mono text-muted-foreground whitespace-pre-wrap"
          >
            {log.join("\n")}
          </pre>
        )}

        {error && (
          <p className="text-sm text-red-400" data-testid="add-profile-error">
            {error}
          </p>
        )}

        {result && (
          <div
            className="rounded-lg border border-white/10 bg-white/[0.03] p-4 space-y-2"
            data-testid="add-profile-verdict"
          >
            <div className="flex items-center gap-2">
              <span className="font-medium">{result.display_name}</span>
              <span
                className={`inline-block px-2 py-0.5 rounded-md text-[11px] font-medium border ${verdictChipClass(result.sample.verdict)}`}
                data-testid="add-profile-verdict-badge"
              >
                {result.sample.verdict === "full" ? "FULL PROFILE" : result.sample.badge}
              </span>
            </div>
            <p className="text-sm text-muted-foreground">
              {result.sample.games} game{result.sample.games === 1 ? "" : "s"} found (
              {result.sample.verified_games} verified
              {result.sample.unverified_games ? `, ${result.sample.unverified_games} unverified` : ""}
              ).{" "}
              {result.sample.verdict === "full"
                ? "Sample clears the persona floor — book, dossier, and persona config built."
                : result.sample.verdict === "low-confidence"
                  ? "Persona built, but below the ~30-game floor — it carries a LOW-CONFIDENCE badge everywhere it appears."
                  : "Below the persona minimum — dossier and book only; this profile fields no bot."}
            </p>
            {result.sample.reasons.length > 0 && (
              <ul className="text-xs text-muted-foreground list-disc list-inside space-y-0.5" data-testid="add-profile-reasons">
                {result.sample.reasons.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            )}
            <div className="text-xs text-muted-foreground">
              <div className="font-semibold mb-1">Artifacts built</div>
              {artifactRows(result).map((r) => (
                <div key={r.label} className="flex gap-2">
                  <span className="w-28 shrink-0">{r.label}</span>
                  <code className="font-mono truncate">{r.path}</code>
                </div>
              ))}
            </div>
            <Button size="sm" onClick={onBack} data-testid="add-profile-done">
              Back to roster
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
