import { useCallback } from "react";
import { useStartChatDraft } from "./useStartChatDraft";

const CAPABILITY_CREATION_PROMPT =
  "/capability-creator Let's build a capability together. Ask me what outcome it should deliver and which apps it touches, then assemble the skills and integrations.";

export function useStartCapabilityCreation() {
  const startChatDraft = useStartChatDraft();
  return useCallback(
    () => startChatDraft(CAPABILITY_CREATION_PROMPT, { returnTo: "customize" }),
    [startChatDraft],
  );
}
