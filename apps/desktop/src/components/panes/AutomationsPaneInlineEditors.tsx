import { Check, Loader2, Pencil, X } from "lucide-react";
import {
  type ChangeEvent,
  type KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  cronToHumanReadable,
  cronToPreset,
  padTime,
  presetToCron,
  SCHEDULE_PRESET_OPTIONS,
  type SchedulePreset,
  type SchedulePresetKind,
  validateCron,
  WEEKDAY_LABELS,
} from "@/lib/cron";

// =====================================================================
// Instruction inline editor
// =====================================================================

interface InstructionInlineEditorProps {
  value: string;
  saving: boolean;
  onSave: (next: string) => Promise<void> | void;
  /** Disable entering edit mode (e.g. while another mutation is in flight). */
  disabled?: boolean;
}

/** Inline-editable instruction block. Display mode renders the existing
 *  bordered card with a hover pencil; click flips to a textarea matching
 *  the Input component's chrome with Save/Cancel + ⌘⏎ / Esc. Empty drafts
 *  can't be saved (the agent needs *something* to do). */
export function InstructionInlineEditor({
  value,
  saving,
  onSave,
  disabled = false,
}: InstructionInlineEditorProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  // Auto-resize the textarea to fit content. Cheap pattern, no
  // ResizeObserver needed because the textarea is the only thing whose
  // height matters here.
  useEffect(() => {
    if (!editing) return;
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [draft, editing]);

  const trimmedDraft = draft.trim();
  const dirty = trimmedDraft !== value.trim();
  const canSave = dirty && trimmedDraft.length > 0 && !saving;

  const enterEdit = () => {
    if (disabled) return;
    setDraft(value);
    setEditing(true);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.select();
    });
  };

  const cancel = () => {
    if (dirty) {
      const confirmed = window.confirm("Discard changes to instruction?");
      if (!confirmed) return;
    }
    setDraft(value);
    setEditing(false);
  };

  const save = async () => {
    if (!canSave) return;
    try {
      await onSave(trimmedDraft);
      setEditing(false);
    } catch {
      // Parent surfaces the error; keep edit mode open so the user
      // can retry without losing their draft.
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      cancel();
      return;
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void save();
    }
  };

  return (
    <div className="grid gap-1.5">
      <div className="flex items-center justify-between gap-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        <span>Instruction</span>
        {editing ? (
          <span className="flex items-center gap-1.5 normal-case tracking-normal">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={cancel}
              disabled={saving}
            >
              <X className="size-3" />
              Cancel
            </Button>
            <Button
              type="button"
              size="xs"
              onClick={() => void save()}
              disabled={!canSave}
            >
              {saving ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Check className="size-3" />
              )}
              Save
            </Button>
          </span>
        ) : null}
      </div>
      {editing ? (
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
            setDraft(event.target.value)
          }
          onKeyDown={handleKeyDown}
          rows={2}
          className="w-full min-w-0 resize-none rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-xs leading-5 text-foreground transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30"
        />
      ) : (
        <button
          type="button"
          onClick={enterEdit}
          disabled={disabled}
          className="group/inst-display relative whitespace-pre-wrap rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-left text-xs leading-5 text-foreground transition-colors hover:bg-fg-2 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-input/30"
        >
          {value}
          <span
            aria-hidden="true"
            className="pointer-events-none absolute right-1.5 top-1.5 inline-flex size-5 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity group-hover/inst-display:opacity-100"
          >
            <Pencil className="size-3" />
          </span>
        </button>
      )}
    </div>
  );
}

// =====================================================================
// Schedule editor — display + popover with Select-driven preset picker
// =====================================================================

interface ScheduleEditorProps {
  cron: string;
  saving: boolean;
  onSave: (nextCron: string) => Promise<void> | void;
  disabled?: boolean;
}

/** Display row + click-to-edit popover. Display: human-readable on top,
 *  raw cron muted next to it. Popover: shadcn Select for preset kind +
 *  parametric controls below + live human-readable preview. */
export function ScheduleEditor({
  cron,
  saving,
  onSave,
  disabled = false,
}: ScheduleEditorProps) {
  const [open, setOpen] = useState(false);
  const human = useMemo(() => cronToHumanReadable(cron), [cron]);

  return (
    <Popover open={open} onOpenChange={(next) => !disabled && setOpen(next)}>
      <PopoverTrigger
        render={
          <button
            type="button"
            disabled={disabled}
            className="group/sched-display inline-flex min-w-0 items-baseline gap-2 rounded text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60"
          >
            <span className="text-foreground">{human}</span>
            <span className="font-mono text-[10px] text-muted-foreground/60">
              {cron}
            </span>
            <Pencil
              aria-hidden="true"
              className="size-3 text-transparent transition-colors group-hover/sched-display:text-muted-foreground"
            />
          </button>
        }
      />
      <PopoverContent align="start" sideOffset={8} className="w-80 p-0">
        <SchedulePresetForm
          initialCron={cron}
          saving={saving}
          onCancel={() => setOpen(false)}
          onSave={async (nextCron) => {
            try {
              await onSave(nextCron);
              setOpen(false);
            } catch {
              // Parent reports the error; keep popover open so the user
              // can adjust and retry.
            }
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

interface SchedulePresetFormProps {
  initialCron: string;
  saving: boolean;
  onSave: (cron: string) => Promise<void> | void;
  onCancel: () => void;
}

function SchedulePresetForm({
  initialCron,
  saving,
  onSave,
  onCancel,
}: SchedulePresetFormProps) {
  const [preset, setPreset] = useState<SchedulePreset>(() =>
    cronToPreset(initialCron),
  );
  // Custom branch keeps the textbox value separately so users can type a
  // malformed cron without losing keystrokes.
  const [customDraft, setCustomDraft] = useState<string>(
    () => cronToPreset(initialCron).customCron ?? initialCron,
  );

  const candidateCron =
    preset.kind === "custom" ? customDraft : presetToCron(preset);
  const validation = useMemo(
    () => validateCron(candidateCron),
    [candidateCron],
  );
  const previewHuman = useMemo(
    () => (validation.valid ? cronToHumanReadable(candidateCron) : ""),
    [candidateCron, validation.valid],
  );

  const dirty = candidateCron.trim() !== initialCron.trim();
  const canSave = validation.valid && dirty && !saving;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (canSave) void onSave(candidateCron.trim());
      }}
    >
      <div className="border-b border-border px-3 py-2">
        <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          Schedule
        </div>
      </div>

      <div className="space-y-3 p-3">
        <PresetField
          label="Repeat"
          control={
            <Select
              value={preset.kind}
              onValueChange={(next) => {
                if (next == null) return;
                setPreset(
                  initialPresetFor(next as SchedulePresetKind, preset),
                );
              }}
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SCHEDULE_PRESET_OPTIONS.map((option) => (
                  <SelectItem
                    key={option.kind}
                    value={option.kind}
                    className="text-xs"
                  >
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
        <PresetParametricControls
          preset={preset}
          onChange={setPreset}
          customDraft={customDraft}
          onCustomDraftChange={setCustomDraft}
        />
      </div>

      <div className="border-t border-border px-3 py-2">
        {validation.valid ? (
          <div className="flex items-baseline gap-2 text-[11px]">
            <span className="text-foreground">{previewHuman}</span>
            <span className="font-mono text-[10px] text-muted-foreground/60">
              {candidateCron}
            </span>
          </div>
        ) : (
          <div className="text-[11px] text-destructive">
            {validation.error ?? "Invalid schedule"}
          </div>
        )}
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-border px-3 py-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onCancel}
          disabled={saving}
        >
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={!canSave}>
          {saving ? <Loader2 className="size-3 animate-spin" /> : null}
          Save
        </Button>
      </div>
    </form>
  );
}

interface PresetFieldProps {
  label: string;
  control: React.ReactNode;
}

function PresetField({ label, control }: PresetFieldProps) {
  return (
    <div className="grid gap-1">
      <label className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </label>
      {control}
    </div>
  );
}

/** Pick reasonable defaults when switching presets so the form doesn't
 *  flash blank parametric controls. Carries over hour/minute when the
 *  new preset can use them. */
function initialPresetFor(
  kind: SchedulePresetKind,
  previous: SchedulePreset,
): SchedulePreset {
  const carryHour = previous.hour ?? 9;
  const carryMinute = previous.minute ?? 0;
  switch (kind) {
    case "every-minute":
      return { kind };
    case "every-n-minutes":
      return { kind, intervalMinutes: previous.intervalMinutes ?? 5 };
    case "every-hour":
      return { kind, minute: previous.minute ?? 0 };
    case "every-day":
      return { kind, hour: carryHour, minute: carryMinute };
    case "weekdays":
      return { kind, hour: carryHour, minute: carryMinute };
    case "weekly":
      return {
        kind,
        hour: carryHour,
        minute: carryMinute,
        weekday: previous.weekday ?? 1,
      };
    case "monthly":
      return {
        kind,
        hour: carryHour,
        minute: carryMinute,
        day: previous.day ?? 1,
      };
    case "custom":
      return {
        kind,
        customCron: previous.customCron ?? presetToCron(previous),
      };
  }
}

interface PresetParametricControlsProps {
  preset: SchedulePreset;
  onChange: (next: SchedulePreset) => void;
  customDraft: string;
  onCustomDraftChange: (next: string) => void;
}

function PresetParametricControls({
  preset,
  onChange,
  customDraft,
  onCustomDraftChange,
}: PresetParametricControlsProps) {
  if (preset.kind === "every-minute") {
    return null;
  }

  if (preset.kind === "every-n-minutes") {
    return (
      <PresetField
        label="Interval"
        control={
          <NumberSelect
            value={preset.intervalMinutes ?? 5}
            options={[5, 10, 15, 30]}
            renderLabel={(v) => `${v} minutes`}
            onChange={(v) => onChange({ ...preset, intervalMinutes: v })}
          />
        }
      />
    );
  }

  if (preset.kind === "every-hour") {
    return (
      <PresetField
        label="At minute"
        control={
          <NumberSelect
            value={preset.minute ?? 0}
            options={Array.from({ length: 60 }, (_, i) => i)}
            renderLabel={(v) => `:${padTime(v)}`}
            onChange={(v) => onChange({ ...preset, minute: v })}
          />
        }
      />
    );
  }

  if (preset.kind === "every-day" || preset.kind === "weekdays") {
    return (
      <PresetField
        label="At time"
        control={
          <TimePicker
            hour={preset.hour ?? 9}
            minute={preset.minute ?? 0}
            onChange={(h, m) => onChange({ ...preset, hour: h, minute: m })}
          />
        }
      />
    );
  }

  if (preset.kind === "weekly") {
    return (
      <div className="grid grid-cols-[1fr_1fr] gap-2">
        <PresetField
          label="On"
          control={
            <NumberSelect
              value={preset.weekday ?? 1}
              options={WEEKDAY_LABELS.map((d) => d.value)}
              renderLabel={(v) => WEEKDAY_LABELS[v].label}
              onChange={(v) => onChange({ ...preset, weekday: v })}
            />
          }
        />
        <PresetField
          label="At"
          control={
            <TimePicker
              hour={preset.hour ?? 9}
              minute={preset.minute ?? 0}
              onChange={(h, m) => onChange({ ...preset, hour: h, minute: m })}
            />
          }
        />
      </div>
    );
  }

  if (preset.kind === "monthly") {
    return (
      <div className="grid grid-cols-[1fr_1fr] gap-2">
        <PresetField
          label="On day"
          control={
            <NumberSelect
              value={preset.day ?? 1}
              options={Array.from({ length: 28 }, (_, i) => i + 1)}
              renderLabel={(v) => String(v)}
              onChange={(v) => onChange({ ...preset, day: v })}
            />
          }
        />
        <PresetField
          label="At"
          control={
            <TimePicker
              hour={preset.hour ?? 9}
              minute={preset.minute ?? 0}
              onChange={(h, m) => onChange({ ...preset, hour: h, minute: m })}
            />
          }
        />
      </div>
    );
  }

  // custom
  return (
    <PresetField
      label="Cron expression"
      control={
        <div className="grid gap-1">
          <Input
            value={customDraft}
            onChange={(event) => {
              onCustomDraftChange(event.target.value);
              onChange({ kind: "custom", customCron: event.target.value });
            }}
            spellCheck={false}
            placeholder="0 9 * * 1-5"
            className="h-8 font-mono text-[11px]"
          />
          <span className="text-[10px] text-muted-foreground/70">
            5 fields: minute hour day month weekday
          </span>
        </div>
      }
    />
  );
}

interface NumberSelectProps {
  value: number;
  options: ReadonlyArray<number>;
  renderLabel: (value: number) => string;
  onChange: (next: number) => void;
}

function NumberSelect({
  value,
  options,
  renderLabel,
  onChange,
}: NumberSelectProps) {
  return (
    <Select
      value={String(value)}
      onValueChange={(next) => {
        if (next == null) return;
        onChange(Number.parseInt(next, 10));
      }}
    >
      <SelectTrigger className="h-8 text-xs tabular-nums">
        <SelectValue />
      </SelectTrigger>
      <SelectContent className={cn(options.length > 12 && "max-h-60")}>
        {options.map((opt) => (
          <SelectItem
            key={opt}
            value={String(opt)}
            className="text-xs tabular-nums"
          >
            {renderLabel(opt)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

interface TimePickerProps {
  hour: number;
  minute: number;
  onChange: (hour: number, minute: number) => void;
}

function TimePicker({ hour, minute, onChange }: TimePickerProps) {
  return (
    <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-1">
      <NumberSelect
        value={hour}
        options={Array.from({ length: 24 }, (_, i) => i)}
        renderLabel={padTime}
        onChange={(h) => onChange(h, minute)}
      />
      <span className="text-foreground/60">:</span>
      <NumberSelect
        value={minute}
        options={Array.from({ length: 60 }, (_, i) => i)}
        renderLabel={padTime}
        onChange={(m) => onChange(hour, m)}
      />
    </div>
  );
}
