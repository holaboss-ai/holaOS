/**
 * Discord message formatting.
 *
 * Discord renders most CommonMark inline syntax natively (**bold**, *italic*,
 * `code`, ```fences```, ~~strike~~, > quotes, # headings, lists) — so the agent's
 * markdown passes through almost unchanged. The one thing Discord does NOT render
 * in regular message content is the `[label](url)` link form: it shows the literal
 * brackets. We flatten those to `label (url)` so the user sees a clean, clickable
 * URL instead of raw markdown. Bare URLs auto-embed and are left alone.
 */
export function markdownToDiscord(text: string): string {
  return text.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    (_match, label: string, url: string) => (label.trim() === url ? url : `${label} (${url})`),
  );
}
