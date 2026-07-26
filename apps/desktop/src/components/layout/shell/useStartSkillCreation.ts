import { useCallback } from "react";
import { useStartChatDraft } from "./useStartChatDraft";

// `/skill-creator` is pre-resolved by the runtime into a <skill> block before
// the harness boots, so the agent starts with skill-creator's guidance loaded.
const SKILL_CREATION_PROMPT =
  "/skill-creator Let's build a new skill together. Start by asking me what it should do, then walk me through it.";

export function useStartSkillCreation() {
  const startChatDraft = useStartChatDraft();
  return useCallback(
    () => startChatDraft(SKILL_CREATION_PROMPT, { returnTo: "customize" }),
    [startChatDraft],
  );
}
