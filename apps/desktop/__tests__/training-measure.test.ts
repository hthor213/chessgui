import { describe, it, expect } from "vitest"
import {
  mergeMetricPoints,
  monthLabel,
  parseMeasurementJson,
  sparScorePoint,
} from "@/lib/training-measure"
import type { MetricPoint } from "@/lib/training-program"
import type { SparResultEntry } from "@/lib/spar-results"

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
