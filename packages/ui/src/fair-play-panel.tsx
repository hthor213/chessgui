"use client";

// The fair-play side panel (spec 219 F) — modelled on chess.com's Daily
// layout, which is the one the user already reads fluently: board on the left,
// a single tabbed panel on the right holding the move record and the openings
// book, with navigation at its foot.
//
// This panel is why a fair-play game can drop to two columns at all. The third
// column of the normal layout exists for the eval bar, analysis panel and eval
// graph — every one of which is structurally hidden under the spec 219
// lockout. Fair play is precisely the mode that has space to spare.
//
// The fair-play status is ONE LINE, by explicit instruction: a card announcing
// "engine disabled" earns its space once, not on every glance.

import { useState } from "react";
import { Card } from "@chessgui/ui/ui/card";
import { MoveTable } from "@chessgui/ui/move-table";
import { NotebookPanel } from "@chessgui/ui/notebook-panel";
import { NotebookTable } from "@chessgui/ui/notebook-table";
import { sortedChildren } from "@chessgui/core/notebook";
import type { ActiveGameMeta, LivePositionState } from "@chessgui/core/active-game";
import type { GameTree, Likelihood, MoveNode } from "@chessgui/core/game-tree";
import type { Assessment, NodeValue } from "@chessgui/core/notebook";

export interface FairPlayPanelProps {
  meta: ActiveGameMeta | null;
  tree: GameTree;
  currentId: string;
  onGoToNode: (id: string) => void;
  version?: number;
  livePosition: LivePositionState;
  /** Whose move it is at the live position. */
  turn?: "white" | "black" | null;
  /** Which side the user plays — turns "White to move" into "your move". */
  myColor?: "white" | "black" | null;
  now?: number;
  syncPending?: boolean;
  syncMessage?: string | null;
  onSync: () => void;
  onBackToLive: () => void;
  /** Tree navigation (spec 226 L). */
  onRetreatBranch?: () => void;
  onJumpBest?: () => void;
  /** Toggle the Eval-Map board overlay (spec 226) — my explored moves coloured
   *  red→green, native move-dots suppressed. */
  onToggleEvalMap?: () => void;
  evalMapOn?: boolean;
  onRewalk?: () => void;
  /** True when a preview is armed at the current node, so re-walk commits. */
  rewalkArmed?: boolean;
  /** True when the current node has a continuation to re-walk. */
  canRewalk?: boolean;
  /** True when the cursor is ahead of the live position — where re-walk and
   *  retreat make sense. */
  exploring?: boolean;
  onContinueLater: () => void;
  onShowList: () => void;
  /** Navigation, mirroring the bar that sits under the board elsewhere. */
  onStart: () => void;
  onBack: () => void;
  onForward: () => void;
  onEnd: () => void;
  canBack: boolean;
  canForward: boolean;
  /** The opening explorer — passed in so this package stays layout-only and
   *  the desktop shell keeps owning the explorer's data wiring. Legal in
   *  Daily play (spec 219 "Opening books / databases"), which is exactly why
   *  it gets a tab rather than being cut. */
  openingsSlot?: React.ReactNode;
  /**
   * The Notebook (spec 226). Backed-up values are recomputed by the shell on
   * every tree change and passed in; this package stays derivation-free. Omit
   * the whole group and the panel is exactly what it was before.
   */
  notebookValues?: Map<string, NodeValue>;
  currentNode?: MoveNode;
  onSetAssessment?: (id: string, a: Assessment | null) => void;
  onSetLikelihood?: (id: string, lik: Likelihood | null) => void;
  /** Notebook keystrokes only fire while the board view is frontmost. */
  notebookActive?: boolean;
  /**
   * Open the head-to-head (spec 226 I). Compare mode replaces the whole
   * board+panel layout with two full boards, so the shell owns that state —
   * this panel only forwards the pair the user picked.
   */
  onCompare?: (aId: string, bId: string) => void;
}

/** Compact relative age: "just now", "6m ago", "3h ago", "2d ago". */
export function syncAge(syncedAt: number | null | undefined, now: number): string | null {
  if (!syncedAt) return null;
  const secs = Math.max(0, Math.round((now - syncedAt) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

// "candidates" is the Notebook's reading surface (spec 226): the same tree the
// Moves tab draws, read as one table per decision instead of as branches. It is
// a tab rather than a new pane for one reason — the board is the star and this
// takes none of its space (user 2026-07-21).
type Tab = "moves" | "openings" | "candidates";

function NavButton({
  onClick,
  disabled,
  title,
  children,
  testId,
  active,
}: {
  onClick: () => void;
  disabled?: boolean;
  title: string;
  children: React.ReactNode;
  testId?: string;
  /** Sticky-on look for a toggle button (e.g. the Eval-Map). */
  active?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      data-testid={testId}
      aria-pressed={active}
      className={`flex-1 px-2 py-1.5 text-sm rounded-md border transition-colors disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground ${
        active
          ? "border-primary/60 bg-primary/15 text-foreground"
          : "border-input bg-background text-muted-foreground hover:text-foreground hover:bg-white/5"
      }`}
    >
      {children}
    </button>
  );
}

/** The one-line status: lockout, live pointer, and whose move it is. */
export function fairPlayStatusText(
  state: LivePositionState,
  turn: "white" | "black" | null | undefined,
  myColor: "white" | "black" | null | undefined,
  age: string | null,
): string {
  if (state.relation === "unknown") return "Not synced yet";
  const moves = `${state.distance} ${state.distance === 1 ? "move" : "moves"}`;
  // Stepping BACK through the played game is replay, not exploration — a
  // normal thing to do, and worth naming as itself (user 2026-07-20).
  if (state.relation === "behind") return `Replay · ${moves} back`;
  if (state.relation === "off-branch") return `Side line · ${moves} in`;
  if (state.relation === "ahead") return `Exploring · ${moves} from live`;
  const parts: string[] = ["LIVE"];
  if (turn) {
    parts.push(
      myColor ? (turn === myColor ? "your move" : "their move") : `${turn} to move`,
    );
  }
  if (age) parts.push(age);
  return parts.join(" · ");
}

export function FairPlayPanel({
  meta,
  tree,
  currentId,
  onGoToNode,
  version,
  livePosition,
  turn,
  myColor,
  now = Date.now(),
  syncPending = false,
  syncMessage,
  onSync,
  onBackToLive,
  onRetreatBranch,
  onToggleEvalMap,
  evalMapOn,
  onRewalk,
  rewalkArmed,
  canRewalk,
  exploring,
  onContinueLater,
  onShowList,
  onStart,
  onBack,
  onForward,
  onEnd,
  canBack,
  canForward,
  openingsSlot,
  notebookValues,
  currentNode,
  onSetAssessment,
  onSetLikelihood,
  notebookActive = false,
  onCompare,
}: FairPlayPanelProps) {
  const [tab, setTab] = useState<Tab>("moves");
  // Display order, not stored order (spec 226 F) — hence local state here
  // rather than anything that could reach the tree.
  const [sortByRank, setSortByRank] = useState(false);
  const notebookOn = !!notebookValues && !!currentNode && !!onSetAssessment && !!onSetLikelihood;
  const live = livePosition.relation === "live";
  const status = fairPlayStatusText(
    livePosition,
    turn,
    myColor,
    syncAge(meta?.liveSyncedAt, now),
  );

  return (
    <Card className="bg-card/50 backdrop-blur-sm border-white/10 flex flex-col min-h-0 overflow-hidden p-0">
      {/* One-line status. The lock glyph carries the fair-play meaning that
          used to need a whole card; the tooltip carries the detail. */}
      <div
        // 13px floor: this line is the one that used to sit over the board and
        // was moved here instead (user 2026-07-20). Moving it was only worth
        // doing if it stayed readable where it landed.
        className="flex items-center gap-2 px-3 py-1.5 border-b border-white/10 text-[13px] shrink-0"
        data-testid="fair-play-status"
      >
        <span
          className="select-none"
          title="Fair-play game — every engine surface is disabled for this game (chess.com Fair Play Policy)"
        >
          🔒
        </span>
        <span
          className={live ? "font-semibold text-emerald-300" : "font-semibold text-amber-300"}
        >
          {live ? "●" : "⑂"} {status}
        </span>
        <span className="flex-1" />
        <button
          onClick={onSync}
          disabled={syncPending}
          title="Check chess.com for the opponent's move"
          data-testid="panel-sync"
          className="px-1.5 py-0.5 rounded hover:bg-white/10 disabled:opacity-40"
        >
          {syncPending ? "⟳…" : "⟳"}
        </button>
        <button
          onClick={onContinueLater}
          title="Save this game and clear the board"
          className="px-1.5 py-0.5 rounded hover:bg-white/10 text-muted-foreground"
        >
          Later
        </button>
        <button
          onClick={onShowList}
          title="All fair-play games"
          className="px-1.5 py-0.5 rounded hover:bg-white/10 text-muted-foreground"
        >
          ⋯
        </button>
      </div>

      {syncMessage && (
        <div
          className="px-3 py-1 text-[13px] text-muted-foreground border-b border-white/10 shrink-0"
          data-testid="panel-sync-message"
        >
          {syncMessage}
        </div>
      )}

      {/* Tabs — "Openings" keeps the explorer reachable, and it is one of the
          few aids chess.com permits in Daily play. */}
      <div className="flex border-b border-white/10 shrink-0">
        {(notebookOn
          ? (["moves", "candidates", "openings"] as Tab[])
          : (["moves", "openings"] as Tab[])
        ).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            data-testid={`fair-play-tab-${t}`}
            className={`px-4 py-2 text-sm capitalize transition-colors ${
              tab === t
                ? "text-foreground border-b-2 border-[#9bc700] -mb-px font-medium"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {/* The notebook strip sits above the record, not over the board: the
          judgement is typed while reading the same lines it annotates. */}
      {tab !== "openings" && notebookOn && (
        <NotebookPanel
          tree={tree}
          node={currentNode as MoveNode}
          values={notebookValues as Map<string, NodeValue>}
          myColor={myColor ?? "white"}
          onSetAssessment={onSetAssessment as (id: string, a: Assessment | null) => void}
          onSetLikelihood={onSetLikelihood as (id: string, lik: Likelihood | null) => void}
          onGoToNode={onGoToNode}
          sortByRank={sortByRank}
          onToggleSort={() => setSortByRank((s) => !s)}
          onCompare={onCompare}
          active={notebookActive}
          version={version}
          // On the Candidates tab the table below IS the candidate list; the
          // strip keeps the header line and the entry keys and stops drawing
          // the list twice.
          showCandidates={tab === "moves"}
        />
      )}

      <div className={`flex-1 min-h-0 overflow-hidden ${tab === "candidates" ? "" : "p-2"}`}>
        {tab === "candidates" && notebookOn ? (
          <NotebookTable
            tree={tree}
            node={currentNode as MoveNode}
            values={notebookValues as Map<string, NodeValue>}
            myColor={myColor ?? "white"}
            // The baseline the table falls back to: the ranking when the strip
            // says "as I rank", the order they explored in otherwise. The table
            // never invents one (spec 226 F).
            order={
              sortByRank
                ? sortedChildren(
                    tree,
                    notebookValues as Map<string, NodeValue>,
                    (currentNode as MoveNode).id,
                  )
                : (currentNode as MoveNode).children
            }
            onGoToNode={onGoToNode}
            // The same head-to-head entry point the strip offers, so a reader
            // working in the table never has to change tabs to run the one
            // comparison spec 226 I calls worth more than more assessment.
            onCompare={onCompare}
            version={version}
          />
        ) : tab === "moves" ? (
          <MoveTable
            tree={tree}
            currentId={currentId}
            onGoToNode={onGoToNode}
            version={version}
            liveNodeId={meta?.liveNodeId}
            notebook={
              notebookOn
                ? { values: notebookValues as Map<string, NodeValue>, sortByRank }
                : undefined
            }
          />
        ) : (
          <div className="h-full overflow-y-auto">{openingsSlot}</div>
        )}
      </div>

      {/* Navigation at the foot, chess.com-style. */}
      <div className="flex items-center gap-1 p-2 border-t border-white/10 shrink-0">
        <NavButton onClick={onStart} disabled={!canBack} title="Start (Home)">
          ⏮
        </NavButton>
        <NavButton onClick={onBack} disabled={!canBack} title="Back (←)">
          ◀
        </NavButton>
        <NavButton onClick={onForward} disabled={!canForward} title="Forward (→)">
          ▶
        </NavButton>
        <NavButton onClick={onEnd} disabled={!canForward} title="End (End)">
          ⏭
        </NavButton>
        <NavButton
          onClick={onBackToLive}
          disabled={live || livePosition.relation === "unknown"}
          title="Back to the real game position"
          testId="panel-back-to-live"
        >
          ⟲ Current
        </NavButton>
      </div>

      {/* Exploration navigation (spec 226 L). Only while ahead of live, where
          retreating and re-walking your own lines is the whole point. */}
      {exploring && (
        <div className="flex items-center gap-1 px-2 pb-2 shrink-0">
          <NavButton
            onClick={onRetreatBranch ?? (() => {})}
            disabled={live}
            title="Back to the head of this line"
          >
            ⤒ Branch
          </NavButton>
          <NavButton
            onClick={onToggleEvalMap ?? (() => {})}
            active={evalMapOn}
            title={
              evalMapOn
                ? "Hide the eval map"
                : "Colour my explored moves on the board — red (bad) to green (good)"
            }
            testId="panel-eval-map"
          >
            {evalMapOn ? "◉ Eval-Map" : "◎ Eval-Map"}
          </NavButton>
          <NavButton
            onClick={onRewalk ?? (() => {})}
            disabled={!canRewalk}
            title={
              rewalkArmed
                ? "Play that move and step forward"
                : "Show the move I played from here last time"
            }
            testId="panel-rewalk"
          >
            {rewalkArmed ? "▶ Do it" : "↻ Re-walk"}
          </NavButton>
        </div>
      )}
    </Card>
  );
}
