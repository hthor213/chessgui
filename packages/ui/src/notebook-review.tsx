"use client";

// Post-game review (spec 226 H) — the reading surface for the diagnosis.
//
// This is where the refusal pays off. Because the app never supplied the legal
// moves, the record says what the player CONSIDERED before they saw the answer,
// and laying the engine's verdict beside it splits "I played badly" into three
// separately trainable failures: a move that was never on the list (vision), a
// move that was listed and judged wrongly (evaluation), a reply predicted
// wrongly (reading this opponent). Different skills, different remedies.
//
// Four things this component holds to:
//
//  1. It is a READING SURFACE. It computes nothing about chess. The diagnosis
//     arrives finished from @chessgui/core/notebook-diagnosis; this file joins
//     it to the training record for display and stops there.
//  2. It shows the player their OWN WORDS back. The preference reasons and tags
//     (spec 226 I) are the most valuable thing in the record — a diagnosis that
//     printed only centipawns would throw away the half that says WHY.
//  3. It never dresses a handful of observations as a tendency. One game is one
//     game; the counts are printed as the raw counts they are, with the pure
//     module's own note underneath, and no word like "weakness" appears.
//  4. Nothing renders over the board, and nothing is smaller than 13px.

import { useState } from "react";
import { Board } from "@chessgui/ui/board";
import { Card } from "@chessgui/ui/ui/card";
import type { Key } from "@lichess-org/chessground/types";
import type { Likelihood } from "@chessgui/core/game-tree";
import { assessmentGlyph } from "@chessgui/core/notebook";
import type { Assessment } from "@chessgui/core/notebook";
import type {
  DecisionDiagnosis,
  Failure,
  FailureClass,
  GameDiagnosis,
} from "@chessgui/core/notebook-diagnosis";
import { classTotal, failuresTotal, FAILURE_SEVERITY } from "@chessgui/core/notebook-diagnosis";
import type {
  CandidateRecord,
  DecisionRecord,
  TrainingRecord,
} from "@chessgui/core/training-record";

// The board here is a still: a review is reading, not playing. An empty
// destination map is the whole of what this file knows about legality.
const NO_MOVES = new Map<Key, Key[]>();

/** What each failure is called, and what it trains. Plain words, because the
 *  point of separating them is that the remedies differ. */
export const FAILURE_LABELS: Record<FailureClass, { name: string; trains: string }> = {
  "blind-spot": { name: "Blind spot", trains: "seeing the moves" },
  misjudgement: { name: "Misjudgement", trains: "judging the position" },
  "selection-error": { name: "Selection error", trains: "choosing what I already judged" },
  "opponent-model": { name: "Opponent model", trains: "reading this opponent" },
};

const LIKELIHOOD_WORDS: Record<Likelihood, string> = {
  3: "likely",
  2: "possible",
  1: "unlikely",
};

/** Centipawns in the units chess players read. */
export function pawns(cp: number): string {
  const p = Math.abs(cp) / 100;
  return `${cp < 0 ? "−" : ""}${p.toFixed(2)}`;
}

/**
 * One failure as a sentence, in the player's own first person.
 *
 * First person because the record is theirs: "I marked …h6 unlikely and he
 * played it" is a thing to work on; "the opponent-model prediction failed" is a
 * report about somebody else.
 */
export function failureText(f: Failure): string {
  switch (f.class) {
    case "blind-spot":
      return f.san
        ? `${f.san} was never on my list — the best move I named gave up ${pawns(f.cp)}.`
        : `Something better than anything I named existed — my best candidate gave up ${pawns(
            f.cp,
          )}.`;
    case "misjudgement":
      // `human` is what they CONCLUDED, not the first symbol they wrote — a
      // revised judgement is the discipline working, and grading the abandoned
      // impression would flag the players who use the notebook properly. When
      // the two differ, the revision is reported as the separate fact it is.
      return `I judged ${f.san} ${assessmentGlyph(f.human)}${
        f.firstImpression !== undefined
          ? ` (my first impression was ${assessmentGlyph(f.firstImpression)}; my search moved it)`
          : ""
      }; the engine has it ${assessmentGlyph(f.engine)} (${pawns(f.cp)}). ${
        f.overrated ? "I flattered it." : "I was harder on it than it deserved."
      }`;
    case "selection-error":
      return `I had ${f.san} on the list and judged it right, and played ${f.playedSan} anyway — ${pawns(
        f.cp,
      )} worse.`;
    case "opponent-model":
      return f.kind === "unlikely-played"
        ? `I marked ${f.san} unlikely and he played it.${
            f.expectedSan ? ` I was expecting ${f.expectedSan}.` : ""
          }${f.cp !== null ? ` ${pawns(f.cp)} for me against what I expected.` : ""}`
        : `I expected ${f.expectedSan}; he played ${f.san}.${
            f.cp !== null ? ` ${pawns(f.cp)} for me against what I expected.` : ""
          }`;
  }
}

/**
 * The counts, as counts. Never a verdict.
 *
 * "2 blind spots" is a fact about this game; "you have a blind-spot problem" is
 * a claim about the player that one game cannot support, and only
 * `aggregateDiagnoses` over enough games is allowed to make it (spec 226 H).
 */
export function countsSummary(d: GameDiagnosis): string {
  // Split by side, because the pure module keeps them separable and pooling
  // them here would undo that at the last step: a blind spot at his decisions
  // is a failure to enumerate HIS replies, which trains something different
  // from generating my own candidates (spec 226 H).
  const parts = FAILURE_SEVERITY.filter((c) => classTotal(d.counts, c) > 0).map((c) => {
    const { mine, his } = d.counts[c];
    const where = mine > 0 && his > 0 ? ` (${mine} mine, ${his} his)` : his > 0 ? " (his)" : "";
    return `${mine + his} × ${FAILURE_LABELS[c].name.toLowerCase()}${where}`;
  });
  const total = failuresTotal(d.counts);
  if (total === 0) {
    return `Nothing to flag across ${d.scoredDecisions} reviewed ${
      d.scoredDecisions === 1 ? "decision" : "decisions"
    }.`;
  }
  return `${parts.join(" · ")} — ${total} ${
    total === 1 ? "observation" : "observations"
  } across ${d.scoredDecisions} reviewed ${
    d.scoredDecisions === 1 ? "decision" : "decisions"
  }.`;
}

/** "12… Qb6" — the decision's place in the game, from the recorded line. */
export function decisionLabel(d: DecisionDiagnosis): string {
  const move = Math.floor(d.ply / 2) + 1;
  const dots = d.ply % 2 === 0 ? "." : "…";
  const last = d.line.length > 0 ? d.line[d.line.length - 1] : "";
  const at = d.playedSan ? ` ${d.playedSan}` : "";
  return `${move}${dots}${at || (last ? ` after ${last}` : "")}`;
}

function CandidateChip({ c, missed }: { c: CandidateRecord; missed: boolean }) {
  return (
    <span
      className={`inline-flex items-baseline gap-1 rounded-sm px-1.5 py-px text-[13px] font-mono ${
        missed ? "bg-white/10 text-[#e8e4dd]" : "bg-white/5 text-muted-foreground"
      }`}
      data-testid="review-candidate"
    >
      {c.san}
      {c.assessment !== null && (
        <span className="text-[#c9d99a]">{assessmentGlyph(c.assessment as Assessment)}</span>
      )}
      {c.likelihood !== null && (
        <span className="opacity-70">{LIKELIHOOD_WORDS[c.likelihood]}</span>
      )}
    </span>
  );
}

/**
 * The player's own words at this decision (spec 226 I).
 *
 * Rendered whether or not the engine disagreed with them, because the reason a
 * player gives for a choice is the training data — the cases where the engine
 * later disagrees are what locate where their taste is systematically wrong,
 * and that only works if the words are still there to read.
 */
function OwnWords({ decision }: { decision: DecisionRecord }) {
  if (decision.preferences.length === 0) return null;
  return (
    <div className="mt-2 flex flex-col gap-1" data-testid="review-own-words">
      {decision.preferences.map((p, i) => (
        <p key={i} className="text-[13px] text-[#d8d4cc] leading-snug">
          <span className="text-muted-foreground">I preferred </span>
          <span className="font-mono">{p.winnerSan}</span>
          <span className="text-muted-foreground"> over </span>
          <span className="font-mono">{p.loserSan}</span>
          {p.reason && <span> — &ldquo;{p.reason}&rdquo;</span>}
          {p.tags.length > 0 && (
            <span className="text-muted-foreground"> [{p.tags.join(", ")}]</span>
          )}
        </p>
      ))}
    </div>
  );
}

function DecisionCard({
  d,
  record,
  selected,
  onSelect,
}: {
  d: DecisionDiagnosis;
  record: DecisionRecord | undefined;
  selected: boolean;
  onSelect: () => void;
}) {
  const missed = new Set(
    d.failures.flatMap((f) => (f.class === "blind-spot" && f.san ? [f.san] : [])),
  );
  return (
    <button
      type="button"
      onClick={onSelect}
      data-testid={`review-decision-${d.nodeId}`}
      className={`w-full text-left rounded-md border px-3 py-2 transition-colors ${
        selected
          ? "border-[#9bc700] bg-[rgba(155,199,0,0.08)]"
          : "border-white/10 hover:bg-white/5"
      }`}
    >
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="font-mono text-[15px] text-[#e8e4dd]">{decisionLabel(d)}</span>
        <span className="text-[13px] text-muted-foreground">
          {d.mine ? "my move" : "his move"}
        </span>
        {d.playedLossCp !== null && d.playedLossCp > 0 && (
          <span className="text-[13px] text-muted-foreground">
            cost {pawns(d.playedLossCp)}
          </span>
        )}
        {record && record.coverage.named > 1 && (
          <span className="text-[13px] text-muted-foreground">
            {record.coverage.examined} of my {record.coverage.named} candidates
            {record.width.likelyReplies > 0 && ` · ${record.width.likelyReplies} likely`}
          </span>
        )}
      </div>

      {/* What I considered — their handwriting, never topped up. */}
      {record && record.candidates.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {record.candidates.map((c) => (
            <CandidateChip key={c.nodeId} c={c} missed={missed.has(c.san)} />
          ))}
        </div>
      )}

      {/* What went wrong, most fundamental first. Both a blind spot and a
          misjudgement can be true at one decision — you cannot judge a move you
          never saw — so both are printed rather than one being swallowed. */}
      <div className="mt-2 flex flex-col gap-1">
        {d.failures.map((f, i) => (
          <p key={i} className="text-[13px] leading-snug" data-testid={`review-failure-${f.class}`}>
            <span className="text-amber-300 font-medium">{FAILURE_LABELS[f.class].name}</span>
            <span className="text-muted-foreground"> · trains {FAILURE_LABELS[f.class].trains}</span>
            <br />
            <span className="text-[#e8e4dd]">{failureText(f)}</span>
          </p>
        ))}
      </div>

      {record && <OwnWords decision={record} />}
    </button>
  );
}

export interface NotebookReviewProps {
  /** "vs dad · as hjaltth" — the game this review is about. */
  title: string;
  myColor: "white" | "black";
  training: TrainingRecord | null;
  diagnosis: GameDiagnosis | null;
  loading?: boolean;
  running?: boolean;
  done?: number;
  total?: number;
  /** Positions the engine answered for, and positions the run aimed at. When
   *  they differ the review is PARTIAL and says so above the counts. */
  evaluated?: number;
  targeted?: number;
  error?: string | null;
  onRun: () => void;
  onStop: () => void;
  onClose: () => void;
  coordinates?: boolean;
}

export function NotebookReview({
  title,
  myColor,
  training,
  diagnosis,
  loading = false,
  running = false,
  done = 0,
  total = 0,
  evaluated = 0,
  targeted = 0,
  error = null,
  onRun,
  onStop,
  onClose,
  coordinates = true,
}: NotebookReviewProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const byNode = new Map((training?.decisions ?? []).map((d) => [d.nodeId, d]));
  const flagged = (diagnosis?.decisions ?? []).filter((d) => d.failures.length > 0);
  const selected =
    flagged.find((d) => d.nodeId === selectedId) ?? flagged[0] ?? null;
  const boardFen = selected ? byNode.get(selected.nodeId)?.fen ?? selected.fen : null;

  // Every preference recorded this game, whether or not the engine had anything
  // to say about that decision. The reasons outlive the diagnosis.
  const allPreferences = (training?.decisions ?? []).flatMap((d) => d.preferences);

  return (
    <div
      className="flex-1 flex flex-col min-h-0 gap-3 p-3 lg:p-6 text-[13px]"
      data-testid="notebook-review"
    >
      <div className="flex items-baseline gap-3 shrink-0 flex-wrap">
        <span className="text-[15px] font-semibold text-[#e8e4dd]">Post-game review</span>
        <span className="text-[13px] text-muted-foreground">{title}</span>
        <span className="flex-1" />
        {training && !running && (
          <button
            type="button"
            onClick={onRun}
            data-testid="review-run"
            title="Let the engine look at the same positions I did"
            className="px-3 py-1.5 rounded-md text-[13px] border border-[#9bc700] text-[#c9d99a] hover:bg-[rgba(155,199,0,0.15)]"
          >
            {diagnosis ? "Review again" : "Run the engine over my thinking"}
          </button>
        )}
        {running && (
          <button
            type="button"
            onClick={onStop}
            data-testid="review-stop"
            className="px-3 py-1.5 rounded-md text-[13px] border border-input text-muted-foreground hover:text-foreground hover:bg-white/5"
          >
            Stop ({done}/{total})
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          data-testid="review-close"
          className="px-2 py-1 rounded-md border border-input text-muted-foreground hover:text-foreground hover:bg-white/5"
        >
          ← Back
        </button>
      </div>

      {loading && <p className="text-[13px] text-muted-foreground">Reading the notebook…</p>}
      {error && (
        <p className="text-[13px] text-amber-300" data-testid="review-error">
          {error}
        </p>
      )}

      {/* A truncated run is labelled as one. Everything below is drawn from
          the positions the engine reached, and a review that stopped early
          renders exactly like a complete one unless it says otherwise. */}
      {diagnosis && !running && targeted > 0 && evaluated < targeted && (
        <p className="text-[13px] text-amber-300" data-testid="review-partial">
          Partial review — the engine answered for {evaluated} of {targeted} positions.
          Decisions it did not reach are not counted, and a decision whose candidates were
          only partly searched reports no blind spot at all.
        </p>
      )}

      {/* The honest headline: counts, then the pure module's own note saying
          what one game is worth. Both, always — the note is not a footnote. */}
      {diagnosis && (
        <Card
          className="shrink-0 bg-card/50 border-white/10 px-3 py-2"
          data-testid="review-summary"
        >
          <p className="text-sm text-[#e8e4dd]">{countsSummary(diagnosis)}</p>
          <p className="mt-1 text-[13px] text-muted-foreground">{diagnosis.note}</p>
        </Card>
      )}

      <div className="flex-1 grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] gap-4 lg:gap-6 min-h-0">
        {/* The position under discussion. Nothing is drawn on it: an arrow to
            the move I missed would be the app playing chess for me, which is
            the one thing this whole feature is built to avoid. */}
        <div className="flex flex-col min-h-0 gap-2 items-center">
          {boardFen ? (
            <>
              <div className="flex-1 min-h-0 w-full flex items-start justify-center overflow-hidden">
                <Board
                  fen={boardFen}
                  orientation={myColor}
                  onMove={() => {}}
                  legalMoves={NO_MOVES}
                  viewOnly
                  coordinates={coordinates}
                  reserveBelow={0}
                />
              </div>
              {selected && (
                <p
                  className="shrink-0 w-full text-center text-[13px] text-muted-foreground font-mono leading-snug"
                  data-testid="review-line"
                >
                  {selected.line.join(" ") || "the starting position"}
                </p>
              )}
            </>
          ) : (
            <p className="text-[13px] text-muted-foreground">
              {training
                ? "The board fills in once a decision is selected."
                : "Nothing was written down while this game was played."}
            </p>
          )}
        </div>

        <div className="flex flex-col min-h-0 gap-2 overflow-y-auto pr-1">
          {diagnosis && flagged.length === 0 && (
            <p className="text-[13px] text-muted-foreground">
              The engine found nothing worth flagging in what I wrote down.
            </p>
          )}
          {flagged.map((d) => (
            <DecisionCard
              key={d.nodeId}
              d={d}
              record={byNode.get(d.nodeId)}
              selected={selected?.nodeId === d.nodeId}
              onSelect={() => setSelectedId(d.nodeId)}
            />
          ))}

          {/* The reasons, gathered — the half of the record no engine produced. */}
          {allPreferences.length > 0 && (
            <div className="mt-2 border-t border-white/10 pt-2" data-testid="review-reasons">
              <p className="text-[13px] text-muted-foreground">
                Why I chose what I chose, this game:
              </p>
              {allPreferences.map((p, i) => (
                <p key={i} className="mt-1 text-[13px] text-[#d8d4cc] leading-snug">
                  <span className="font-mono">{p.winnerSan}</span>
                  <span className="text-muted-foreground"> over </span>
                  <span className="font-mono">{p.loserSan}</span>
                  {p.reason && <span> — &ldquo;{p.reason}&rdquo;</span>}
                  {p.tags.length > 0 && (
                    <span className="text-muted-foreground"> [{p.tags.join(", ")}]</span>
                  )}
                </p>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
