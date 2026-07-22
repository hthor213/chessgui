// Chess960 castling through the live sync (spec 219 F).
//
// The user's real painterdenny game, pulled 2026-07-21 the moment it broke:
// the opponent castled at move 19 and the sync reported a divergence. The bug
// was not the replay — it was the foundation. The game had been set up as a
// STANDARD interpretation of the 960 position (piece placement right, castling
// field "-", variant unset), so castling was structurally impossible in the
// working tree: O-O looked illegal, AND the board hid castling from the user's
// own legal moves the whole game. chess.com is the truth for what the game IS,
// so a foundation mismatch rebuilds the tree from reality.

import { describe, expect, it } from "vitest"
import { GameTree } from "../src/game-tree"
import { parsePgnToTrees } from "../src/pgn"
import { syncLiveLine } from "../src/live-sync"

const PGN_960 = "[Event \"Let's Play! - Chess960\"]\n[Site \"Chess.com\"]\n[Date \"2026.07.17\"]\n[Round \"2\"]\n[White \"painterdenny\"]\n[Black \"hjaltth\"]\n[Result \"*\"]\n[Variant \"Chess960\"]\n[SetUp \"1\"]\n[FEN \"nrkbqnbr/pppppppp/8/8/8/8/PPPPPPPP/NRKBQNBR w HBhb - 0 1\"]\n[CurrentPosition \"1rk1q1br/p7/np3bp1/2pP1p1p/P1P1pP1P/1P2B1P1/2N1BQ2/1R3RK1 b kb - 3 19\"]\n[Timezone \"UTC\"]\n[ECO \"A00\"]\n[ECOUrl \"https://www.chess.com/openings/Barnes-Opening\"]\n[UTCDate \"2026.07.17\"]\n[UTCTime \"17:29:37\"]\n[WhiteElo \"1178\"]\n[BlackElo \"1223\"]\n[TimeControl \"1/259200\"]\n[StartTime \"17:29:37\"]\n[Link \"https://www.chess.com/game/daily/1000687368\"]\n\n1. f3 {[%clk 71:58:35]} 1... Nb6 {[%clk 64:48:43]} 2. e4 {[%clk 71:34:04]} 2... e5 {[%clk 71:26:04]} 3. Ne3 {[%clk 71:40:53]} 3... c5 {[%clk 70:18:01]} 4. c4 {[%clk 61:54:31]} 4... Bg5 {[%clk 67:36:40]} 5. Nac2 {[%clk 71:13:40]} 5... g6 {[%clk 66:44:53]} 6. h4 {[%clk 71:51:49]} 6... Be7 {[%clk 71:41:50]} 7. d3 {[%clk 71:17:31]} 7... f6 {[%clk 71:52:13]} 8. b3 {[%clk 59:26:47]} 8... Ne6 {[%clk 66:36:43]} 9. g3 {[%clk 69:40:56]} 9... h5 {[%clk 70:02:55]} 10. Nd5 {[%clk 71:58:31]} 10... Nxd5 {[%clk 71:55:31]} 11. exd5 {[%clk 71:50:06]} 11... Nc7 {[%clk 71:57:27]} 12. a4 {[%clk 71:51:26]} 12... Na6 {[%clk 71:35:40]} 13. Be3 {[%clk 71:28:46]} 13... f5 {[%clk 53:26:02]} 14. f4 {[%clk 71:29:57]} 14... e4 {[%clk 70:20:35]} 15. d4 {[%clk 71:47:15]} 15... d6 {[%clk 71:50:24]} 16. dxc5 {[%clk 71:24:15]} 16... dxc5 {[%clk 70:33:50]} 17. Qf2 {[%clk 69:05:20]} 17... b6 {[%clk 57:40:57]} 18. Be2 {[%clk 70:19:00]} 18... Bf6 {[%clk 64:56:07]} 19. O-O {[%clk 71:53:17]} *\n"

describe("960 foundation mismatch rebuilds from chess.com", () => {
  it("adopts when the working tree lost its variant + castling rights", () => {
    const broken = GameTree.create(
      "nrkbqnbr/pppppppp/8/8/8/8/PPPPPPPP/NRKBQNBR w - - 0 1",
    )
    broken.addMoveSan("f3")
    broken.addMoveSan("Nb6")
    const res = syncLiveLine(broken, PGN_960)
    expect(res.status).toBe("ok")
    if (res.status !== "ok") return
    expect(res.report.adopted).toBe(true)
    expect(res.tree.variant).toBe("chess960")
    expect(res.tree.mainlineNodes().some((n) => n.san === "O-O")).toBe(true)
  })

  it("does NOT adopt a correctly-set-up 960 game — exploration is kept", () => {
    const real = parsePgnToTrees(PGN_960)[0]
    const good = GameTree.create(real.startFen, {}, real.variant)
    good.goToStart()
    good.addMoveSan("e4") // an exploration to preserve
    const res = syncLiveLine(good, PGN_960)
    expect(res.status).toBe("ok")
    if (res.status !== "ok") return
    expect(res.report.adopted).toBe(false)
  })
})
