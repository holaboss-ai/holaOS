import type { HarnessSupportedModel } from "../../harnesses/src/types.js";
import { discoverCodexModels } from "./codex.js";

/**
 * Per-harness live model discoverers, keyed by harness id. Each spawns the
 * harness's CLI to read its model catalogue (ACP handshake / `--help` /
 * `models --verbose`) and must never throw — it returns [] (or a static
 * fallback) on any failure so the api-server's status path stays robust.
 *
 * Invoked out-of-process: the api-server runs `harness-host discover-models
 * --harness <id> --cwd <dir>`, which dispatches here. CLI spawning lives in
 * the harness-host, never the api-server.
 */
export const HARNESS_MODEL_DISCOVERERS: Record<
  string,
  (cwd: string) => Promise<HarnessSupportedModel[]>
> = {
  codex: (cwd) => discoverCodexModels(cwd),
};

export async function discoverHarnessModels(
  harnessId: string,
  cwd: string,
): Promise<HarnessSupportedModel[]> {
  const discoverer = HARNESS_MODEL_DISCOVERERS[harnessId];
  if (!discoverer) {
    return [];
  }
  try {
    return await discoverer(cwd);
  } catch {
    return [];
  }
}
