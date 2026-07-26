import cronstrue from "cronstrue";

/**
 * Cron utilities — human-readable conversion, validation, and round-trips
 * to a small preset model that the schedule editor uses.
 *
 * Why presets: 90% of users want "every day at 09:00" not raw cron syntax.
 * The preset model captures that intent so the editor can render
 * appropriate parametric controls (time pickers, weekday pickers) instead
 * of a raw textbox. Power users still get a "Custom" preset that drops
 * back to a cron textbox with live human-readable preview.
 */

/** Convert a cron expression to a human-readable string. Falls back to the
 *  raw cron when parsing fails (so UI never shows an empty label). */
export function cronToHumanReadable(cron: string): string {
  const trimmed = cron.trim();
  if (!trimmed) return "";
  try {
    return cronstrue.toString(trimmed, {
      use24HourTimeFormat: true,
      verbose: false,
    });
  } catch {
    return trimmed;
  }
}

export interface CronValidation {
  valid: boolean;
  /** Set when invalid; safe to render to the user. */
  error?: string;
}

/** Validate a 5-field standard cron expression. Uses cronstrue's parser as
 *  the source of truth so display + validation never disagree. */
export function validateCron(cron: string): CronValidation {
  const trimmed = cron.trim();
  if (!trimmed) return { valid: false, error: "Schedule is required" };
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) {
    return {
      valid: false,
      error: "Cron must have 5 fields (minute hour day month weekday)",
    };
  }
  try {
    cronstrue.toString(trimmed, { throwExceptionOnParseError: true });
    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : "Invalid cron expression",
    };
  }
}

export type SchedulePresetKind =
  | "every-minute"
  | "every-n-minutes"
  | "every-hour"
  | "every-day"
  | "weekdays"
  | "weekly"
  | "monthly"
  | "custom";

export interface SchedulePreset {
  kind: SchedulePresetKind;
  /** Step minutes for "every-n-minutes" (5, 10, 15, 30). */
  intervalMinutes?: number;
  /** Hour 0-23 for daily/weekdays/weekly/monthly presets. */
  hour?: number;
  /** Minute 0-59 for daily/weekdays/weekly/monthly presets. */
  minute?: number;
  /** Day-of-week (0=Sunday..6=Saturday) for "weekly". */
  weekday?: number;
  /** Day of month (1-31) for "monthly". */
  day?: number;
  /** Raw cron when kind === "custom". */
  customCron?: string;
}

const SUPPORTED_INTERVAL_MINUTES = [5, 10, 15, 30];

/** Parse a cron string into a preset, when it matches one of the supported
 *  shapes. Anything else maps to "custom" with the original cron preserved
 *  so the editor can render the textbox pre-filled. */
export function cronToPreset(cron: string): SchedulePreset {
  const trimmed = cron.trim();
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) {
    return { kind: "custom", customCron: trimmed };
  }
  const [minute, hour, day, month, weekday] = fields;

  if (
    minute === "*" &&
    hour === "*" &&
    day === "*" &&
    month === "*" &&
    weekday === "*"
  ) {
    return { kind: "every-minute" };
  }

  const everyNMatch = minute.match(/^\*\/(\d+)$/);
  if (
    everyNMatch &&
    hour === "*" &&
    day === "*" &&
    month === "*" &&
    weekday === "*"
  ) {
    const interval = Number.parseInt(everyNMatch[1], 10);
    if (SUPPORTED_INTERVAL_MINUTES.includes(interval)) {
      return { kind: "every-n-minutes", intervalMinutes: interval };
    }
  }

  if (
    /^\d+$/.test(minute) &&
    hour === "*" &&
    day === "*" &&
    month === "*" &&
    weekday === "*"
  ) {
    return { kind: "every-hour", minute: Number.parseInt(minute, 10) };
  }

  if (
    /^\d+$/.test(minute) &&
    /^\d+$/.test(hour) &&
    day === "*" &&
    month === "*"
  ) {
    const m = Number.parseInt(minute, 10);
    const h = Number.parseInt(hour, 10);
    if (weekday === "*") {
      return { kind: "every-day", hour: h, minute: m };
    }
    if (weekday === "1-5") {
      return { kind: "weekdays", hour: h, minute: m };
    }
    if (/^\d$/.test(weekday)) {
      return {
        kind: "weekly",
        hour: h,
        minute: m,
        weekday: Number.parseInt(weekday, 10),
      };
    }
  }

  if (
    /^\d+$/.test(minute) &&
    /^\d+$/.test(hour) &&
    /^\d+$/.test(day) &&
    month === "*" &&
    weekday === "*"
  ) {
    return {
      kind: "monthly",
      hour: Number.parseInt(hour, 10),
      minute: Number.parseInt(minute, 10),
      day: Number.parseInt(day, 10),
    };
  }

  return { kind: "custom", customCron: trimmed };
}

/** Reverse of cronToPreset. For "custom" returns the stored cron string. */
export function presetToCron(preset: SchedulePreset): string {
  switch (preset.kind) {
    case "every-minute":
      return "* * * * *";
    case "every-n-minutes":
      return `*/${preset.intervalMinutes ?? 5} * * * *`;
    case "every-hour":
      return `${preset.minute ?? 0} * * * *`;
    case "every-day":
      return `${preset.minute ?? 0} ${preset.hour ?? 9} * * *`;
    case "weekdays":
      return `${preset.minute ?? 0} ${preset.hour ?? 9} * * 1-5`;
    case "weekly":
      return `${preset.minute ?? 0} ${preset.hour ?? 9} * * ${preset.weekday ?? 1}`;
    case "monthly":
      return `${preset.minute ?? 0} ${preset.hour ?? 9} ${preset.day ?? 1} * *`;
    case "custom":
      return preset.customCron?.trim() ?? "";
  }
}

export const SCHEDULE_PRESET_OPTIONS: ReadonlyArray<{
  kind: SchedulePresetKind;
  label: string;
}> = [
  { kind: "every-minute", label: "Every minute" },
  { kind: "every-n-minutes", label: "Every N minutes" },
  { kind: "every-hour", label: "Every hour" },
  { kind: "every-day", label: "Every day" },
  { kind: "weekdays", label: "Weekdays" },
  { kind: "weekly", label: "Weekly" },
  { kind: "monthly", label: "Monthly" },
  { kind: "custom", label: "Custom cron" },
];

export const WEEKDAY_LABELS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 0, label: "Sun" },
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
];

/** Pad a number with a leading zero to 2 digits for time displays. */
export function padTime(n: number): string {
  return String(n).padStart(2, "0");
}
