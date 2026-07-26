import { useCallback } from "react";
import { useStartChatDraft } from "./useStartChatDraft";

// Mirrors useStartSkillCreation: hand the user a fresh, pre-filled (not
// auto-sent) chat draft that kicks off the conversational automation builder —
// Hola explains how automations work, then interviews the user to shape the
// task + schedule and sets up the cronjob.
const AUTOMATION_CREATION_PROMPT =
  "I want to set up a scheduled task. Briefly explain how automations work in holaOS, then ask me a few questions to figure out what I'd like to do and when it should run.";

export function useStartAutomationCreation() {
  const startChatDraft = useStartChatDraft();
  return useCallback(
    (intent?: string) =>
      startChatDraft(intent ?? AUTOMATION_CREATION_PROMPT, {
        returnTo: "automations",
      }),
    [startChatDraft],
  );
}
