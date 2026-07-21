// The live-position sync (spec 219 F).
//
// The PGN fixture is the user's REAL in-progress chess.com daily game, pulled
// live from /pub/player/hjaltth/games on 2026-07-20. It is deliberately a
// Chess960 game: that is what the user actually had running, and it exercises
// the start-FEN/castling path that a standard-chess fixture would not.

import { describe, expect, it } from "vitest"
import { GameTree } from "../src/game-tree"
import { parsePgnToTrees } from "../src/pgn"
import { pruneBehindLive, syncLiveLine } from "../src/live-sync"
import {
  fetchOngoingGames,
  matchOngoingGame,
  ongoingGameColorFor,
  playerUrlUsername,
  type ChesscomOngoingGame,
  type FetchLike,
} from "../src/chesscom"

const LIVE_PGN =
  '[Event "Let\'s Play! - Chess960"]\n[Site "Chess.com"]\n[Date "2026.07.17"]\n' +
  '[White "painterdenny"]\n[Black "hjaltth"]\n[Result "*"]\n[Variant "Chess960"]\n' +
  '[SetUp "1"]\n[FEN "nrkbqnbr/pppppppp/8/8/8/8/PPPPPPPP/NRKBQNBR w HBhb - 0 1"]\n' +
  '[Link "https://www.chess.com/game/daily/1000687368"]\n\n' +
  "1. f3 1... Nb6 2. e4 2... e5 3. Ne3 3... c5 4. c4 4... Bg5 5. Nac2 5... g6 " +
  "6. h4 6... Be7 7. d3 7... f6 8. b3 8... Ne6 9. g3 9... h5 10. Nd5 10... Nxd5 " +
  "11. exd5 11... Nc7 12. a4 12... Na6 13. Be3 13... f5 14. f4 *\n"

/** The real game's 27 plies, replayed onto a matching empty 960 board. */
function freshBoard(): GameTree {
  const tree = parsePgnToTrees(LIVE_PGN)[0]
  // Same start position and variant, but no moves — what the user's board
  // looks like right after flagging the game in the position editor.
  return GameTree.create(tree.startFen, {}, tree.variant)
}

const ongoing = (over: Partial<ChesscomOngoingGame> = {}): ChesscomOngoingGame => ({
  url: "https://www.chess.com/game/daily/1000687368",
  pgn: LIVE_PGN,
  fen: "1rk1q1br/pp1pb3/n5p1/2pPpp1p/P1P2P1P/1P1PB1P1/2N5/1RKBQ2R b KBkb - 0 14",
  turn: "black",
  rules: "chess960",
  white: "https://api.chess.com/pub/player/painterdenny",
  black: "https://api.chess.com/pub/player/hjaltth",
  ...over,
})

describe("ongoing-games client (spec 219 F)", () => {
  it("parses the live response shape — white/black are URL strings, not objects", async () => {
    const fetchFn: FetchLike = async (url) => {
      expect(url).toBe("https://api.chess.com/pub/player/hjaltth/games")
      return { ok: true, status: 200, json: async () => ({ games: [ongoing()] }) }
    }
    const res = await fetchOngoingGames({ username: "hjaltth", fetchFn })
    expect(res.status).toBe("ok")
    if (res.status !== "ok") return
    expect(res.games).toHaveLength(1)
    expect(res.games[0].turn).toBe("black")
  })

  it("sends the descriptive User-Agent chess.com etiquette asks for", async () => {
    let seen: Record<string, string> = {}
    const fetchFn: FetchLike = async (_u, init) => {
      seen = init.headers
      return { ok: true, status: 200, json: async () => ({ games: [] }) }
    }
    await fetchOngoingGames({ username: "hjaltth", fetchFn })
    expect(seen["User-Agent"]).toMatch(/ChessGUI/)
  })

  it("reports HTTP failure as a result, never a throw — a failed sync must not wedge the board", async () => {
    const fetchFn: FetchLike = async () => ({
      ok: false,
      status: 429,
      json: async () => ({}),
    })
    const res = await fetchOngoingGames({ username: "hjaltth", fetchFn })
    expect(res.status).toBe("error")
    if (res.status === "error") expect(res.message).toMatch(/429/)
  })

  it("pulls the username out of a player-profile URL", () => {
    expect(playerUrlUsername("https://api.chess.com/pub/player/hjaltth")).toBe("hjaltth")
    expect(playerUrlUsername("https://api.chess.com/pub/player/hjaltth/")).toBe("hjaltth")
    expect(playerUrlUsername(undefined)).toBeNull()
  })

  it("derives which side the user plays — the board-orientation fix", () => {
    expect(ongoingGameColorFor(ongoing(), "hjaltth")).toBe("black")
    expect(ongoingGameColorFor(ongoing(), "HJALTTH")).toBe("black")
    expect(ongoingGameColorFor(ongoing(), "painterdenny")).toBe("white")
    expect(ongoingGameColorFor(ongoing(), "someone-else")).toBeNull()
  })

  it("matches by stored URL, and refuses to guess between two games vs the same opponent", () => {
    const a = ongoing()
    const b = ongoing({ url: "https://www.chess.com/game/daily/222" })
    expect(matchOngoingGame([a, b], { gameUrl: a.url })?.url).toBe(a.url)
    // Same opponent twice — guessing would pin the pointer to the wrong game.
    expect(matchOngoingGame([a, b], { opponent: "painterdenny" })).toBeNull()
    expect(matchOngoingGame([a], { opponent: "painterdenny" })?.url).toBe(a.url)
  })
})

describe("syncLiveLine (spec 219 F)", () => {
  it("replays the real Chess960 game — all 27 plies, not 0", () => {
    const res = syncLiveLine(freshBoard(), LIVE_PGN)
    expect(res.status).toBe("ok")
    if (res.status !== "ok") return
    expect(res.report.plies).toBe(27)
    expect(res.report.added).toBe(27)
    // The live pointer is the tip, and the cursor sits on it.
    expect(res.tree.currentId).toBe(res.report.liveNodeId)
    expect(res.tree.get(res.report.liveNodeId)!.san).toBe("f4")
    expect(res.tree.get(res.report.liveNodeId)!.ply).toBe(27)
  })

  it("adopts the real game wholesale when the board is empty and the start position differs", () => {
    // A game flagged from the standard start while the real game is 960 —
    // replaying move 1 into the wrong position could never work.
    const res = syncLiveLine(GameTree.create(), LIVE_PGN)
    expect(res.status).toBe("ok")
    if (res.status !== "ok") return
    expect(res.report.adopted).toBe(true)
    expect(res.tree.variant).toBe("chess960")
    expect(res.tree.get(res.report.liveNodeId)!.san).toBe("f4")
  })

  it("marks the moves it appends as played, not as the user's candidates", () => {
    // Reality is not a candidate (spec 226 C/H). A move the sync put on the
    // board is one the player never named, and left unmarked it would top the
    // candidate list up with the answer — which is precisely the gap the
    // blind-spot record exists to preserve.
    const res = syncLiveLine(freshBoard(), LIVE_PGN)
    expect(res.status).toBe("ok")
    if (res.status !== "ok") return
    const appended = res.tree.mainlineNodes().slice(1)
    expect(appended.every((n) => n.src === "played")).toBe(true)
  })

  it("leaves a move the user had already found as their own", () => {
    // Having foreseen it is exactly the thing the record is meant to capture,
    // so reality arriving later must not take the credit.
    const tree = freshBoard()
    const first = syncLiveLine(freshBoard(), LIVE_PGN)
    expect(first.status).toBe("ok")
    if (first.status !== "ok") return
    const firstSan = first.tree.mainlineNodes()[1].san
    tree.goToStart()
    const mine = tree.addMoveSan(firstSan)!
    expect(tree.get(mine)!.src).toBeUndefined()
    const res = syncLiveLine(tree, LIVE_PGN)
    expect(res.status).toBe("ok")
    if (res.status !== "ok") return
    expect(res.tree.get(mine)!.src).toBeUndefined()
  })

  it("marks an adopted game's moves too — an empty board named nothing", () => {
    const res = syncLiveLine(GameTree.create(), LIVE_PGN)
    expect(res.status).toBe("ok")
    if (res.status !== "ok") return
    expect(res.report.adopted).toBe(true)
    expect(res.tree.mainlineNodes().slice(1).every((n) => n.src === "played")).toBe(true)
  })

  it("is idempotent — re-syncing an unchanged game adds nothing", () => {
    const first = syncLiveLine(freshBoard(), LIVE_PGN)
    expect(first.status).toBe("ok")
    if (first.status !== "ok") return
    const again = syncLiveLine(first.tree, LIVE_PGN)
    expect(again.status).toBe("ok")
    if (again.status !== "ok") return
    expect(again.report.added).toBe(0)
    expect(again.report.liveNodeId).toBe(first.report.liveNodeId)
  })

  it("advances the pointer by exactly the moves the opponent played", () => {
    const shortPgn = LIVE_PGN.replace(" 14. f4 *", " *")
    const before = syncLiveLine(freshBoard(), shortPgn)
    expect(before.status).toBe("ok")
    if (before.status !== "ok") return
    expect(before.report.plies).toBe(26)

    const after = syncLiveLine(before.tree, LIVE_PGN)
    expect(after.status).toBe("ok")
    if (after.status !== "ok") return
    expect(after.report.added).toBe(1)
    expect(after.tree.get(after.report.liveNodeId)!.san).toBe("f4")
  })

  it("promotes reality over a variation the user had left on the mainline", () => {
    // Exactly the user's screenshot: their board had 1. f4 as the mainline
    // while the real game (1. f3 …) sat in parentheses.
    const tree = freshBoard()
    tree.addMoveSan("f4")
    expect(tree.root().children).toHaveLength(1)

    const res = syncLiveLine(tree, LIVE_PGN)
    expect(res.status).toBe("ok")
    if (res.status !== "ok") return
    // The real first move now leads the root's children; f4 survives behind it.
    const firstChild = res.tree.get(res.tree.root().children[0])!
    expect(firstChild.san).toBe("f3")
    expect(res.report.promoted).toBeGreaterThan(0)
  })

  it("refuses a game that diverges from a board with moves on it, leaving the pointer alone", () => {
    const tree = GameTree.create() // standard chess, and NOT empty
    tree.addMoveSan("e4")
    const res = syncLiveLine(tree, LIVE_PGN)
    expect(res.status).toBe("error")
  })
})

describe("pruneBehindLive (spec 219 F — clean up committed history)", () => {
  it("deletes exploration behind the live position and keeps exploration at/after it", () => {
    const tree = freshBoard()
    // Real game, three plies deep.
    tree.addMoveSan("f3")
    tree.addMoveSan("Nb6")
    const liveId = tree.addMoveSan("e4")!

    // A dead line: branched at ply 1, before the live position.
    tree.goToStart()
    tree.addMoveSan("f4")
    const deadId = tree.currentId
    // A live line: branched AT the live position — still worth something.
    tree.goTo(liveId)
    tree.addMoveSan("e5")
    const aliveId = tree.currentId

    const pruned = pruneBehindLive(tree, liveId)
    expect(pruned).toBe(1)
    expect(tree.get(deadId)).toBeUndefined()
    expect(tree.get(aliveId)).toBeDefined()
    // The played history itself is untouched.
    expect(tree.pathToNode(liveId).map((n) => n.san)).toEqual(["", "f3", "Nb6", "e4"])
  })

  it("rescues the cursor when it was sitting inside a pruned line", () => {
    const tree = freshBoard()
    tree.addMoveSan("f3")
    const liveId = tree.addMoveSan("Nb6")!
    tree.goToStart()
    tree.addMoveSan("f4") // cursor is now inside the doomed branch
    pruneBehindLive(tree, liveId)
    expect(tree.get(tree.currentId)).toBeDefined()
  })
})

describe("livePositionState (spec 219 F — where am I?)", () => {
  function setup() {
    const tree = freshBoard()
    tree.addMoveSan("f3")
    tree.addMoveSan("Nb6")
    const liveId = tree.addMoveSan("e4")!
    return { tree, liveId }
  }

  it("is 'live' on the pointer itself, and moves are allowed", () => {
    const { tree, liveId } = setup()
    const s = tree.livePositionState(liveId, liveId)
    expect(s.relation).toBe("live")
    expect(s.distance).toBe(0)
    expect(s.canMove).toBe(true)
  })

  it("is 'ahead' when exploring forward — the whole point of the analysis board", () => {
    const { tree, liveId } = setup()
    tree.goTo(liveId)
    tree.addMoveSan("e5")
    const deep = tree.addMoveSan("Ne3")!
    const s = tree.livePositionState(liveId, deep)
    expect(s.relation).toBe("ahead")
    expect(s.distance).toBe(2)
    expect(s.canMove).toBe(true)
  })

  it("is 'behind' up the played path, and blocks moves there", () => {
    const { tree, liveId } = setup()
    const back = tree.pathToNode(liveId)[1].id // one ply in
    const s = tree.livePositionState(liveId, back)
    expect(s.relation).toBe("behind")
    expect(s.distance).toBe(2)
    expect(s.canMove).toBe(false)
  })

  it("is 'off-branch' inside a line that left before the live position, and blocks moves", () => {
    const { tree, liveId } = setup()
    tree.goToStart()
    const side = tree.addMoveSan("f4")!
    const s = tree.livePositionState(liveId, side)
    expect(s.relation).toBe("off-branch")
    expect(s.canMove).toBe(false)
  })

  it("is 'unknown' — and fully movable — for a game with no live pointer", () => {
    const { tree } = setup()
    const s = tree.livePositionState(undefined)
    expect(s.relation).toBe("unknown")
    expect(s.canMove).toBe(true)
    expect(tree.livePositionState("nonexistent-node").relation).toBe("unknown")
  })
})
