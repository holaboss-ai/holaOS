/**
 * ProviderBrandIcon — single source of truth for rendering the brand
 * mark of a model provider, whether the caller knows the provider ID
 * directly or only has a runtime model token like "openai/gpt-5.4".
 *
 * Brand SVGs live in src/assets/providers/ and use `currentColor` so
 * they pick up the surrounding text color. Holaboss has its own raster
 * logo. Anything we don't recognise renders nothing — the caller can
 * decide on a fallback.
 */

import { Terminal } from "lucide-react";
import anthropicLogoMarkup from "@/assets/providers/anthropic.svg?raw";
import geminiLogoMarkup from "@/assets/providers/gemini.svg?raw";
import minimaxLogoMarkup from "@/assets/providers/minimax.svg?raw";
import ollamaLogoMarkup from "@/assets/providers/ollama.svg?raw";
import openaiLogoMarkup from "@/assets/providers/openai.svg?raw";
import openrouterLogoMarkup from "@/assets/providers/openrouter.svg?raw";
import qwenLogoMarkup from "@/assets/providers/qwen.svg?raw";
import { holabossLogoUrl } from "@/lib/assetPaths";

/**
 * Coarse brand bucket. We collapse "anthropic_direct" → "anthropic"
 * etc. so the icon doesn't change between auth modes — only the model
 * family matters here.
 */
export type ProviderBrand =
  | "openai"
  | "openai_codex"
  | "anthropic"
  | "google"
  | "openrouter"
  | "ollama"
  | "minimax"
  | "qwen"
  | "holaboss"
  | "unknown";

/**
 * Match against the *model ID* portion (after the first `/`). This is
 * the primary signal — a token like `holaboss_model_proxy/gpt-5.4` is
 * served by Holaboss but the model is OpenAI's, and the user cares
 * about the latter. Patterns are ordered most-specific first so e.g.
 * `gpt-5.3-codex` resolves to "openai_codex" before the generic `gpt-`
 * matcher fires.
 */
const MODEL_ID_TO_BRAND: Array<[RegExp, ProviderBrand]> = [
  [/codex/i, "openai_codex"],
  [/^(gpt|chatgpt|o[0-9])/i, "openai"],
  [/^claude/i, "anthropic"],
  [/^(gemini|imagen)/i, "google"],
  [/^minimax/i, "minimax"],
  [/^qwen/i, "qwen"],
  [/^(llama|deepseek|mistral)/i, "unknown"], // no icon assets yet
];

/**
 * Fallback: if the model ID doesn't tell us the family (e.g. a custom
 * fine-tune or a provider we haven't taught patterns to yet), fall back
 * to the token's provider prefix. The Holaboss prefix is intentionally
 * NOT here — Holaboss only relays models from other vendors, so its
 * brand mark is never the right answer for a chat model.
 */
const PROVIDER_PREFIX_TO_BRAND: Array<[RegExp, ProviderBrand]> = [
  [/^openai_codex\//i, "openai_codex"],
  [/^openai(_direct)?\//i, "openai"],
  [/^anthropic(_direct)?\//i, "anthropic"],
  [/^(google|gemini(_direct)?)\//i, "google"],
  [/^openrouter(_direct)?\//i, "openrouter"],
  [/^ollama(_direct|_local)?\//i, "ollama"],
  [/^minimax(_direct)?\//i, "minimax"],
];

/**
 * Derive the brand bucket from a runtime model token.
 *
 * Order of precedence:
 *   1. Model ID family (gpt-* → openai, claude-* → anthropic, …) — this
 *      is what the user actually cares about; Holaboss-proxied tokens
 *      like `holaboss_model_proxy/gpt-5.4` resolve to OpenAI here.
 *   2. Provider prefix — only used when the model ID is opaque (custom
 *      fine-tune, unknown family) and we still want some signal.
 *   3. "unknown" — caller renders a placeholder or no icon.
 */
export function brandFromModelToken(token: string | null | undefined): ProviderBrand {
  if (!token) return "unknown";
  const trimmed = token.trim();
  if (!trimmed) return "unknown";

  // Strip the provider prefix to expose the model ID.
  const slashIdx = trimmed.indexOf("/");
  const modelId = slashIdx >= 0 ? trimmed.slice(slashIdx + 1) : trimmed;

  for (const [regex, brand] of MODEL_ID_TO_BRAND) {
    if (regex.test(modelId)) return brand;
  }
  for (const [regex, brand] of PROVIDER_PREFIX_TO_BRAND) {
    if (regex.test(trimmed)) return brand;
  }
  return "unknown";
}

interface ProviderBrandIconProps {
  /**
   * Either a known provider brand or a raw runtime model token. Tokens
   * are normalised through brandFromModelToken; unrecognised inputs
   * render `null`.
   */
  brand?: ProviderBrand;
  modelToken?: string;
  /** Tailwind size utility, default `size-4` (16px). */
  className?: string;
}

/**
 * Renders the brand mark for a given provider or model token.
 *
 * Prefer passing `brand` when you already know it; fall back to
 * `modelToken` when you only have the runtime string (e.g. inside a
 * model picker trigger).
 */
export function ProviderBrandIcon({
  brand,
  modelToken,
  className,
}: ProviderBrandIconProps) {
  const sizeClass = className ?? "size-4";
  const resolved = brand ?? brandFromModelToken(modelToken);

  if (resolved === "openai_codex") {
    return (
      <Terminal
        className={`${sizeClass} text-foreground`}
        aria-hidden="true"
      />
    );
  }
  if (resolved === "holaboss") {
    return (
      <img
        src={holabossLogoUrl}
        alt=""
        className={`${sizeClass} object-contain`}
        aria-hidden="true"
      />
    );
  }

  const markup = resolveSvgMarkup(resolved);
  if (!markup) return null;

  return (
    <span
      aria-hidden="true"
      className={`block ${sizeClass} text-foreground [&_svg]:h-full [&_svg]:w-full`}
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  );
}

function resolveSvgMarkup(brand: ProviderBrand): string | null {
  switch (brand) {
    case "openai":
      return openaiLogoMarkup;
    case "anthropic":
      return anthropicLogoMarkup;
    case "google":
      return geminiLogoMarkup;
    case "openrouter":
      return openrouterLogoMarkup;
    case "ollama":
      return ollamaLogoMarkup;
    case "minimax":
      return minimaxLogoMarkup;
    case "qwen":
      return qwenLogoMarkup;
    default:
      return null;
  }
}
