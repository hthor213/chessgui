"use client";

// The Notebook's entry strip (spec 226) — the only place assessments and
// opponent-likelihoods are typed, and the only place the backed-up value of
// the current node is spelled out in words.
//
// It lives in the fair-play panel and NOTHING it produces reaches the board:
// no arrows, no highlights, no overlay. The user has rejected on-board
// notebook chrome twice; the board shows the position and nothing else.
//
// The three constraints that shape every line below:
//
//  1. It never names, counts or hints at a move the user did not play. The
//     candidate list at a node IS its child set, because the user made every
//     child themselves. "2 of my 6 candidates" is their own handwriting read
//     back to them; "22 replies remain" would be the app doing their work.
//  2. It never recommends. No "look here next", no ranking by where effort is
//     missing. A notebook is passive — you notice the half-empty column
//     because you are reading your own page (spec 226 "The app may display
//     state. It may never recommend.").
//  3. No engine, anywhere. The values below read node.nags and node.lik; the
//     engine's verdict lives in a different field and is not touched here.
//     That separation is what makes this legal inside the spec 219 lockout.
//  4. Nothing here goes below 13px. The panel is read at a glance mid-think,
//     beside a board, and smaller type was reported unreadable (user
//     2026-07-21). Subordinate labels earn their place with colour and case,
//     never with size; a source-level guard in notebook-ui.test.ts holds the
//     floor, because it had been eroding one new row at a time.

import { useEffect, useRef, useState } from "react";
import {
  assessmentGlyph,
  assessmentOf,
  coverageLabel,
  formatPoint,
  sharpnessLabel,
  sortedChildren,
  valueWords,
  widthLabel,
} from "@chessgui/core/notebook";
import type { Assessment, NodeValue } from "@chessgui/core/notebook";
import { moveNumberPrefix, moverIsWhite } from "@chessgui/core/game-tree";
import type { GameTree, Likelihood, MoveNode } from "@chessgui/core/game-tree";
import { Confidence, NotebookBadge } from "@chessgui/ui/notebook-value";

/**
 * The seven-point scale in reading order — Black-winning on the left, exactly
 * as an eval bar runs — bound to 1…7 so the whole vocabulary is one keystroke
 * away. Entry has to be fast enough to judge WHILE exploring; a form would
 * defeat the feature (spec 226 A).
 */
export const ASSESSMENT_KEYS: { key: string; value: Assessment; title: string }[] = [
  { key: "1", value: -3, title: "Black is winning" },
  { key: "2", value: -2, title: "Black is clearly better" },
  { key: "3", value: -1, title: "Black is slightly better" },
  { key: "4", value: 0, title: "Equal" },
  { key: "5", value: 1, title: "White is slightly better" },
  { key: "6", value: 2, title: "White is clearly better" },
  { key: "7", value: 3, title: "White is winning" },
];

/** Three buckets, never percentages — the user says which, the maths normalises. */
export const LIKELIHOOD_KEYS: { key: string; value: Likelihood; label: string }[] = [
  { key: "l", value: 3, label: "likely" },
  { key: "p", value: 2, label: "possible" },
  { key: "u", value: 1, label: "unlikely" },
];

export interface NotebookPanelProps {
  tree: GameTree;
  /** The node under the cursor — assessments attach to it. */
  node: MoveNode;
  values: Map<string, NodeValue>;
  /** Which side the user is playing: decides whose replies get a likelihood. */
  myColor: "white" | "black";
  onSetAssessment: (id: string, a: Assessment | null) => void;
  onSetLikelihood: (id: string, lik: Likelihood | null) => void;
  onGoToNode: (id: string) => void;
  sortByRank: boolean;
  onToggleSort: () => void;
  /**
   * Open the head-to-head on two candidates (spec 226 I). The PAIR IS THE
   * USER'S: the panel offers a per-row toggle and nothing else — no suggested
   * pairing, no "these two are tied, compare them", because picking the
   * comparison is picking what matters, and that is their job. Omit the
   * callback and the whole affordance disappears.
   */
  onCompare?: (aId: string, bId: string) => void;
  /** Keyboard shortcuts only fire while the board view is frontmost. */
  active: boolean;
  /**
   * Whether the strip draws the candidate list itself. False on the Candidates
   * tab, where the table below is the same list in full — printing both would
   * be the panel and the table stating one fact twice, which is a named cause
   * of the illegibility complaint. The strip stays mounted either way, because
   * it owns the assessment keystrokes and they must not die when the reader
   * changes tab.
   */
  showCandidates?: boolean;
  /** Bumped on every tree mutation — `tree` is a stable instance reference. */
  version?: number;
}

function isTextInput(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return (
    !!el &&
    (el.tagName === "INPUT" ||
      el.tagName === "TEXTAREA" ||
      el.tagName === "SELECT" ||
      el.isContentEditable)
  );
}

/** True when this move was the opponent's — the only moves that get a bucket. */
export function isOpponentReply(node: MoveNode, myColor: "white" | "black"): boolean {
  if (node.parent === null) return false;
  return (moverIsWhite(node) ? "white" : "black") !== myColor;
}

function Chip({
  on,
  title,
  onClick,
  children,
  testId,
}: {
  on: boolean;
  title: string;
  onClick: () => void;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      data-testid={testId}
      onClick={onClick}
      className={`min-w-7 px-1.5 py-0.5 text-sm font-mono rounded-sm transition-colors ${
        on
          ? "text-white bg-[rgba(155,199,0,0.25)]"
          : "text-[#9a9a9a] hover:text-foreground hover:bg-white/5"
      }`}
    >
      {children}
    </button>
  );
}

export function NotebookPanel({
  tree,
  node,
  values,
  myColor,
  onSetAssessment,
  onSetLikelihood,
  onGoToNode,
  sortByRank,
  onToggleSort,
  onCompare,
  active,
  showCandidates = true,
}: NotebookPanelProps) {
  // Latest props in refs so the document-level key handler stays stable —
  // same idiom as the annotation bar, and for the same reason: the handler
  // must survive every keystroke-driven re-render.
  const nodeRef = useRef(node);
  const activeRef = useRef(active);
  const myColorRef = useRef(myColor);
  const setAssessmentRef = useRef(onSetAssessment);
  const setLikelihoodRef = useRef(onSetLikelihood);
  nodeRef.current = node;
  activeRef.current = active;
  myColorRef.current = myColor;
  setAssessmentRef.current = onSetAssessment;
  setLikelihoodRef.current = onSetLikelihood;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!activeRef.current || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTextInput(e.target)) return;
      const n = nodeRef.current;
      if (n.parent === null) return; // the starting position gets no judgement

      const a = ASSESSMENT_KEYS.find((k) => k.key === e.key);
      if (a) {
        e.preventDefault();
        // Pressing the same symbol again clears it: a mis-hit costs one more
        // keystroke, not a trip to the mouse.
        const current = assessmentOf(n);
        setAssessmentRef.current(n.id, current === a.value ? null : a.value);
        return;
      }
      if (e.key === "0" || e.key === "Backspace") {
        e.preventDefault();
        setAssessmentRef.current(n.id, null);
        return;
      }
      if (!isOpponentReply(n, myColorRef.current)) return;
      const l = LIKELIHOOD_KEYS.find((k) => k.key === e.key);
      if (l) {
        e.preventDefault();
        setLikelihoodRef.current(n.id, n.lik === l.value ? null : l.value);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  // Which candidates are marked for a head-to-head. Two at a time, oldest
  // dropped, so a third tap swaps rather than needing a clear step.
  const [picked, setPicked] = useState<string[]>([]);
  // A different branch point is a different question — never carry a marked
  // candidate across to siblings it cannot be compared with anyway.
  useEffect(() => setPicked([]), [node.id]);
  const togglePick = (id: string) =>
    setPicked((cur) =>
      cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id].slice(-2),
    );

  const isRoot = node.parent === null;
  const value = values.get(node.id);
  const own = isRoot ? null : assessmentOf(node);
  const opponentReply = isOpponentReply(node, myColor);
  const coverage = value ? coverageLabel(value) : "";
  // Sharpness sits beside coverage rather than in the candidate rows: it is a
  // property of the list rendered below this line, and it is only readable
  // against the coverage fraction printed next to it (spec 226 E/I).
  const sharpness = value ? sharpnessLabel(value) : "";
  // The POINT, not the range. A range like "∓ … +−" only got that wide because
  // few candidates had been examined, so printed next to the coverage fraction
  // on this same line it silently restated it — "truly confusing" in the user's
  // words (2026-07-21). One reading of the value, the words beside it are that
  // same number read aloud, and how settled it is, is the coverage fraction and
  // nothing else. No provisional "?" here for the same reason: the fraction is
  // already on the line.
  const backed = value ? formatPoint(value) : "";
  // Children ARE the candidate list: the user played every one of them.
  const candidates = sortByRank ? sortedChildren(tree, values, node.id) : node.children;
  // A move the app handed over — clicked out of the book, or appended because
  // it was played — is on the board and belongs on the page, but it is not one
  // of "my candidates" and must never be ranked as one (spec 226 C, the same
  // line `isOwnCandidate` draws for coverage and sharpness). So it leaves the
  // ranked list entirely and gets its own group below it.
  const mine = candidates.filter((id) => tree.get(id)?.src === undefined);
  const supplied = candidates.filter((id) => tree.get(id)?.src !== undefined);
  // Split so a move that has actually been judged never competes for attention
  // with one the user merely named — the flat list gave them equal weight,
  // which is a large part of why it could not be read.
  const judged = mine.filter((id) => values.get(id)?.objective != null);
  const unjudged = mine.filter((id) => values.get(id)?.objective == null);

  return (
    <div className="flex flex-col gap-1.5 px-2 py-2 border-b border-white/10 shrink-0 text-[13px]">
      <div className="flex items-baseline gap-2">
        <span className="font-semibold text-[15px] text-[#e8e4dd] truncate">
          {isRoot ? "Starting position" : `${moveNumberPrefix(node)} ${node.san}`}
        </span>
        {backed && (
          <span className="font-mono text-[15px] text-[#c9d99a]" data-testid="notebook-backed-value">
            {backed}
          </span>
        )}
        {value && valueWords(value, myColor) && (
          <span className="text-[13px] text-muted-foreground">{valueWords(value, myColor)}</span>
        )}
        {coverage && (
          <span className="text-[13px] text-muted-foreground/70" data-testid="notebook-coverage-label">
            {coverage}
          </span>
        )}
        {sharpness && (
          <span
            className="text-[13px] text-muted-foreground/70 shrink-0"
            data-testid="notebook-sharpness"
            // Bounded by vision, like every other number here: the list was the
            // user's own. Never "only one move works".
            title="How many of the candidates I named reach this value — as far as I could see"
          >
            {sharpness}
          </span>
        )}
        <span className="flex-1" />
        <button
          type="button"
          onClick={onToggleSort}
          data-testid="notebook-sort-toggle"
          title="Display order only — the stored game and the exported PGN are unchanged"
          className="px-1.5 py-0.5 rounded hover:bg-white/10 text-muted-foreground shrink-0"
        >
          {sortByRank ? "as I rank" : "as I explored"}
        </button>
      </div>

      {/* Assessment — the human evaluation function, one keystroke per symbol. */}
      <div className="flex flex-wrap items-center gap-0.5" data-testid="notebook-assessments">
        {ASSESSMENT_KEYS.map((k) => (
          <Chip
            key={k.key}
            on={own === k.value}
            title={`${k.title} (${k.key})`}
            testId={`notebook-assess-${k.value}`}
            onClick={() => !isRoot && onSetAssessment(node.id, own === k.value ? null : k.value)}
          >
            {assessmentGlyph(k.value)}
          </Chip>
        ))}
        <Chip
          on={false}
          title="Clear my assessment (0)"
          testId="notebook-assess-clear"
          onClick={() => !isRoot && onSetAssessment(node.id, null)}
        >
          ×
        </Chip>
      </div>

      {/* Likelihood — only on the opponent's moves, because it is a judgement
          about him, not about the position. */}
      {opponentReply && (
        <div className="flex items-center gap-0.5" data-testid="notebook-likelihood">
          <span className="text-[13px] text-muted-foreground mr-1">He plays this:</span>
          {LIKELIHOOD_KEYS.map((k) => (
            <Chip
              key={k.key}
              on={node.lik === k.value}
              title={`${k.label} (${k.key})`}
              testId={`notebook-lik-${k.value}`}
              onClick={() => onSetLikelihood(node.id, node.lik === k.value ? null : k.value)}
            >
              <span className="text-[13px]">{k.label}</span>
            </Chip>
          ))}
        </div>
      )}

      {/* The decision surface: which of MY candidate next moves is best, so
          far. Everything below in the panel is the evidence feeding it (user
          2026-07-21: "I'm just trying to rank what's the best next move…then
          we have the tree below that's feeding into the best next move").
          The list ends where the user's list ends; the app has nothing to add
          to it. */}
      {showCandidates && candidates.length > 0 && (
        <div className="flex flex-col gap-1 pt-1" data-testid="notebook-candidates">
          <div className="text-[13px] uppercase tracking-wider text-muted-foreground/80">
            Best next move — my candidates
          </div>

          {judged.map((id, i) => {
            const child = tree.get(id)!;
            const cv = values.get(id);
            const words = cv ? valueWords(cv, myColor) : "";
            // Branch width, beside the confidence dots and never above them in
            // the sort: "3 likely · ●●○". A narrower branch is worth something
            // — fewer chances for a human to go wrong in it — but the count is
            // the user's own labels reflected back, so it is read, not ranked
            // on (spec 226 I).
            const width = cv ? widthLabel(cv) : "";
            return (
              <div
                key={id}
                onClick={() => onGoToNode(id)}
                data-san={child.san}
                data-testid="notebook-candidate"
                className="grid grid-cols-[1.25rem_4.5rem_auto_1fr_auto] items-baseline gap-2 px-1 py-1 rounded-sm cursor-pointer hover:bg-white/5"
              >
                <span className="font-mono text-[13px] text-muted-foreground/70 text-right">
                  {sortByRank ? `${i + 1}.` : ""}
                </span>
                {/* No NAG glyph appended here: the value badge already carries
                    it, and printing both read as two different claims. */}
                <span className="font-mono text-[15px] text-[#e8e4dd]">{child.san}</span>
                {/* No "?" — the confidence dots at the end of this same row are
                    the coverage statement, and two drawings of one number is
                    how the panel became unreadable. */}
                <NotebookBadge value={cv} marker={false} />
                <span className="text-[13px] text-muted-foreground truncate">
                  {words}
                  {child.lik && (
                    <span className="ml-1.5 text-[13px] text-amber-300/70">
                      he'd {LIKELIHOOD_KEYS.find((k) => k.value === child.lik)?.label} play it
                    </span>
                  )}
                </span>
                <span className="flex items-baseline gap-1.5 justify-end shrink-0">
                  {width && (
                    <>
                      <span
                        className="text-[13px] text-amber-300/70"
                        title={`${width} replies of his here — read beside the dots, never ranked on`}
                        data-testid="notebook-width"
                      >
                        {width}
                      </span>
                      <span className="text-[13px] text-muted-foreground/40">·</span>
                    </>
                  )}
                  <Confidence value={cv} />
                  {onCompare && judged.length > 1 && (
                    <button
                      type="button"
                      // The row itself navigates; marking a candidate for a
                      // comparison must not move the board out from under it.
                      onClick={(e) => {
                        e.stopPropagation();
                        togglePick(id);
                      }}
                      data-testid="notebook-compare-pick"
                      title="Mark this one for a head-to-head"
                      className={`px-1 rounded-sm text-[13px] leading-none transition-colors ${
                        picked.includes(id)
                          ? "text-white bg-[rgba(155,199,0,0.25)]"
                          : "text-muted-foreground/50 hover:text-foreground hover:bg-white/5"
                      }`}
                    >
                      ⚖
                    </button>
                  )}
                </span>
              </div>
            );
          })}

          {/* Appears only once the USER has marked two. The app never proposes
              a pair — choosing which comparison is worth making is choosing
              what matters in the position, and that is their job. */}
          {onCompare && picked.length === 2 && (
            <button
              type="button"
              onClick={() => onCompare(picked[0], picked[1])}
              data-testid="notebook-compare-open"
              className="mx-1 px-2 py-1 rounded-md border border-[#9bc700]/60 text-[13px] text-[#c9d99a] hover:bg-[rgba(155,199,0,0.15)] text-left"
            >
              Compare {tree.get(picked[0])?.san} and {tree.get(picked[1])?.san} side by side
            </button>
          )}

          {/* Named but never looked at — quiet, and last. These are the user's
              own moves, so listing them reveals nothing; giving them equal
              weight to a judged line is what made the list unreadable. */}
          {unjudged.length > 0 && (
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 px-1 pt-1">
              <span className="text-[13px] text-muted-foreground/70">not looked at:</span>
              {unjudged.map((id) => {
                const child = tree.get(id)!;
                return (
                  <span
                    key={id}
                    onClick={() => onGoToNode(id)}
                    data-san={child.san}
                    data-testid="notebook-candidate-unjudged"
                    className="font-mono text-[13px] text-muted-foreground hover:text-foreground cursor-pointer"
                  >
                    {child.san}
                  </span>
                );
              })}
            </div>
          )}

          {/* Below the hairline, and never under a heading that says "my":
              these are moves the app put on the board. They still carry the
              user's judgement and still feed the backup, but they are not the
              user's candidates and are not ranked among them (spec 226 C). */}
          {supplied.length > 0 && (
            <div
              className="flex flex-col gap-1 pt-1 mt-1 border-t border-white/10"
              data-testid="notebook-supplied"
            >
              <div className="text-[13px] uppercase tracking-wider text-muted-foreground/60">
                Also on the board — not my own list
              </div>
              {supplied.map((id) => {
                const child = tree.get(id)!;
                const cv = values.get(id);
                return (
                  <div
                    key={id}
                    onClick={() => onGoToNode(id)}
                    data-san={child.san}
                    data-testid="notebook-candidate-supplied"
                    className="flex items-baseline gap-2 px-1 py-1 rounded-sm cursor-pointer hover:bg-white/5"
                  >
                    <span className="font-mono text-[13px] text-muted-foreground">{child.san}</span>
                    <NotebookBadge value={cv} />
                    <span
                      className="text-[13px] text-muted-foreground/60"
                      title={
                        child.src === "played"
                          ? "Played in the game — not a move I named"
                          : "From the book, not my own list"
                      }
                    >
                      {child.src === "played" ? "played" : "book"}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Every key this panel claims — the collision test reads it. */
export const NOTEBOOK_SHORTCUTS: string[] = [
  ...ASSESSMENT_KEYS.map((k) => k.key),
  "0",
  "Backspace",
  ...LIKELIHOOD_KEYS.map((k) => k.key),
];
