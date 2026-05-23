import { useAtomValue } from "jotai";
import { useWorkspaceBrowser } from "@/components/panes/useWorkspaceBrowser";
import { internalTabsAtom } from "./state/internalTabs";
import { focusModeAtom } from "./state/ui";

/**
 * Resolved layout mode for the new shell:
 *  - "split"    Default. TopChrome + Center take the middle column, chat is a
 *               resizable rail on the right.
 *  - "chatOnly" No browser/internal tabs exist. The middle column is hidden
 *               and chat fills the canvas.
 *  - "focus"    Tabs exist but the user opted into focus. Same as chatOnly
 *               from a layout standpoint; the difference is the floating
 *               pill that exposes the hidden tabs.
 */
export type ChatLayout = "split" | "chatOnly" | "focus";

export function useChatLayout(): ChatLayout {
  const { browserState } = useWorkspaceBrowser("user");
  const internalTabs = useAtomValue(internalTabsAtom);
  const focusMode = useAtomValue(focusModeAtom);
  const tabsCount = browserState.tabs.length + internalTabs.length;
  if (tabsCount === 0) return "chatOnly";
  if (focusMode) return "focus";
  return "split";
}
