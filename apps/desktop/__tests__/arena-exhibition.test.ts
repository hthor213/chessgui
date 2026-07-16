import { describe, it, expect } from "vitest";
import { createMockArenaApiClient } from "@/lib/arena-api-mock";
import { arenaExhibitionStatusLabel, pairExhibitionMoves } from "@/lib/arena-moves";

// Spec 217 Promise 3: persona-vs-persona exhibitions — the server plays both
// sides on a background runner; spectating is a poll of GET
// /api/exhibition/{id}, replay is the same fetch once finished. The mock
// mirrors the server contract (server/arena/app/main.py create_exhibition /
// get_exhibition / stop_exhibition): public roster only, one exhibition at a
// time (409), stop discards the in-flight move, and the ply cap adjudicates
// a draw ("move_cap") so a run always terminates.

// Fast pacing for tests — the runner's per-move delay is the only clock here.
const fastClient = () => createMockArenaApiClient({ exhibitionMoveMs: 2 });

async function waitFor<T>(fn: () => Promise<T>, pred: (t: T) => boolean, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (pred(v)) return v;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("arena exhibitions (spec 217 Promise 3)", () => {
  it("plays a full exhibition in the background and finishes it", async () => {
    const api = fastClient();
    const ex = await api.createExhibition("fischer", "kasparov");
    expect(ex.status).toBe("active");
    expect(ex.whiteName).toBeTruthy();
    expect(ex.blackName).toBeTruthy();
    const done = await waitFor(
      () => api.getExhibition(ex.id),
      (e) => e.status === "finished",
    );
    // Either a natural result or the ply-cap adjudicated draw — both carry a
    // reason and a consistent move record.
    expect(done.result === null ? done.resultReason : done.result).toBeTruthy();
    expect(done.moves.length).toBeGreaterThan(0);
    expect(done.moves[0].ply).toBe(0);
    expect(done.moves.every((m) => m.san.length > 0)).toBe(true);
    // Replay after finish is the same state, stable.
    const replay = await api.getExhibition(ex.id);
    expect(replay.moves.map((m) => m.uci)).toEqual(done.moves.map((m) => m.uci));
  });

  it("spectate poll sees moves arrive while active", async () => {
    const api = createMockArenaApiClient({ exhibitionMoveMs: 30 });
    const ex = await api.createExhibition("fischer", "fischer");
    const seen = await waitFor(
      () => api.getExhibition(ex.id),
      (e) => e.moves.length >= 2 || e.status === "finished",
    );
    expect(seen.moves.length).toBeGreaterThanOrEqual(2);
    await api.stopExhibition(ex.id).catch(() => {}); // don't leak the runner
  });

  it("refuses a second exhibition while one is running (one at a time)", async () => {
    const api = createMockArenaApiClient({ exhibitionMoveMs: 60 });
    const ex = await api.createExhibition("fischer", "kasparov");
    await expect(api.createExhibition("karpov", "spassky")).rejects.toMatchObject({ status: 409 });
    await api.stopExhibition(ex.id);
    // The slot frees once the first is finished.
    const ex2 = await api.createExhibition("karpov", "spassky");
    expect(ex2.status).toBe("active");
    await api.stopExhibition(ex2.id);
  });

  it("rejects a persona that is not on the public roster", async () => {
    const api = fastClient();
    await expect(api.createExhibition("nobody", "fischer")).rejects.toMatchObject({ status: 400 });
  });

  it("stop ends the run without a chess result and 409s a second stop", async () => {
    const api = createMockArenaApiClient({ exhibitionMoveMs: 60 });
    const ex = await api.createExhibition("fischer", "kasparov");
    const stopped = await api.stopExhibition(ex.id);
    expect(stopped.status).toBe("finished");
    expect(stopped.result).toBeNull();
    expect(stopped.resultReason).toBe("stopped");
    await expect(api.stopExhibition(ex.id)).rejects.toMatchObject({ status: 409 });
    // A stopped exhibition frees the slot even though its runner was mid-"think".
    const next = await api.createExhibition("fischer", "kasparov");
    expect(next.status).toBe("active");
    await api.stopExhibition(next.id);
  });

  it("lists exhibitions newest first with move counts", async () => {
    const api = fastClient();
    const a = await api.createExhibition("fischer", "kasparov");
    await waitFor(() => api.getExhibition(a.id), (e) => e.status === "finished");
    const b = await api.createExhibition("karpov", "spassky");
    await api.stopExhibition(b.id);
    const list = await api.listExhibitions();
    expect(list.map((e) => e.id)).toEqual([b.id, a.id]);
    const first = list.find((e) => e.id === a.id)!;
    expect(first.movesCount).toBeGreaterThan(0);
    expect(first.whiteName).toBeTruthy();
  });

  it("404s an unknown exhibition", async () => {
    const api = fastClient();
    await expect(api.getExhibition(999)).rejects.toMatchObject({ status: 404 });
    await expect(api.stopExhibition(999)).rejects.toMatchObject({ status: 404 });
  });

  it("labels results in a spectator voice", () => {
    const base = { whiteName: "Bobby Fischer", blackName: "Garry Kasparov" };
    expect(
      arenaExhibitionStatusLabel({ ...base, status: "active", result: null, resultReason: null }),
    ).toBeNull();
    expect(
      arenaExhibitionStatusLabel({ ...base, status: "finished", result: "1-0", resultReason: "checkmate" }),
    ).toBe("Bobby Fischer wins — Checkmate");
    expect(
      arenaExhibitionStatusLabel({ ...base, status: "finished", result: "0-1", resultReason: null }),
    ).toBe("Garry Kasparov wins");
    expect(
      arenaExhibitionStatusLabel({ ...base, status: "finished", result: "1/2-1/2", resultReason: "move_cap" }),
    ).toBe("Draw — Adjudicated at the move cap");
    expect(
      arenaExhibitionStatusLabel({ ...base, status: "finished", result: null, resultReason: "stopped" }),
    ).toBe("Stopped");
    expect(
      arenaExhibitionStatusLabel({ ...base, status: "finished", result: null, resultReason: "engine stall" }),
    ).toBe("Engine stalled");
  });

  it("pairs exhibition moves into numbered rows by ply parity", () => {
    const rows = pairExhibitionMoves([
      { ply: 0, uci: "e2e4", san: "e4", arm: "book" },
      { ply: 1, uci: "e7e5", san: "e5", arm: "book" },
      { ply: 2, uci: "g1f3", san: "Nf3", arm: "search" },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0].white?.san).toBe("e4");
    expect(rows[0].black?.san).toBe("e5");
    expect(rows[1].no).toBe(2);
    expect(rows[1].white?.san).toBe("Nf3");
    expect(rows[1].black).toBeUndefined();
  });
});
