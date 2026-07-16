// Spec 219 UI half: the position-editor active-game section (wording +
// conditional metadata fields + no-bypass carry-over), the fair-play notice
// that replaces engine surfaces, and the active-games list. Static-render
// tests per the spar-render precedent (effects don't run, so the panel's
// presentational ActiveGamesList is rendered with records passed in).

import { describe, it, expect } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { GameTree } from "@chessgui/core/game-tree"
import {
  markActiveGameArchived,
  newActiveGameRecord,
  type ActiveGameMeta,
} from "@chessgui/core/active-game"
import {
  ActiveGameSetupSection,
  activeGameMetaFromSetup,
  emptyActiveGameSetup,
} from "@chessgui/ui/active-game-setup"
import { ActiveGameNotice } from "@chessgui/ui/active-game-notice"
import {
  ACTIVE_GAME_DELETE_WARNING,
  ActiveGamesList,
  agoLabel,
  mainlineMoveCount,
} from "@chessgui/ui/active-games-panel"

function meta(overrides: Partial<ActiveGameMeta> = {}): ActiveGameMeta {
  return {
    opponent: "dad",
    chesscomUsername: "hjaltth",
    gameUrl: null,
    flaggedAt: 1_750_000_000_000,
    ...overrides,
  }
}

const ok = async () => ({ ok: true })
const finished = async () => ({ status: "archived" as const })
const noop = () => {}

function renderList(records: Parameters<typeof ActiveGamesList>[0]["records"]) {
  return renderToStaticMarkup(
    createElement(ActiveGamesList, {
      records,
      onResume: noop,
      onFinish: finished,
      onConfirmCandidate: ok,
      onArchivePgn: ok,
      onDelete: noop,
      onRemoveArchived: noop,
    }),
  )
}

describe("ActiveGameSetupSection (spec 219 A)", () => {
  it("shows the exact checkbox label and helper wording, unchecked by default", () => {
    const html = renderToStaticMarkup(
      createElement(ActiveGameSetupSection, {
        value: emptyActiveGameSetup("hjaltth"),
        onChange: noop,
      }),
    )
    expect(html).toContain("Live game — analysis board only")
    expect(html).toContain(
      "This position is from a game that’s still being played.",
    )
    expect(html).toContain(
      "All engine help stays off for this game — explore lines by hand, like on a real board.",
    )
    expect(html).toContain("Analysis unlocks once you mark the game finished.")
    expect(html).toContain('data-testid="active-game-checkbox"')
    // Metadata fields only appear once checked.
    expect(html).not.toContain('data-testid="active-game-fields"')
  })

  it("reveals opponent/username/URL fields when checked, username prefilled", () => {
    const html = renderToStaticMarkup(
      createElement(ActiveGameSetupSection, {
        value: { ...emptyActiveGameSetup("thjaltason"), checked: true },
        onChange: noop,
      }),
    )
    expect(html).toContain('data-testid="active-game-fields"')
    expect(html).toContain('data-testid="active-game-opponent"')
    expect(html).toContain('data-testid="active-game-url"')
    expect(html).toContain('value="thjaltason"')
  })

  it("locked mode (already-flagged game) offers no checkbox — spec 219 B no-bypass", () => {
    const html = renderToStaticMarkup(
      createElement(ActiveGameSetupSection, {
        value: emptyActiveGameSetup(),
        onChange: noop,
        lockedMeta: meta(),
      }),
    )
    expect(html).toContain('data-testid="active-game-locked"')
    expect(html).toContain("already flagged as an active chess.com daily game")
    expect(html).not.toContain('data-testid="active-game-checkbox"')
  })
})

describe("activeGameMetaFromSetup", () => {
  it("returns null when unchecked", () => {
    expect(activeGameMetaFromSetup(emptyActiveGameSetup("x"))).toBeNull()
  })

  it("trims fields, nulls an empty URL, stamps flaggedAt", () => {
    const m = activeGameMetaFromSetup(
      {
        checked: true,
        opponent: " dad ",
        chesscomUsername: " hjaltth ",
        gameUrl: "  ",
      },
      12345,
    )
    expect(m).toEqual({
      opponent: "dad",
      chesscomUsername: "hjaltth",
      gameUrl: null,
      flaggedAt: 12345,
    })
  })
})

describe("ActiveGameNotice (spec 219 B honest UX)", () => {
  it("names the lockout and offers Continue later", () => {
    const html = renderToStaticMarkup(
      createElement(ActiveGameNotice, {
        meta: meta(),
        onContinueLater: noop,
        onShowList: noop,
      }),
    )
    expect(html).toContain("Live game — engine off (fair play)")
    expect(html).toContain("vs dad")
    expect(html).toContain("Continue later")
    expect(html).toContain('data-testid="active-game-notice"')
  })
})

describe("ActiveGamesList (spec 219 D)", () => {
  it("shows opponent, move count, last-updated and the Resume / Game finished actions", () => {
    const tree = GameTree.fromMoves(["e4", "e5", "Nf3"])
    const rec = newActiveGameRecord("ag-1", tree.toJSON(), meta(), Date.now())
    const html = renderList([rec])
    expect(html).toContain("vs dad")
    expect(html).toContain("as hjaltth")
    expect(html).toContain("3 moves")
    expect(html).toContain("just now")
    expect(html).toContain("Resume")
    expect(html).toContain("Game finished")
    expect(html).toContain('data-testid="active-game-delete-ag-1"')
  })

  it("renders an archived record as unlocked, with Remove instead of the fair-play actions", () => {
    const rec = markActiveGameArchived(
      newActiveGameRecord("ag-2", GameTree.create().toJSON(), meta(), Date.now()),
      Date.now(),
    )
    const html = renderList([rec])
    expect(html).toContain("Archived — engine analysis unlocked")
    expect(html).toContain("Remove")
    expect(html).not.toContain("Game finished")
  })

  it("deletion warning carries the fair-play wording", () => {
    expect(ACTIVE_GAME_DELETE_WARNING).toContain("Fair Play Policy")
    expect(ACTIVE_GAME_DELETE_WARNING).toContain("re-enables engine analysis")
    expect(ACTIVE_GAME_DELETE_WARNING).toContain(
      "only do this if the game is truly over or was never real",
    )
  })
})

describe("list helpers", () => {
  it("mainlineMoveCount follows children[0] only", () => {
    const tree = GameTree.fromMoves(["e4", "e5", "Nf3"])
    // Add a variation at move 1: 1.e4 e5 (1...c5) 2.Nf3 — mainline stays 3.
    tree.goToStart()
    const mainline = tree.currentLine()
    tree.goTo(mainline[0].id)
    tree.addMoveUci("c7c5")
    expect(mainlineMoveCount(tree.toJSON())).toBe(3)
    expect(mainlineMoveCount(GameTree.create().toJSON())).toBe(0)
  })

  it("agoLabel buckets minutes, hours, days", () => {
    const now = 10 * 24 * 3600 * 1000
    expect(agoLabel(now - 30_000, now)).toBe("just now")
    expect(agoLabel(now - 5 * 60_000, now)).toBe("5m ago")
    expect(agoLabel(now - 3 * 3_600_000, now)).toBe("3h ago")
    expect(agoLabel(now - 2 * 86_400_000, now)).toBe("2d ago")
  })
})
