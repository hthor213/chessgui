// Spec 900 tablebase surfacing — display half. Static-render tests per the
// spar-render precedent: TablebaseSection is presentational, so the gating
// outcomes (out of range, offline, spec 219 lockout) all arrive here as
// `probe: null` and must render nothing at all.

import { describe, it, expect } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { TablebaseSection } from "@chessgui/ui/tablebase-section"
import type { TbProbe } from "@chessgui/core/tablebase"

function render(probe: TbProbe | null, turn: "white" | "black" = "white") {
  return renderToStaticMarkup(createElement(TablebaseSection, { probe, turn }))
}

function probe(overrides: Partial<TbProbe> = {}): TbProbe {
  return {
    category: "win",
    dtz: 12,
    dtm: null,
    moves: [{ uci: "h1h8", san: "Qh8+", category: "loss", dtz: -11 }],
    ...overrides,
  }
}

describe("TablebaseSection", () => {
  it("renders nothing without a probe (gated-off, out-of-range, offline)", () => {
    expect(render(null)).toBe("")
  })

  it("shows a white-oriented verdict, DTZ, and the best move", () => {
    const html = render(probe())
    expect(html).toContain("TB White wins")
    expect(html).toContain("DTZ 12")
    expect(html).toContain("Qh8+")
    expect(html).not.toContain("DTM") // null field stays hidden
  })

  it("orients a side-to-move win to the right color", () => {
    expect(render(probe(), "black")).toContain("TB Black wins")
    expect(render(probe({ category: "loss" }), "black")).toContain("TB White wins")
  })

  it("labels cursed wins as 50-move draws", () => {
    expect(render(probe({ category: "cursed-win", dtz: 140 }))).toContain(
      "Draw (50-move rule)",
    )
  })

  it("omits the best-move readout when the move list is empty", () => {
    const html = render(probe({ moves: [] }))
    expect(html).toContain("TB White wins")
    expect(html).not.toContain("best")
  })
})
