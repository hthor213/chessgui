import { describe, it, expect } from "vitest"
import {
  reviewIndex,
  reviewBack,
  reviewForward,
  type ReviewCursor,
} from "@chessgui/ui/use-ply-review"

// Shared ply-review reducer (spec 218, use-ply-review). The three call-site
// shapes it must reproduce exactly:
// - LiveGameView (app/page.tsx): frames indexed 0..tip, forward onto the tip
//   resumes following (null).
// - Spar review (spar-tab.tsx): min = -1 ("before the first ply"), empty
//   games never enter review mode.
// - Arena exhibition screen: resumeAtTip = false — forward parks AT the tip
//   and only the explicit Live button (toTip) resumes following.

describe("reviewIndex", () => {
  it("resolves following (null) to the tip", () => {
    expect(reviewIndex(null, 7)).toBe(7)
  })

  it("passes a concrete cursor through", () => {
    expect(reviewIndex(3, 7)).toBe(3)
  })

  it("clamps a stale cursor above the tip down to the tip", () => {
    expect(reviewIndex(9, 7)).toBe(7)
  })

  it("clamps below min (spar's -1 floor)", () => {
    expect(reviewIndex(-5, 7, -1)).toBe(-1)
  })

  it("never returns below min even for an empty game", () => {
    expect(reviewIndex(null, -1, 0)).toBe(0)
  })
})

describe("reviewBack", () => {
  it("steps off the live tip into review", () => {
    expect(reviewBack(null, 5)).toBe(4)
  })

  it("steps a review cursor toward the start", () => {
    expect(reviewBack(3, 5)).toBe(2)
  })

  it("clamps at min", () => {
    expect(reviewBack(0, 5)).toBe(0)
    expect(reviewBack(-1, 5, -1)).toBe(-1)
  })

  it("spar shape: live with plies lands one before the last ply", () => {
    // 4 plies → tip = 3; back from live reviews plies[2].
    expect(reviewBack(null, 3, -1)).toBe(2)
  })

  it("no-ops while there is nothing behind the tip (empty game stays live)", () => {
    expect(reviewBack(null, -1, -1)).toBe(null) // spar, plies.length === 0
    expect(reviewBack(null, 0, -1)).toBe(-1) // spar, one ply → the start
    expect(reviewBack(null, -1, 0)).toBe(null) // LiveGameView, no frames
  })
})

describe("reviewForward", () => {
  it("steps a review cursor toward the tip", () => {
    expect(reviewForward(1, 5)).toBe(2)
  })

  it("resumes following when it reaches the tip", () => {
    expect(reviewForward(4, 5)).toBe(null)
  })

  it("stays following at the tip", () => {
    expect(reviewForward(null, 5)).toBe(null)
  })

  it("spar shape: forward from the start position", () => {
    expect(reviewForward(-1, 3, -1)).toBe(0)
  })

  it("no-ops on an empty game", () => {
    expect(reviewForward(null, -1, -1)).toBe(null)
    expect(reviewForward(null, -1, 0)).toBe(null)
  })

  it("exhibition shape (resumeAtTip=false): parks AT the tip, not following", () => {
    expect(reviewForward(4, 5, 0, false)).toBe(5)
    // Parked at the tip it stays parked — new moves must not drag the view.
    expect(reviewForward(5, 5, 0, false)).toBe(5)
  })
})

describe("round trips", () => {
  it("back then forward from live returns to following", () => {
    let c: ReviewCursor = null
    c = reviewBack(c, 5)
    expect(c).toBe(4)
    c = reviewForward(c, 5)
    expect(c).toBe(null)
  })

  it("walks to the start and back to live (spar shape)", () => {
    const tip = 2 // 3 plies
    let c: ReviewCursor = null
    for (let i = 0; i < 10; i++) c = reviewBack(c, tip, -1)
    expect(c).toBe(-1)
    c = reviewForward(c, tip, -1) // → after plies[0]
    expect(c).toBe(0)
    c = reviewForward(c, tip, -1) // → after plies[1]
    expect(c).toBe(1)
    c = reviewForward(c, tip, -1) // reaches the tip → live
    expect(c).toBe(null)
  })
})
