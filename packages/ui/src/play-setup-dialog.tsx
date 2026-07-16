"use client"

import { useState } from "react"
import { Button } from "@chessgui/ui/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@chessgui/ui/ui/dialog"
import { Input } from "@chessgui/ui/ui/input"
import {
  CUSTOM_BASE_MAX,
  CUSTOM_BASE_MIN,
  CUSTOM_INC_MAX,
  CUSTOM_INC_MIN,
  customClockPreset,
  isValidCustomTimeControl,
  loadCustomTimeControl,
  PLAY_CLOCK_PRESETS,
  saveCustomTimeControl,
  type CustomTimeControl,
  type PlayClockPreset,
} from "@/lib/play-clock"

type ColorChoice = "white" | "random" | "black"

interface PlaySetupDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Start the game: color already resolved (random picked here), preset
   *  from PLAY_CLOCK_PRESETS or a validated custom TC (untimed = no clock). */
  onStart: (color: "white" | "black", preset: PlayClockPreset) => void
}

/** One selectable chip (color or time control). */
function ChoiceChip({
  selected,
  onClick,
  testId,
  children,
}: {
  selected: boolean
  onClick: () => void
  testId?: string
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      data-testid={testId}
      className={`px-3 py-1.5 text-sm rounded-md border transition-colors ${
        selected
          ? "bg-blue-600 text-white border-blue-500 font-medium"
          : "bg-background text-muted-foreground border-input hover:text-foreground hover:bg-white/5"
      }`}
    >
      {children}
    </button>
  )
}

/**
 * Game-start setup for Play vs engine (spec 011): pick a color (board flips
 * to match — page.tsx orients to playerColor) and a time control. Timed
 * presets run a real local clock for BOTH sides, flag = loss; untimed keeps
 * the spec 216 pace-only behavior.
 */
export function PlaySetupDialog({ open, onOpenChange, onStart }: PlaySetupDialogProps) {
  const [color, setColor] = useState<ColorChoice>("white")
  const [presetId, setPresetId] = useState<string>("untimed")
  // Custom TC fields (spec 011): seeded from the last game started with one
  // (storage seam); saved back on Start so the values survive restarts.
  const [custom, setCustom] = useState<CustomTimeControl>(() => loadCustomTimeControl())

  const customValid = isValidCustomTimeControl(custom)
  const startDisabled = presetId === "custom" && !customValid

  const handleStart = () => {
    let preset: PlayClockPreset
    if (presetId === "custom") {
      if (!customValid) return
      saveCustomTimeControl(custom)
      preset = customClockPreset(custom)
    } else {
      preset =
        PLAY_CLOCK_PRESETS.find((p) => p.id === presetId) ?? PLAY_CLOCK_PRESETS[0]
    }
    const resolved =
      color === "random" ? (Math.random() < 0.5 ? "white" : "black") : color
    onStart(resolved, preset)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm bg-[#1e1c19] border-[#2a2825]">
        <DialogHeader>
          <DialogTitle>Play vs engine</DialogTitle>
          <DialogDescription>
            Pick your color and a time control. Timed games are lost on the
            flag — the increment is added after every move.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          <div className="flex flex-col gap-1.5">
            <span className="text-sm text-foreground">Your color</span>
            <div className="flex gap-2">
              <ChoiceChip
                selected={color === "white"}
                onClick={() => setColor("white")}
                testId="play-color-white"
              >
                White
              </ChoiceChip>
              <ChoiceChip
                selected={color === "random"}
                onClick={() => setColor("random")}
                testId="play-color-random"
              >
                Random
              </ChoiceChip>
              <ChoiceChip
                selected={color === "black"}
                onClick={() => setColor("black")}
                testId="play-color-black"
              >
                Black
              </ChoiceChip>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-sm text-foreground">Time control</span>
            <div className="flex flex-wrap gap-2">
              {PLAY_CLOCK_PRESETS.map((p) => (
                <ChoiceChip
                  key={p.id}
                  selected={presetId === p.id}
                  onClick={() => setPresetId(p.id)}
                  testId={`play-preset-${p.id}`}
                >
                  {p.label}
                </ChoiceChip>
              ))}
              <ChoiceChip
                selected={presetId === "custom"}
                onClick={() => setPresetId("custom")}
                testId="play-preset-custom"
              >
                Custom
              </ChoiceChip>
            </div>
            {presetId === "custom" && (
              <div className="flex items-center gap-2 pt-1">
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  Minutes
                  <Input
                    type="number"
                    data-testid="play-custom-base"
                    className="h-7 w-16 text-right font-mono"
                    min={CUSTOM_BASE_MIN}
                    max={CUSTOM_BASE_MAX}
                    value={Number.isFinite(custom.baseMin) ? custom.baseMin : ""}
                    onChange={(e) => setCustom({ ...custom, baseMin: e.target.valueAsNumber })}
                  />
                </label>
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  Increment (s)
                  <Input
                    type="number"
                    data-testid="play-custom-inc"
                    className="h-7 w-16 text-right font-mono"
                    min={CUSTOM_INC_MIN}
                    max={CUSTOM_INC_MAX}
                    value={Number.isFinite(custom.incS) ? custom.incS : ""}
                    onChange={(e) => setCustom({ ...custom, incS: e.target.valueAsNumber })}
                  />
                </label>
              </div>
            )}
            {presetId === "custom" && !customValid && (
              <span className="text-xs text-red-400" data-testid="play-custom-error">
                Base {CUSTOM_BASE_MIN}–{CUSTOM_BASE_MAX} whole minutes, increment{" "}
                {CUSTOM_INC_MIN}–{CUSTOM_INC_MAX} whole seconds.
              </span>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            className="bg-green-600 hover:bg-green-700 text-white"
            onClick={handleStart}
            disabled={startDisabled}
            data-testid="play-setup-start"
          >
            Start game
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
