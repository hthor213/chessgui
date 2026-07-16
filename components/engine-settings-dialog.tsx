"use client"

import { useState } from "react"
import { pickFile } from "@/lib/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  DEFAULT_ENGINE_PATH,
  HASH_MAX,
  HASH_MIN,
  MULTI_PV_MAX,
  MULTI_PV_MIN,
  maxThreads,
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
    });
    if (draftPath !== enginePath) onEnginePathChange(draftPath);
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-w-sm bg-[#1e1c19] border-[#2a2825]">
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
                {draftPath !== DEFAULT_ENGINE_PATH && (
                  <Button variant="ghost" size="sm" onClick={() => setDraftPath(DEFAULT_ENGINE_PATH)}>
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
