"use client"

// About Fair Play (spec 227): a plain-language statement of the app's fair-play
// promise, reachable from the Lessons surface with no active game. Static copy
// only — imports nothing that reads live-game state, so it stays on the right
// side of the D5 fair-play guard.

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@chessgui/ui/ui/dialog"
import { Button } from "@chessgui/ui/ui/button"

// Approved copy (user, 2026-07-24) — leads with the one-line mental model.
const PARAGRAPHS: string[] = [
  "ChessGUI gives you no engine, no evaluation, and no “best move.” You think; the app simply records the game.",
  "Training is different. Lessons, puzzles, opening courses, and master games can include engine evaluations and suggested moves, because those positions are public study material—not a game you’re currently playing.",
  "Training also cannot be used as a back door into engine analysis. A course or computer-play line always begins from a public position. You can set up another position by hand, but if it matches a game you currently have in progress, ChessGUI will not analyze it.",
  "No app can stop someone who is determined to cheat. In correspondence chess, anyone has enough time to consult an outside engine. These safeguards are not meant to solve that problem. They are here to make the honest path the natural one—and to ensure you never break your own promise by accident.",
]

export function FairPlayAbout() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground"
          data-testid="about-fair-play-trigger"
        >
          About Fair Play
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg" data-testid="about-fair-play-dialog">
        <DialogHeader>
          <DialogTitle>Fair Play</DialogTitle>
          <DialogDescription className="text-foreground text-base pt-1">
            When you&rsquo;re playing a real game, you&rsquo;re on your own&mdash;with a notebook.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3 text-sm text-muted-foreground leading-relaxed">
          {PARAGRAPHS.map((p, i) => (
            <p key={i}>{p}</p>
          ))}
          <p className="text-foreground font-medium">
            If the position comes from a live game, ChessGUI stays out of it. That&rsquo;s the whole rule.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  )
}
