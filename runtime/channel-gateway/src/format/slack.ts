/**
 * Convert the agent's CommonMark output into Slack's `mrkdwn` dialect.
 *
 * Slack's mrkdwn differs from Markdown in three load-bearing ways:
 *  - bold is `*text*` (single asterisk), italic is `_text_`
 *  - links are `<url|label>`, not `[label](url)`
 *  - headings / `**bold**` / `__bold__` aren't recognised
 *
 * Because Slack bold and Markdown italic both use a single `*`, we stage bold
 * behind a sentinel before touching italics, then restore it — otherwise the two
 * passes corrupt each other. Code spans and fenced blocks are masked first (with
 * distinctive ASCII sentinels that won't realistically occur in text) so none of
 * these substitutions run inside them.
 */
const BOLD_SENTINEL = "HBZBOLDZ";

export function markdownToSlack(text: string): string {
  const blocks: string[] = [];
  let s = text.replace(/```[\s\S]*?```/g, (m) => {
    blocks.push(m);
    return `HBZBLOCKZ${blocks.length - 1}ZEND`;
  });

  const inline: string[] = [];
  s = s.replace(/`[^`]*`/g, (m) => {
    inline.push(m);
    return `HBZINLINEZ${inline.length - 1}ZEND`;
  });

  // Links: [label](url) → <url|label>
  s = s.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    (_m, label: string, url: string) => `<${url}|${label}>`,
  );

  // Bold first, behind a sentinel: **x** / __x__ → HBZBOLDZ x HBZBOLDZ
  s = s
    .replace(/\*\*([^*]+)\*\*/g, `${BOLD_SENTINEL}$1${BOLD_SENTINEL}`)
    .replace(/__([^_]+)__/g, `${BOLD_SENTINEL}$1${BOLD_SENTINEL}`);
  // Remaining single-* pairs are Markdown italics → Slack italics _x_
  s = s.replace(/\*([^*\n]+)\*/g, "_$1_");
  // Restore bold as Slack bold *x*
  s = s.replace(/HBZBOLDZ([\s\S]*?)HBZBOLDZ/g, "*$1*");

  // Strikethrough ~~x~~ → ~x~
  s = s.replace(/~~([^~]+)~~/g, "~$1~");
  // Headings → bold line (Slack has no heading syntax)
  s = s.replace(/^#{1,6}[ \t]+(.+)$/gm, "*$1*");

  // Restore masked code spans / blocks.
  s = s.replace(/HBZINLINEZ(\d+)ZEND/g, (_m, i) => inline[Number(i)] ?? "");
  s = s.replace(/HBZBLOCKZ(\d+)ZEND/g, (_m, i) => blocks[Number(i)] ?? "");
  return s;
}
