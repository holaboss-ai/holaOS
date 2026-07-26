import { useAtom, useSetAtom } from "jotai";
import { ChevronLeft } from "@/components/ui/icons";
import {
  chatReturnTargetAtom,
  focusModeAtom,
  type WorkspaceOverlay,
  workspaceOverlayAtom,
} from "./state/ui";

const LABELS: Record<WorkspaceOverlay, string> = {
  customize: "Customize",
  automations: "Automations",
  skills: "Skills",
  channels: "Channels",
  profiles: "Browser Profiles",
  apps: "Apps",
  members: "Members",
  holaemployee: "HolaEmployee",
  rewards: "Rewards",
  holahub: "Discover",
  "holahub-share": "Share to HolaHub",
};

/**
 * A one-click way back to the workspace surface the user was handed off from
 * (e.g. "create with agent" out of Customize), so the chat draft isn't a
 * dead-end. Renders nothing when there's no return target.
 */
export function ChatReturnBanner() {
  const [target, setTarget] = useAtom(chatReturnTargetAtom);
  const setWorkspaceOverlay = useSetAtom(workspaceOverlayAtom);
  const setFocusMode = useSetAtom(focusModeAtom);

  if (!target) {
    return null;
  }

  return (
    <button
      className="flex w-full items-center gap-1.5 border-b border-border bg-muted/40 px-4 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      onClick={() => {
        setWorkspaceOverlay(target);
        setFocusMode(false);
        setTarget(null);
      }}
      type="button"
    >
      <ChevronLeft className="size-3.5" />
      Back to {LABELS[target]}
    </button>
  );
}
