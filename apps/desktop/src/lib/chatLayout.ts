/**
 * Chat-pane layout tokens.
 *
 * Centralises the spatial rhythm for the message list so the scroll
 * region, gutters, and content max-width stay in sync. Values are tuned
 * for our denser typographic baseline (Inter + Newsreader pairing): a
 * slightly tighter content column than long-form readers, balanced
 * vertical breathing, and a soft fade at the scroll edges so messages
 * dissolve into the composer / session header rather than hard-cutting.
 */

export const CHAT_LAYOUT = {
  /** Caps message column width on wide panes (avoids cross-screen reads). */
  contentMaxWidth: "max-w-[760px]",

  /** Horizontal gutter inside the scroll viewport. */
  contentPaddingX: "px-6",

  /** Default vertical padding around the message column. */
  contentPaddingY: "py-6",

  /** Extra top inset when the floating todo plan banner is shown. */
  contentPaddingTopWithTodo: "pt-14",

  /** Vertical rhythm between consecutive messages. */
  messageGap: "gap-3",

  /** Top/bottom fade height — soft cue that more content scrolls past. */
  edgeFadePx: 24,
} as const;

/** Linear-gradient mask used to fade the scroll edges. */
export function chatScrollMaskImage(fadePx: number = CHAT_LAYOUT.edgeFadePx) {
  return `linear-gradient(to bottom, transparent 0, black ${fadePx}px, black calc(100% - ${fadePx}px), transparent 100%)`;
}
