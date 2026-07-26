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

import anthropicLogoMarkup from "@/assets/providers/anthropic.svg?raw";
import deepseekLogoMarkup from "@/assets/providers/deepseek.svg?raw";
import doubaoLogoMarkup from "@/assets/providers/doubao.svg?raw";
import geminiLogoMarkup from "@/assets/providers/gemini.svg?raw";
import glmLogoMarkup from "@/assets/providers/glm.svg?raw";
import grokLogoMarkup from "@/assets/providers/grok.svg?raw";
import kimiLogoMarkup from "@/assets/providers/kimi.svg?raw";
import metaLogoMarkup from "@/assets/providers/meta.svg?raw";
import minimaxLogoMarkup from "@/assets/providers/minimax.svg?raw";
import mistralLogoMarkup from "@/assets/providers/mistral.svg?raw";
import ollamaLogoMarkup from "@/assets/providers/ollama.svg?raw";
import openaiLogoMarkup from "@/assets/providers/openai.svg?raw";
import qwenLogoMarkup from "@/assets/providers/qwen.svg?raw";
import { holabossLogoUrl } from "@/lib/assetPaths";

/**
 * Coarse brand bucket for model-family icons. Only the model family matters
 * here, not the auth provider that delivered the model.
 */
export type ProviderBrand =
  | "openai"
  | "anthropic"
  | "google"
  | "ollama"
  | "qwen"
  | "deepseek"
  | "doubao"
  | "kimi"
  | "glm"
  | "minimax"
  | "llama"
  | "mistral"
  | "grok"
  | "holaboss"
  | "unknown";

/**
 * Match against the *model ID* portion (after the first `/`). This is
 * the primary signal — a token like `holaboss_model_proxy/gpt-5.4` is
 * served by Holaboss but the model is OpenAI's, and the user cares
 * about the latter.
 */
const MODEL_ID_TO_BRAND: Array<[RegExp, ProviderBrand]> = [
  [/codex/i, "openai"],
  [/^(gpt|chatgpt|o[0-9])/i, "openai"],
  [/^claude/i, "anthropic"],
  [/^(gemini|imagen)/i, "google"],
  [/^qwen/i, "qwen"],
  [/^deepseek/i, "deepseek"],
  [/^doubao/i, "doubao"],
  [/^(kimi|moonshot)/i, "kimi"],
  [/^(glm|chatglm|z-?ai)/i, "glm"],
  [/^minimax/i, "minimax"],
  [/^llama/i, "llama"],
  [/^(mistral|mixtral|magistral|devstral)/i, "mistral"],
  [/^grok/i, "grok"],
];

/**
 * Fallback: if the model ID doesn't tell us the family (e.g. a custom
 * fine-tune or a provider we haven't taught patterns to yet), fall back
 * to the token's provider prefix. The Holaboss prefix is intentionally
 * NOT here — Holaboss only relays models from other vendors, so its
 * brand mark is never the right answer for a chat model.
 */
const PROVIDER_PREFIX_TO_BRAND: Array<[RegExp, ProviderBrand]> = [
  [/^openai(_direct)?\//i, "openai"],
  [/^anthropic(_direct)?\//i, "anthropic"],
  [/^(google|gemini(_direct)?)\//i, "google"],
  [/^ollama(_direct|_local)?\//i, "ollama"],
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

  // Strip the provider prefix, then match every remaining path segment —
  // proxied tokens carry a vendor segment between provider and model id
  // (holaboss_model_proxy/z-ai/glm-5.2), and the family can show up in
  // either one.
  const slashIdx = trimmed.indexOf("/");
  const modelPath = slashIdx >= 0 ? trimmed.slice(slashIdx + 1) : trimmed;
  const segments = modelPath.split("/");

  for (const [regex, brand] of MODEL_ID_TO_BRAND) {
    if (segments.some((segment) => regex.test(segment))) return brand;
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
    case "ollama":
      return ollamaLogoMarkup;
    case "qwen":
      return qwenLogoMarkup;
    case "deepseek":
      return deepseekLogoMarkup;
    case "doubao":
      return doubaoLogoMarkup;
    case "kimi":
      return kimiLogoMarkup;
    case "glm":
      return glmLogoMarkup;
    case "minimax":
      return minimaxLogoMarkup;
    case "llama":
      // Llama has no standalone mark of its own — Meta's is the brand.
      return metaLogoMarkup;
    case "mistral":
      return mistralLogoMarkup;
    case "grok":
      return grokLogoMarkup;
    default:
      return null;
  }
}
