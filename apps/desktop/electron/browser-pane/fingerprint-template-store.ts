/**
 * Pure metadata store for reusable fingerprint templates.
 *
 * Mirrors `profile-store.ts`: leaf-level (no electron/fs/clock), unit-testable,
 * persisted by main.ts to `browser-profiles/fingerprint-templates.json`. Owns the
 * template catalogue + the untrusted-import normaliser (delegating field
 * validation to `sanitizeFingerprint` — the security gate) + apply-to-profile.
 * See docs/cdp/fingerprint-profiles.md §2.
 */
import type {
  FingerprintTemplate,
  ProfileFingerprint,
} from "../../shared/browser-pane-protocol.js";
import { sanitizeFingerprint } from "./fingerprint.js";

export const FINGERPRINT_TEMPLATE_ID_PREFIX = "ftpl_";

export function isFingerprintTemplateId(v: unknown): v is string {
  return typeof v === "string" && v.startsWith(FINGERPRINT_TEMPLATE_ID_PREFIX);
}

const SOURCES: readonly FingerprintTemplate["source"][] = [
  "builtin",
  "imported",
  "captured",
  "user",
];

export interface FingerprintTemplateIndex {
  templates: FingerprintTemplate[];
}

export function emptyFingerprintTemplateIndex(): FingerprintTemplateIndex {
  return { templates: [] };
}

/**
 * Build a `FingerprintTemplate` from arbitrary (untrusted) input — the import
 * path. Accepts either a full `{ name, source, fingerprint }` shape or a bare
 * fingerprint object. The fingerprint is run through `sanitizeFingerprint`, so
 * nothing outside the whitelist survives. `platform` defaults to `windows` when
 * absent (a template always needs a platform). Returns the template + any
 * per-field warnings; never throws.
 */
export function normalizeFingerprintTemplate(
  raw: unknown,
  id: string,
  now: string,
): { template: FingerprintTemplate | null; warnings: string[] } {
  if (!isFingerprintTemplateId(id)) {
    throw new Error(`invalid fingerprint template id: ${id}`);
  }
  if (!raw || typeof raw !== "object") {
    return { template: null, warnings: ["template is not an object"] };
  }
  const r = raw as Record<string, unknown>;
  const source: FingerprintTemplate["source"] = SOURCES.includes(
    r.source as FingerprintTemplate["source"],
  )
    ? (r.source as FingerprintTemplate["source"])
    : "imported";
  const name =
    typeof r.name === "string" && r.name.trim()
      ? r.name.trim().slice(0, 80)
      : "Imported fingerprint";

  // Accept `{ fingerprint: {...} }` or a bare fingerprint object.
  const { value, warnings } = sanitizeFingerprint(
    r.fingerprint && typeof r.fingerprint === "object" ? r.fingerprint : r,
  );
  const fingerprint: FingerprintTemplate["fingerprint"] = {
    ...value,
    platform: value.platform ?? "windows",
  };
  return {
    template: { id, name, createdAt: now, source, fingerprint },
    warnings,
  };
}

/** Load-time normaliser for the whole persisted index (re-validates each). */
export function normalizeFingerprintTemplateIndex(
  raw: unknown,
): FingerprintTemplateIndex {
  const list =
    raw &&
    typeof raw === "object" &&
    Array.isArray((raw as { templates?: unknown }).templates)
      ? (raw as { templates: unknown[] }).templates
      : [];
  const templates: FingerprintTemplate[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const candidate = entry as Partial<FingerprintTemplate>;
    if (!isFingerprintTemplateId(candidate.id) || seen.has(candidate.id)) {
      continue;
    }
    const createdAt =
      typeof candidate.createdAt === "string" ? candidate.createdAt : "";
    const { template } = normalizeFingerprintTemplate(
      candidate,
      candidate.id,
      createdAt,
    );
    if (template) {
      templates.push(template);
      seen.add(candidate.id);
    }
  }
  return { templates };
}

/** Append (or replace by id) a template. */
export function addFingerprintTemplate(
  index: FingerprintTemplateIndex,
  template: FingerprintTemplate,
): FingerprintTemplateIndex {
  if (!isFingerprintTemplateId(template.id)) {
    throw new Error(`invalid fingerprint template id: ${template.id}`);
  }
  const templates = index.templates.filter((t) => t.id !== template.id);
  templates.push(template);
  return { templates };
}

export function renameFingerprintTemplate(
  index: FingerprintTemplateIndex,
  id: string,
  name: string,
): FingerprintTemplateIndex {
  const trimmed = name.trim();
  if (!trimmed) {
    return index;
  }
  return {
    templates: index.templates.map((t) =>
      t.id === id ? { ...t, name: trimmed.slice(0, 80) } : t,
    ),
  };
}

export function removeFingerprintTemplate(
  index: FingerprintTemplateIndex,
  id: string,
): FingerprintTemplateIndex {
  return { templates: index.templates.filter((t) => t.id !== id) };
}

export function getFingerprintTemplate(
  index: FingerprintTemplateIndex,
  id: string,
): FingerprintTemplate | null {
  return index.templates.find((t) => t.id === id) ?? null;
}

/**
 * Apply a template to a profile's current fingerprint. The profile KEEPS its own
 * stable seed (its returning identity) UNLESS the template pins a seed — a clone
 * or a `captured` real device — in which case the pinned seed is copied so the
 * identity reproduces exactly. Only fields the template defines are overlaid.
 */
export function applyTemplateToFingerprint(
  current: ProfileFingerprint,
  template: FingerprintTemplate,
): ProfileFingerprint {
  const seed = template.fingerprint.seed ?? current.seed;
  return { ...current, ...template.fingerprint, seed };
}
