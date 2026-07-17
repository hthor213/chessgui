import { describe, it, expect } from "vitest"
import {
  ROAD_TO_1900,
  METRIC_KEYS,
  METRIC_META,
  DEFAULT_METRICS,
  MILESTONE_MAIA_TARGET,
  currentWeek,
  chapterForWeek,
  blocksForDay,
  latestMetric,
  appendMetric,
  gaugeFor,
  formatCriterion,
  evaluateCriterion,
  daysRemaining,
  gapToTarget,
  type MetricPoint,
} from "@/lib/training-program"

const DAY_MS = 24 * 60 * 60 * 1000

describe("Road to 1900 program data is well-formed", () => {
  const chapters = ROAD_TO_1900.chapters

  it("has chapters with valid, contiguous, increasing windows", () => {
    expect(chapters.length).toBeGreaterThanOrEqual(3)
    expect(chapters[0].weekStart).toBe(1)
    for (let i = 0; i < chapters.length; i++) {
      const ch = chapters[i]
      expect(ch.weekStart).toBeLessThanOrEqual(ch.weekEnd)
      if (i > 0) expect(ch.weekStart).toBe(chapters[i - 1].weekEnd + 1)
    }
  })

  it("gives every chapter objectives, a full 7-day template, and measured exit criteria", () => {
    for (const ch of chapters) {
      expect(ch.objectives.length).toBeGreaterThan(0)
      expect(ch.exitCriteria.length).toBeGreaterThan(0)
      // Exactly one block per weekday 0..6.
      const days = ch.week.map((b) => b.day).sort((a, b) => a - b)
      expect(days).toEqual([0, 1, 2, 3, 4, 5, 6])
      for (const b of ch.week) {
        expect(b.title.trim()).not.toBe("")
        expect(b.detail.trim()).not.toBe("")
      }
    }
  })

  it("references only known metrics in exit criteria, all parseable", () => {
    for (const ch of chapters) {
      for (const c of ch.exitCriteria) {
        expect(METRIC_KEYS).toContain(c.metric)
        expect([">=", "<=", ">", "<"]).toContain(c.cmp)
        expect(Number.isFinite(c.target)).toBe(true)
        // formatCriterion produces a non-empty human string with the label.
        expect(formatCriterion(c)).toContain(METRIC_META[c.metric].label)
      }
    }
  })

  it("uses unique block ids across the whole program", () => {
    const ids = chapters.flatMap((ch) => ch.week.map((b) => b.id))
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("only launches exercise types that have a feature; the rest are check-off-only", () => {
    // Tier 0: calibration_session and spar_rival launch; Tier 1 adds
    // endgame_playout (spec 211 play-it-out) and rake_deck (spec 211
    // avoidance solver); others are check-off.
    const launchable = new Set([
      "calibration_session",
      "spar_rival",
      "endgame_playout",
      "rake_deck",
    ])
    for (const ch of chapters) {
      for (const b of ch.week) {
        expect([
          "calibration_session",
          "spar_rival",
          "endgame_playout",
          "rake_deck",
          "long_game_review",
          "rest",
          "other",
        ]).toContain(b.type)
      }
      // At least one launchable block exists somewhere so the wiring is exercised.
      expect(ch.week.some((b) => launchable.has(b.type))).toBe(true)
    }
  })
})

describe("today-template day mapping", () => {
  const ch1 = ROAD_TO_1900.chapters[0]

  it("returns the block for a given JS weekday", () => {
    // Wednesday (3) is a calibration session in chapter 1.
    const wed = blocksForDay(ch1, 3)
    expect(wed).toHaveLength(1)
    expect(wed[0].type).toBe("calibration_session")

    // Friday (5) is sparring; Sunday (0) is rest.
    expect(blocksForDay(ch1, 5)[0].type).toBe("spar_rival")
    expect(blocksForDay(ch1, 0)[0].type).toBe("rest")
  })

  it("covers all seven weekdays with no gaps", () => {
    for (let d = 0; d < 7; d++) {
      expect(blocksForDay(ch1, d).length).toBeGreaterThan(0)
    }
  })
})

describe("timeline: week + chapter selection", () => {
  it("counts 1-based weeks from the start date", () => {
    const start = "2026-07-14"
    const t0 = Date.parse(start)
    expect(currentWeek(start, t0)).toBe(1)
    expect(currentWeek(start, t0 + 6 * DAY_MS)).toBe(1)
    expect(currentWeek(start, t0 + 14 * DAY_MS)).toBe(3)
    // A start date in the future still floors at week 1.
    expect(currentWeek(start, t0 - 30 * DAY_MS)).toBe(1)
  })

  it("maps a week to its containing chapter, clamping past the end", () => {
    const p = ROAD_TO_1900
    expect(chapterForWeek(p, 1).id).toBe(p.chapters[0].id)
    expect(chapterForWeek(p, 8).id).toBe(p.chapters[1].id)
    expect(chapterForWeek(p, 23).id).toBe(p.chapters[2].id)
    // Beyond the last window clamps to the final chapter (no fall-off).
    expect(chapterForWeek(p, 999).id).toBe(p.chapters[2].id)
    // Before the first window clamps to the first chapter.
    expect(chapterForWeek(p, 0).id).toBe(p.chapters[0].id)
  })
})

describe("metrics append + read", () => {
  it("seeds the baseline row for the three measured metrics only", () => {
    expect(latestMetric(DEFAULT_METRICS, "maia_rapid")?.value).toBe(1200)
    expect(latestMetric(DEFAULT_METRICS, "eg_conversion")?.value).toBe(0.42)
    expect(latestMetric(DEFAULT_METRICS, "flag_net")?.value).toBe(-85)
    // The unmeasured metrics have no baseline point.
    expect(latestMetric(DEFAULT_METRICS, "calib_mae_level")).toBeNull()
    expect(latestMetric(DEFAULT_METRICS, "spar_score")).toBeNull()
    // Baseline points are labelled honestly.
    expect(latestMetric(DEFAULT_METRICS, "maia_rapid")?.note).toContain("baseline")
  })

  it("appends without mutating and reads back the newest point", () => {
    const before = DEFAULT_METRICS
    const point: MetricPoint = { at: "2026-09", metric: "maia_rapid", value: 1360 }
    const after = appendMetric(before, point)
    // Append-only: original untouched, new array longer, newest wins on read.
    expect(before).toHaveLength(3)
    expect(after).toHaveLength(4)
    expect(latestMetric(after, "maia_rapid")?.value).toBe(1360)
    // An unrelated metric is unaffected.
    expect(latestMetric(after, "eg_conversion")?.value).toBe(0.42)
  })
})

describe("gauge state logic", () => {
  const maiaCriterion = ROAD_TO_1900.chapters[0].exitCriteria.find((c) => c.metric === "maia_rapid")!
  const calibCriterion = ROAD_TO_1900.chapters[0].exitCriteria.find((c) => c.metric === "calib_mae_level")!

  it("is unmeasured when there is no value", () => {
    const g = gaugeFor(calibCriterion, null)
    expect(g.state).toBe("unmeasured")
    expect(g.value).toBeNull()
    expect(g.progress).toBe(0)
  })

  it("is met when a higher-is-better value clears the target", () => {
    const g = gaugeFor(maiaCriterion, 1400)
    expect(g.state).toBe("met")
    expect(g.progress).toBe(1)
  })

  it("is unmet with partial progress when below a higher-is-better target", () => {
    const g = gaugeFor(maiaCriterion, 1200)
    expect(g.state).toBe("unmet")
    expect(g.progress).toBeGreaterThan(0)
    expect(g.progress).toBeLessThan(1)
  })

  it("handles lower-is-better targets (calibration error)", () => {
    // target < 0.7: 0.5 meets it, 1.0 does not.
    expect(gaugeFor(calibCriterion, 0.5).state).toBe("met")
    const miss = gaugeFor(calibCriterion, 1.0)
    expect(miss.state).toBe("unmet")
    // Closer to the target reads as fuller: 0.7/1.0 = 0.7.
    expect(miss.progress).toBeCloseTo(0.7, 5)
  })

  it("evaluateCriterion honours each comparator", () => {
    expect(evaluateCriterion({ metric: "maia_rapid", cmp: ">=", target: 1350 }, 1350)).toBe(true)
    expect(evaluateCriterion({ metric: "maia_rapid", cmp: ">", target: 1350 }, 1350)).toBe(false)
    expect(evaluateCriterion({ metric: "calib_mae_level", cmp: "<", target: 0.7 }, 0.7)).toBe(false)
    expect(evaluateCriterion({ metric: "flag_net", cmp: ">=", target: -30 }, -30)).toBe(true)
  })
})

describe("milestone math", () => {
  it("counts whole days to the milestone, null without a date", () => {
    const now = Date.parse("2026-07-14T12:00:00Z")
    expect(daysRemaining(null, now)).toBeNull()
    expect(daysRemaining("2026-07-24", now)).toBe(10)
    // A past date goes negative.
    expect(daysRemaining("2026-07-04", now)).toBeLessThan(0)
  })

  it("computes the gap to the Maia target, null when unmeasured", () => {
    expect(gapToTarget(1200)).toBe(MILESTONE_MAIA_TARGET - 1200)
    expect(gapToTarget(1500)).toBe(0)
    expect(gapToTarget(null)).toBeNull()
  })
})

describe("training profiles (spec 225 scoping)", () => {
  it("default profile keeps the original bare keys — pre-profile data migrates for free", async () => {
    const { profileScopedKey, DEFAULT_PROFILE_ID, STORAGE_KEYS } = await import("@/lib/training-program")
    expect(profileScopedKey(STORAGE_KEYS.overlay, DEFAULT_PROFILE_ID)).toBe(STORAGE_KEYS.overlay)
    expect(profileScopedKey(STORAGE_KEYS.metrics, "dad")).toBe(`${STORAGE_KEYS.metrics}:dad`)
  })

  it("derives stable ids from display names, including non-ascii", async () => {
    const { profileIdFromName } = await import("@/lib/training-program")
    expect(profileIdFromName("Dad")).toBe("dad")
    expect(profileIdFromName("Dad")).toBe(profileIdFromName("  dad "))
    expect(profileIdFromName("Þórarinn Hjaltason")).not.toBe("")
    expect(profileIdFromName("!!!")).toBe("person")
  })

  it("starts with one default profile, active", async () => {
    const { defaultProfilesState, DEFAULT_PROFILE_ID } = await import("@/lib/training-program")
    const s = defaultProfilesState()
    expect(s.profiles).toHaveLength(1)
    expect(s.activeId).toBe(DEFAULT_PROFILE_ID)
    expect(s.profiles[0].id).toBe(DEFAULT_PROFILE_ID)
  })
})
