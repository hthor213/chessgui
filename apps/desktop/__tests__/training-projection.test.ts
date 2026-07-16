import { describe, it, expect } from "vitest"
import {
  expectedScoreElo,
  fitTrend,
  metricTime,
  metricTrendPoints,
  projectMetric,
  valueAt,
  winsPerTen,
} from "@/lib/training-projection"
import type { MetricPoint } from "@/lib/training-program"

const DAY_MS = 24 * 60 * 60 * 1000

describe("metricTime", () => {
  it("resolves monthly labels to the 15th and full dates to the date", () => {
    expect(metricTime("2026-07")).toBe(Date.parse("2026-07-15T00:00:00Z"))
    expect(metricTime("2026-12-19")).toBe(Date.parse("2026-12-19T00:00:00Z"))
  })

  it("rejects garbage", () => {
    expect(metricTime("july")).toBeNull()
    expect(metricTime("2026")).toBeNull()
    expect(metricTime("")).toBeNull()
  })
})

describe("metricTrendPoints", () => {
  const points: MetricPoint[] = [
    { at: "2026-07", metric: "maia_rapid", value: 1200 },
    { at: "2026-08", metric: "maia_rapid", value: 1250 },
    { at: "2026-08", metric: "eg_conversion", value: 0.45 },
    { at: "nonsense", metric: "maia_rapid", value: 9999 },
  ]

  it("filters to the metric, skips unparseable dates, sorts ascending", () => {
    const pts = metricTrendPoints(points, "maia_rapid")
    expect(pts).toHaveLength(2)
    expect(pts[0].v).toBe(1200)
    expect(pts[1].v).toBe(1250)
    expect(pts[0].t).toBeLessThan(pts[1].t)
  })

  it("last value wins for a re-entered month (matches latestMetric)", () => {
    const pts = metricTrendPoints(
      [...points, { at: "2026-08", metric: "maia_rapid", value: 1260 }],
      "maia_rapid",
    )
    expect(pts[1].v).toBe(1260)
  })
})

describe("fitTrend", () => {
  it("recovers an exact line", () => {
    // 2 points/day starting at 1000.
    const pts = [0, 10, 20, 30].map((d) => ({ t: d * DAY_MS, v: 1000 + 2 * d }))
    const trend = fitTrend(pts)!
    expect(trend.slopePerDay).toBeCloseTo(2, 6)
    expect(valueAt(trend, 40 * DAY_MS)).toBeCloseTo(1080, 6)
  })

  it("is numerically stable at real epoch magnitudes", () => {
    const t0 = Date.parse("2026-07-15T00:00:00Z")
    const pts = [0, 31, 61].map((d) => ({ t: t0 + d * DAY_MS, v: 1200 + d }))
    const trend = fitTrend(pts)!
    expect(trend.slopePerDay).toBeCloseTo(1, 4)
    expect(valueAt(trend, t0 + 90 * DAY_MS)).toBeCloseTo(1290, 2)
  })

  it("returns null with < 2 points or a single shared date", () => {
    expect(fitTrend([])).toBeNull()
    expect(fitTrend([{ t: 0, v: 1 }])).toBeNull()
    expect(
      fitTrend([
        { t: 5, v: 1 },
        { t: 5, v: 2 },
      ]),
    ).toBeNull()
  })
})

describe("projectMetric", () => {
  const measured: MetricPoint[] = [
    { at: "2026-07", metric: "maia_rapid", value: 1200 },
    { at: "2026-08", metric: "maia_rapid", value: 1250 },
  ]

  it("projects linearly to the milestone date", () => {
    const p = projectMetric(measured, "maia_rapid", "2026-12-19")
    expect(p.trend).not.toBeNull()
    expect(p.projected).not.toBeNull()
    // ~50 points per 31 days, Jul 15 -> Dec 19 is 157 days: ≈ 1200 + 253.
    expect(p.projected!).toBeGreaterThan(1400)
    expect(p.projected!).toBeLessThan(1500)
  })

  it("is honest about missing prerequisites", () => {
    expect(projectMetric(measured.slice(0, 1), "maia_rapid", "2026-12-19").projected).toBeNull()
    expect(projectMetric(measured, "maia_rapid", null).projected).toBeNull()
    expect(projectMetric(measured, "maia_rapid", "not-a-date").projected).toBeNull()
  })
})

describe("Elo expected score", () => {
  it("is 0.5 at equal strength and symmetric", () => {
    expect(expectedScoreElo(0)).toBeCloseTo(0.5)
    expect(expectedScoreElo(200) + expectedScoreElo(-200)).toBeCloseTo(1)
  })

  it("matches the standard curve at 400 points", () => {
    expect(expectedScoreElo(400)).toBeCloseTo(10 / 11, 4)
  })

  it("winsPerTen scales to one decimal of a 10-game match", () => {
    expect(winsPerTen(1500, 1500)).toBe(5)
    expect(winsPerTen(1300, 1500)).toBeCloseTo(2.4, 1)
  })
})
