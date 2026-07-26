import type { ProviderBrand } from "@/lib/providerBrandIcon";

/**
 * Map a harness id to the brand mark that represents its engine. Shared
 * by the harness picker (menu marks) and the chat surfaces (assistant
 * avatar + header identity) so a Claude/Codex session shows its own
 * brand instead of the Hola monogram. `pi`/Hola → holaboss; anything
 * else falls back to `unknown`, which callers treat as "keep the Hola
 * look".
 */
export function harnessBrand(id: string): ProviderBrand {
  const normalized = id.toLowerCase();
  if (normalized === "pi" || normalized.includes("hola")) {
    return "holaboss";
  }
  if (normalized.includes("claude")) {
    return "anthropic";
  }
  if (normalized.includes("codex")) {
    return "openai";
  }
  // Any other harness stays "unknown" here (this coarse model-family brand is
  // only a fallback for surfaces without HarnessIcon; those render a dedicated
  // favicon or monogram via `harnessIcon.tsx`).
  return "unknown";
}
