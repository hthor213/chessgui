import { describe, it, expect } from "vitest"
import {
  appendLogLine,
  egConversionPoint,
  measureRunMessage,
  mergeMetricPoints,
  monthLabel,
  parseMeasurementJson,
  sparScorePoint,
  stageForLine,
} from "@/lib/training-measure"
import type { MetricPoint } from "@/lib/training-program"
import type { SparResultEntry } from "@/lib/spar-results"
import { buildPlayoutResult, type PlayoutResultEntry } from "@/lib/playout"

describe("parseMeasurementJson", () => {
  it("accepts the script's { points } shape and bare arrays", () => {
    const point = { at: "2026-07", metric: "flag_net", value: -85, note: "n" }
    expect(parseMeasurementJson(JSON.stringify({ generated_at: "x", points: [point] }))).toEqual([point])
    expect(parseMeasurementJson(JSON.stringify([point]))).toHaveLength(1)
  })

  it("rejects malformed input loudly, never silently", () => {
    expect(() => parseMeasurementJson("not json")).toThrow(/valid JSON/)
    expect(() => parseMeasurementJson("{}")).toThrow(/points/)
    expect(() => parseMeasurementJson("[]")).toThrow(/no metric points/)
    expect(() =>
      parseMeasurementJson(JSON.stringify([{ at: "2026-07", metric: "nope", value: 1 }])),
    ).toThrow(/malformed/)
    expect(() =>
      parseMeasurementJson(JSON.stringify([{ at: "july", metric: "flag_net", value: 1 }])),
    ).toThrow(/malformed/)
    expect(() =>
      parseMeasurementJson(JSON.stringify([{ at: "2026-07", metric: "flag_net", value: "x" }])),
    ).toThrow(/malformed/)
  })
})

describe("mergeMetricPoints", () => {
  const existing: MetricPoint[] = [
    { at: "2026-07", metric: "maia_rapid", value: 1200, note: "baseline" },
    { at: "2026-07", metric: "flag_net", value: -85 },
  ]

  it("adds new (at, metric) keys", () => {
    const res = mergeMetricPoints(existing, [{ at: "2026-08", metric: "maia_rapid", value: 1250 }])
    expect(res.added).toBe(1)
    expect(res.merged).toHaveLength(3)
  })

  it("replaces a changed value and re-appends so latest-of-metric reads it", () => {
    const res = mergeMetricPoints(existing, [{ at: "2026-07", metric: "maia_rapid", value: 1210 }])
    expect(res.replaced).toBe(1)
    expect(res.merged).toHaveLength(2)
    expect(res.merged[res.merged.length - 1].value).toBe(1210)
  })

  it("re-importing the same file is a no-op", () => {
    const res = mergeMetricPoints(existing, existing)
    expect(res.unchanged).toBe(2)
    expect(res.added + res.replaced).toBe(0)
    expect(res.merged).toEqual(existing)
  })
})

describe("sparScorePoint", () => {
  const NOW = Date.parse("2026-07-15T12:00:00Z")
  const game = (over: Partial<SparResultEntry>): SparResultEntry => ({
    id: "x",
    at: "2026-07-10T10:00:00Z",
    opponent: "Rival",
    level: 1700,
    mode: "serious",
    userColor: "white",
    result: "win",
    resultLabel: "Checkmate — White wins",
    plies: 50,
    countsTowardTraining: true,
    anomalyFlags: [],
    ...over,
  })

  it("emits this month's point with a provenance note", () => {
    const p = sparScorePoint([game({}), game({ result: "loss", anomalyFlags: ["short_game"] })], NOW)!
    expect(p.metric).toBe("spar_score")
    expect(p.at).toBe(monthLabel(new Date(NOW)))
    expect(p.value).toBeCloseTo(0.5)
    expect(p.note).toContain("2 spar games")
    expect(p.note).toContain("1 flagged")
  })

  it("returns null with nothing to measure (no fake zeros)", () => {
    expect(sparScorePoint([], NOW)).toBeNull()
    expect(sparScorePoint([game({ mode: "probe", countsTowardTraining: false })], NOW)).toBeNull()
  })
})

describe("egConversionPoint", () => {
  const NOW = Date.parse("2026-07-15T12:00:00Z")
  const playout = (over: Partial<PlayoutResultEntry>): PlayoutResultEntry => ({
    ...buildPlayoutResult({
      source: "training",
      fen: "8/8/4k3/8/4K3/8/3R4/8 w - - 0 1",
      evalPawns: 2.1, // win claim
      userSide: "white",
      level: 1700,
      mode: "serious",
      plies: 40,
      resultLabel: "Checkmate — White wins",
      at: "2026-07-10T10:00:00Z",
    })!,
    ...over,
  })

  it("emits this month's point with in-app provenance in the note", () => {
    const p = egConversionPoint(
      [playout({}), playout({ verdict: "dropped", anomalyFlags: ["short_game"] })],
      NOW,
    )!
    expect(p.metric).toBe("eg_conversion")
    expect(p.at).toBe(monthLabel(new Date(NOW)))
    expect(p.value).toBeCloseTo(0.5)
    expect(p.note).toContain("2 in-app playouts")
    expect(p.note).toContain("1 flagged")
  })

  it("returns null with nothing to measure (no fake zeros)", () => {
    expect(egConversionPoint([], NOW)).toBeNull()
    expect(egConversionPoint([playout({ mode: "probe", countsTowardTraining: false })], NOW)).toBeNull()
    // Hold-claim playouts never feed the conversion rate.
    expect(egConversionPoint([playout({ claim: "draw" })], NOW)).toBeNull()
  })
})

describe("in-app pipeline run helpers (spec 215 Tier 2 spawn)", () => {
  it("stageForLine maps the script's stage announcements, ignores plain output", () => {
    expect(stageForLine("$ /usr/bin/python3 scripts/fetch_chesscom.py me -o out.pgn")).toMatch(/Fetching/)
    expect(stageForLine("$ python3 scripts/self_report/self_maia.py rapid 1200")).toMatch(/lc0/)
    expect(stageForLine("$ python3 scripts/self_report/self_stats.py rapid")).toMatch(/rating/i)
    expect(stageForLine("downloading maia-1500.pb.gz")).toBeNull()
    expect(stageForLine("$ some_unknown_tool.py")).toBeNull()
  })

  it("appendLogLine keeps only the tail once past the cap", () => {
    let log: string[] = []
    for (let i = 0; i < 5; i++) log = appendLogLine(log, `line ${i}`, 3)
    expect(log).toEqual(["line 2", "line 3", "line 4"])
  })

  it("measureRunMessage: cancelled and failed runs say so, success defers to the import", () => {
    expect(measureRunMessage({ exit_code: null, cancelled: true, metrics_json: null })).toMatch(/cancelled/i)
    expect(measureRunMessage({ exit_code: 3, cancelled: false, metrics_json: null })).toMatch(/exit 3/)
    expect(measureRunMessage({ exit_code: 0, cancelled: false, metrics_json: null })).toMatch(/unreadable/)
    expect(measureRunMessage({ exit_code: 0, cancelled: false, metrics_json: "{}" })).toBeNull()
  })
})
