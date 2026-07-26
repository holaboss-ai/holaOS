import { useAtomValue } from "jotai";
import { focusModeAtom } from "./state/ui";

/**
 * Resolved layout mode for the new shell:
 *  - "split" Default. TopChrome + Center take the middle column, chat is a
 *            resizable rail on the right. With zero tabs the middle column
 *            shows the workspace welcome surface — it is *not* a signal to
 *            collapse to chat-only.
 *  - "focus" User opted into focus mode. The middle column is hidden and
 *            chat fills the canvas; a floating pill exposes hidden tabs.
 */
export type ChatLayout = "split" | "focus";

export function useChatLayout(): ChatLayout {
  const focusMode = useAtomValue(focusModeAtom);
  return focusMode ? "focus" : "split";
}
