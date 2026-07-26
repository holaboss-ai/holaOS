import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";

// Tracks which outputs the user has opened, so the "New" / "Updated" change
// badge clears once read. Keyed by the output's FILE (not its row id): the same
// file is re-recorded as a new row on every save, so id-keying meant opening one
// record never cleared the badge on the deduped / other-surface record of the
// same file. Value is the updated_at that was seen — a later edit bumps
// updated_at past it and re-surfaces the badge.
const SEEN_OUTPUTS_STORAGE_KEY = "holaboss.seenOutputs.v1";

export const seenOutputsAtom = atomWithStorage<Record<string, string>>(
  SEEN_OUTPUTS_STORAGE_KEY,
  {},
);

/** Stable per-file identity for seen-tracking: the file path, falling back to
 *  the row id for fileless (module) outputs. */
function outputSeenKey(output: WorkspaceOutputRecordPayload): string {
  const metadataPath =
    typeof output.metadata?.file_path === "string"
      ? output.metadata.file_path.trim()
      : "";
  const filePath =
    typeof output.file_path === "string" ? output.file_path.trim() : "";
  return metadataPath || filePath || output.id || "";
}

function seenTime(value: string | undefined): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

export const markOutputSeenAtom = atom(
  null,
  (get, set, output: WorkspaceOutputRecordPayload) => {
    const key = outputSeenKey(output);
    if (!key) return;
    const current = get(seenOutputsAtom);
    // Only advance the seen watermark — never regress it.
    if (seenTime(current[key]) >= seenTime(output.updated_at)) return;
    set(seenOutputsAtom, { ...current, [key]: output.updated_at });
  },
);

export const isOutputSeenAtom = atom((get) => {
  const seen = get(seenOutputsAtom);
  return (output: WorkspaceOutputRecordPayload): boolean => {
    const key = outputSeenKey(output);
    const seenAt = seen[key];
    if (!seenAt) return false;
    // Seen if this version is no newer than what was last viewed for the file.
    return seenTime(output.updated_at) <= seenTime(seenAt);
  };
});
