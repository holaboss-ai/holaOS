import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";

/**
 * Index of the current onboarding stage (0-based).
 *   0 = integrations
 *   1 = browser profile import
 *   2 = agents (bring-your-own harness CLI)
 *
 * Session-only on purpose: persisting cross-stage progress across app
 * restarts opens a class of "user resumed at stage 2 but the workspace
 * they were about to create no longer exists" footguns. The whole flow
 * is short; re-running from stage 0 on a restart is cheap.
 */
export const onboardingStageAtom = atom<number>(0);

/**
 * Whether the user has fully dismissed onboarding (Skip on any stage,
 * or Finish on the last stage). Persisted in localStorage so first-time
 * users only see the flow once. Wipe the key in DevTools to re-trigger.
 */
export const onboardingDismissedAtom = atomWithStorage(
  "holaos.onboarding.dismissed",
  false,
  undefined,
  // `getOnInit: true` so the persisted value is read on the FIRST render.
  // Without it the atom yields its default (`false` = "not dismissed") until an
  // effect hydrates from localStorage — which flashes the full-window
  // OnboardingFlow takeover for returning users before it corrects to the main
  // shell. Same pattern the other persisted atoms use (shell/state/ui.ts).
  { getOnInit: true },
);
