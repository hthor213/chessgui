import { describe, it, expect } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

import { TrainingTab } from "@chessgui/ui/training-tab"

// Effects don't run under renderToStaticMarkup, so localStorage is never touched
// and the component shows its initial state: program not started (Today), metrics
// seeded to the baseline (Program gauges), no overlay (milestone setup form).
const noop = () => {}

describe("TrainingTab renders headless", () => {
  it("renders both sub-views with all main testids present", () => {
    const html = renderToStaticMarkup(createElement(TrainingTab, { onLaunch: noop }))
    // The four regions the spec names.
    expect(html).toContain('data-testid="training-today"')
    expect(html).toContain('data-testid="training-program"')
    expect(html).toContain('data-testid="training-metrics"')
    expect(html).toContain('data-testid="training-milestone"')
    // Sub-nav.
    expect(html).toContain('data-testid="training-sub-today"')
    expect(html).toContain('data-testid="training-sub-program"')
  })

  it("shows the start-program prompt and generic rival wording before starting", () => {
    const html = renderToStaticMarkup(createElement(TrainingTab, { onLaunch: noop }))
    expect(html).toContain('data-testid="training-start"')
    // Rival-agnostic: never a private name/place in the bundled UI.
    expect(html).toContain("your rival")
    expect(html).not.toMatch(/florida/i)
    expect(html).not.toMatch(/\bdad\b/i)
  })

  it("shows the milestone setup form when no overlay is present", () => {
    const html = renderToStaticMarkup(createElement(TrainingTab, { onLaunch: noop }))
    expect(html).toContain('data-testid="training-milestone-form"')
    expect(html).toContain('data-testid="training-milestone-name"')
    expect(html).toContain('data-testid="training-milestone-date"')
  })

  it("renders the program chapters and exit-criteria gauges", () => {
    const html = renderToStaticMarkup(createElement(TrainingTab, { onLaunch: noop }))
    expect(html).toContain("Road to 1900")
    expect(html).toContain("Stop the Bleeding")
    expect(html).toContain("Conversion")
    expect(html).toContain("Rival Taper")
    // A gauge per criterion metric, and the baseline latest-value tiles.
    expect(html).toContain('data-testid="training-gauge-maia_rapid"')
    expect(html).toContain('data-testid="training-latest-maia_rapid"')
    // Unmeasured metric shows the honest state.
    expect(html).toContain("not yet measured")
  })

  it("renders the manual metrics-entry controls", () => {
    const html = renderToStaticMarkup(createElement(TrainingTab, { onLaunch: noop }))
    expect(html).toContain('data-testid="training-metric-select"')
    expect(html).toContain('data-testid="training-metric-value"')
    expect(html).toContain('data-testid="training-metric-add"')
  })

  it("renders the measurement refresh controls (spec 215 Tier 2)", () => {
    const html = renderToStaticMarkup(createElement(TrainingTab, { onLaunch: noop }))
    expect(html).toContain('data-testid="training-refresh-spar"')
    expect(html).toContain('data-testid="training-import-file"')
  })

  it("renders the trajectory card with the projection labeled honestly", () => {
    const html = renderToStaticMarkup(createElement(TrainingTab, { onLaunch: noop }))
    expect(html).toContain('data-testid="training-trajectory"')
    // One baseline point only -> no line is drawn; the status says why.
    expect(html).toContain('data-testid="training-projection-status"')
    expect(html).toContain("at least two dated measurements")
    // The word "projection" is present as a label, never "forecast"/"guaranteed".
    expect(html.toLowerCase()).toContain("projection")
    expect(html.toLowerCase()).not.toContain("guaranteed")
  })

  it("renders the spar-games section with the flag-don't-drop rule stated", () => {
    const html = renderToStaticMarkup(createElement(TrainingTab, { onLaunch: noop }))
    expect(html).toContain('data-testid="training-spar-games"')
    expect(html).toContain('data-testid="training-spar-score"')
    expect(html).toContain("never silently dropped")
    // Empty store under SSR — the honest empty states.
    expect(html).toContain("No games recorded yet")
  })
})
