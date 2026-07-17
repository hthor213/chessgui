"use client"

import { useState } from "react"
import { pickFile } from "@/lib/dialog"
import { Button } from "@chessgui/ui/ui/button"
import { Input } from "@chessgui/ui/ui/input"
import { Switch } from "@chessgui/ui/ui/switch"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@chessgui/ui/ui/dialog"
import {
  ANALYSIS_DEPTH_MAX,
  ANALYSIS_DEPTH_MIN,
  ANALYSIS_MOVETIME_MAX_MS,
  ANALYSIS_MOVETIME_MIN_MS,
  CONTEMPT_MAX,
  CONTEMPT_MIN,
  defaultEnginePath,
  HASH_MAX,
  HASH_MIN,
  MULTI_PV_MAX,
  MULTI_PV_MIN,
  maxThreads,
  sanitizeCustomOptions,
  type AnalysisLimitMode,
  type EngineSettings,
} from "@/lib/engine-settings"

interface EngineSettingsDialogProps {
  settings: EngineSettings;
  onSave: (next: EngineSettings) => void;
  /** Currently selected engine binary (spec 011). */
  enginePath: string;
  /** Called on Save when the user picked a different binary. */
  onEnginePathChange: (path: string) => void;
  /** Element that opens the dialog (e.g. a gear icon button). */
  trigger: React.ReactNode;
}

// Clamp a number input's value; an empty/invalid field falls back.
function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function SettingRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex flex-col">
        <span className="text-sm text-foreground">{label}</span>
        <span className="text-xs text-muted-foreground">{hint}</span>
      </div>
      {children}
    </div>
  );
}

export function EngineSettingsDialog({
  settings,
  onSave,
  enginePath,
  onEnginePathChange,
  trigger,
}: EngineSettingsDialogProps) {
  const [open, setOpen] = useState(false);
  // Draft edited in the dialog; committed on Save so half-typed values
  // never restart the engine search.
  const [draft, setDraft] = useState<EngineSettings>(settings);
  const [draftPath, setDraftPath] = useState<string>(enginePath);
  const cores = maxThreads();

  const handleOpenChange = (next: boolean) => {
    if (next) {
      setDraft(settings); // re-sync drafts each time the dialog opens
      setDraftPath(enginePath);
    }
    setOpen(next);
  };

  const handleBrowse = async () => {
    // Native file picker (lib/dialog seam). No extension filter — UCI
    // engine binaries have none on macOS.
    const picked = await pickFile({ title: "Select UCI engine binary" });
    if (picked) setDraftPath(picked);
  };

  const handleSave = () => {
    onSave({
      ...draft,
      hash: clamp(draft.hash, HASH_MIN, HASH_MAX, settings.hash),
      threads: clamp(draft.threads, 1, cores, settings.threads),
      multiPv: clamp(draft.multiPv, MULTI_PV_MIN, MULTI_PV_MAX, settings.multiPv),
      analysisDepth: clamp(
        draft.analysisDepth, ANALYSIS_DEPTH_MIN, ANALYSIS_DEPTH_MAX, settings.analysisDepth),
      analysisMoveTimeMs: clamp(
        draft.analysisMoveTimeMs, ANALYSIS_MOVETIME_MIN_MS, ANALYSIS_MOVETIME_MAX_MS, settings.analysisMoveTimeMs),
      contempt: clamp(draft.contempt, CONTEMPT_MIN, CONTEMPT_MAX, settings.contempt),
      // Drops nameless rows and strips line breaks (UCI injection guard).
      customOptions: sanitizeCustomOptions(draft.customOptions),
    });
    if (draftPath !== enginePath) onEnginePathChange(draftPath);
    setOpen(false);
  };

  const setCustomOption = (index: number, patch: Partial<{ name: string; value: string }>) => {
    setDraft({
      ...draft,
      customOptions: draft.customOptions.map((opt, i) => (i === index ? { ...opt, ...patch } : opt)),
    });
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-w-sm bg-[#1e1c19] border-[#2a2825] max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Engine settings</DialogTitle>
          <DialogDescription>
            Applied to the engine immediately and remembered across restarts.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-4">
              <div className="flex flex-col">
                <span className="text-sm text-foreground">Engine</span>
                <span className="text-xs text-muted-foreground">UCI binary to run</span>
              </div>
              <div className="flex gap-2">
                {draftPath !== defaultEnginePath() && (
                  <Button variant="ghost" size="sm" onClick={() => setDraftPath(defaultEnginePath())}>
                    Default
                  </Button>
                )}
                <Button variant="outline" size="sm" onClick={handleBrowse}>
                  Browse…
                </Button>
              </div>
            </div>
            <span className="text-xs font-mono text-muted-foreground truncate" title={draftPath}>
              {draftPath}
            </span>
          </div>

          <SettingRow label="Hash" hint={`Memory in MB (${HASH_MIN}–${HASH_MAX})`}>
            <Input
              type="number"
              className="w-24 text-right font-mono"
              min={HASH_MIN}
              max={HASH_MAX}
              step={64}
              value={Number.isFinite(draft.hash) ? draft.hash : ""}
              onChange={(e) => setDraft({ ...draft, hash: e.target.valueAsNumber })}
            />
          </SettingRow>

          <SettingRow label="Threads" hint={`CPU threads (1–${cores})`}>
            <Input
              type="number"
              className="w-24 text-right font-mono"
              min={1}
              max={cores}
              value={Number.isFinite(draft.threads) ? draft.threads : ""}
              onChange={(e) => setDraft({ ...draft, threads: e.target.valueAsNumber })}
            />
          </SettingRow>

          <SettingRow label="Lines" hint={`MultiPV shown in analysis (${MULTI_PV_MIN}–${MULTI_PV_MAX})`}>
            <Input
              type="number"
              className="w-24 text-right font-mono"
              min={MULTI_PV_MIN}
              max={MULTI_PV_MAX}
              value={Number.isFinite(draft.multiPv) ? draft.multiPv : ""}
              onChange={(e) => setDraft({ ...draft, multiPv: e.target.valueAsNumber })}
            />
          </SettingRow>

          {/* Analysis search limit (spec 011): infinite / depth / time-per-move. */}
          <SettingRow label="Analysis limit" hint="How long each analysis search runs">
            <select
              data-testid="analysis-limit-select"
              className="bg-background border border-input rounded-md px-2 py-1 text-xs text-foreground w-24"
              value={draft.analysisMode}
              onChange={(e) => setDraft({ ...draft, analysisMode: e.target.value as AnalysisLimitMode })}
            >
              <option value="infinite">Infinite</option>
              <option value="depth">Depth</option>
              <option value="movetime">Time</option>
            </select>
          </SettingRow>

          {draft.analysisMode === "depth" && (
            <SettingRow label="Depth" hint={`Stop at depth (${ANALYSIS_DEPTH_MIN}–${ANALYSIS_DEPTH_MAX})`}>
              <Input
                type="number"
                data-testid="analysis-depth-input"
                className="w-24 text-right font-mono"
                min={ANALYSIS_DEPTH_MIN}
                max={ANALYSIS_DEPTH_MAX}
                value={Number.isFinite(draft.analysisDepth) ? draft.analysisDepth : ""}
                onChange={(e) => setDraft({ ...draft, analysisDepth: e.target.valueAsNumber })}
              />
            </SettingRow>
          )}

          {draft.analysisMode === "movetime" && (
            <SettingRow
              label="Time"
              hint={`Seconds per position (${ANALYSIS_MOVETIME_MIN_MS / 1000}–${ANALYSIS_MOVETIME_MAX_MS / 1000})`}
            >
              <Input
                type="number"
                data-testid="analysis-movetime-input"
                className="w-24 text-right font-mono"
                min={ANALYSIS_MOVETIME_MIN_MS / 1000}
                max={ANALYSIS_MOVETIME_MAX_MS / 1000}
                step={0.5}
                value={Number.isFinite(draft.analysisMoveTimeMs) ? draft.analysisMoveTimeMs / 1000 : ""}
                onChange={(e) =>
                  setDraft({ ...draft, analysisMoveTimeMs: Math.round(e.target.valueAsNumber * 1000) })
                }
              />
            </SettingRow>
          )}

          <SettingRow label="Contempt" hint={`UCI Contempt (${CONTEMPT_MIN}–${CONTEMPT_MAX}, 0 = engine default)`}>
            <Input
              type="number"
              data-testid="contempt-input"
              className="w-24 text-right font-mono"
              min={CONTEMPT_MIN}
              max={CONTEMPT_MAX}
              value={Number.isFinite(draft.contempt) ? draft.contempt : ""}
              onChange={(e) => setDraft({ ...draft, contempt: e.target.valueAsNumber })}
            />
          </SettingRow>

          {/* Board coordinate display (spec 001) — not an engine option, but
              this dialog is the app's settings surface. Default ON. */}
          <SettingRow label="Coordinates" hint="Rank/file labels around the board">
            <Switch
              data-testid="show-coordinates-switch"
              checked={draft.showCoordinates}
              onCheckedChange={(checked) => setDraft({ ...draft, showCoordinates: checked })}
              className="data-[state=checked]:bg-blue-600 data-[state=unchecked]:bg-zinc-600"
            />
          </SettingRow>

          {/* Free-form UCI options (spec 011) — sent verbatim as
              `setoption name <name> value <value>` on engine start. */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-4">
              <div className="flex flex-col">
                <span className="text-sm text-foreground">Custom UCI options</span>
                <span className="text-xs text-muted-foreground">
                  Sent as setoption on engine start (empty value = button option)
                </span>
              </div>
              <Button
                variant="outline"
                size="sm"
                data-testid="add-custom-option"
                onClick={() =>
                  setDraft({ ...draft, customOptions: [...draft.customOptions, { name: "", value: "" }] })
                }
              >
                Add
              </Button>
            </div>
            {draft.customOptions.map((opt, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <Input
                  placeholder="Name"
                  data-testid={`custom-option-name-${i}`}
                  className="h-7 flex-1 font-mono text-xs"
                  value={opt.name}
                  onChange={(e) => setCustomOption(i, { name: e.target.value })}
                />
                <Input
                  placeholder="Value"
                  data-testid={`custom-option-value-${i}`}
                  className="h-7 w-24 font-mono text-xs"
                  value={opt.value}
                  onChange={(e) => setCustomOption(i, { value: e.target.value })}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 text-red-400 hover:text-red-300"
                  title="Remove option"
                  onClick={() =>
                    setDraft({ ...draft, customOptions: draft.customOptions.filter((_, j) => j !== i) })
                  }
                >
                  <span className="text-xs">{"✕"}</span>
                </Button>
              </div>
            ))}
          </div>

          {/* Credits (spec 213/218) — the projects this app is built on. This
              dialog is the app's settings surface, so attribution lives here. */}
          <div className="flex flex-col gap-1 border-t border-[#2a2825] pt-3">
            <span className="text-sm text-foreground">About</span>
            <p className="text-xs text-muted-foreground">
              ChessGUI is GPL-3.0. Built on Stockfish (analysis engine), Maia
              human-move models (CSSLab, University of Toronto — maiachess.com)
              running on lc0 (the LCZero project), Chessground (lichess.org,
              GPL-3.0), and chessops.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button size="sm" className="bg-green-600 hover:bg-green-700 text-white" onClick={handleSave}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
