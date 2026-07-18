"use client"

// "My names" editor (spec 225 follow-on): the small list of names/aliases the
// user answers to — full name, chess.com username, whatever a game's PGN might
// put in a White/Black header. When a loaded game names exactly one side, the
// board orients to the user (packages/core/identity.ts matchMyColor). Purely
// presentational: the host owns the list and its persistence (lib/identity.ts).

import { useState } from "react"
import { cleanNames } from "@chessgui/core/identity"
import { Button } from "@chessgui/ui/ui/button"
import { Input } from "@chessgui/ui/ui/input"

export function MyNamesEditor({
  names,
  onChange,
}: {
  names: string[]
  onChange: (names: string[]) => void
}) {
  const [draft, setDraft] = useState("")

  const add = () => {
    if (!draft.trim()) return
    // cleanNames owns trimming + case-insensitive dedupe (same rule as the
    // persisted store), so a duplicate is a no-op and casing stays canonical.
    onChange(cleanNames([...names, draft]))
    setDraft("")
  }

  const remove = (name: string) => onChange(names.filter((n) => n !== name))

  return (
    <div className="flex flex-col gap-2" data-testid="my-names-editor">
      <div className="flex items-baseline gap-2">
        <span className="text-sm font-semibold text-[#f6f6f6]">My names</span>
        <span className="text-xs text-muted-foreground">
          used to orient loaded games to your side
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {names.length === 0 && (
          <span className="text-xs text-muted-foreground">
            No names yet — add your name or chess.com username.
          </span>
        )}
        {names.map((name) => (
          <span
            key={name}
            data-testid={`my-name-${name}`}
            className="inline-flex items-center gap-1 rounded bg-[#2a2825] border border-[#3a3835] px-2 py-0.5 text-xs text-[#bababa]"
          >
            {name}
            <button
              type="button"
              onClick={() => remove(name)}
              aria-label={`Remove ${name}`}
              className="text-muted-foreground hover:text-red-300"
            >
              &times;
            </button>
          </span>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              add()
            }
          }}
          placeholder="Your name or username"
          spellCheck={false}
          data-testid="my-names-input"
          className="h-8 max-w-xs bg-[#2a2825] border-[#3a3835] text-xs"
        />
        <Button
          size="sm"
          variant="outline"
          className="h-8 px-3 text-xs"
          disabled={!draft.trim()}
          onClick={add}
          data-testid="my-names-add"
        >
          Add
        </Button>
      </div>
    </div>
  )
}
