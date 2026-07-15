"use client"

// Persona Arena disclosure screen (spec 217 Transparency) — shown once,
// before a player's first game. Exact wording lives in lib/arena-disclosure.ts
// so the verbatim text has exactly one home.

import { Button } from "@/components/ui/button"
import { ARENA_DISCLOSURE_NOTE, ARENA_DISCLOSURE_TEXT } from "@/lib/arena-disclosure"

export function DisclosureScreen({ onAck }: { onAck: () => void }) {
  return (
    <div className="flex-1 flex items-center justify-center p-6" data-testid="arena-disclosure">
      <div className="max-w-md w-full space-y-5 text-center">
        <h1 className="text-2xl font-bold">Persona Arena</h1>
        <p className="text-lg text-foreground leading-relaxed" data-testid="arena-disclosure-text">
          &ldquo;{ARENA_DISCLOSURE_TEXT}&rdquo;
        </p>
        <p className="text-sm text-muted-foreground">{ARENA_DISCLOSURE_NOTE}</p>
        <Button size="lg" onClick={onAck} data-testid="arena-disclosure-ack">
          I understand — take me to the arena
        </Button>
      </div>
    </div>
  )
}
