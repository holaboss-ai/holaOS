import { Loader2, Plug, Sparkles, Zap } from "lucide-react";
import { useEffect, useState } from "react";

import { FeatureCard, WelcomeHero } from "@/components/auth/WelcomeArt";
import { OnboardingShell } from "@/components/onboarding/OnboardingShell";
import { Button } from "@/components/ui/button";
import { trackUmamiEvent } from "@/lib/analytics/umami";
import { useDesktopAuthSession } from "@/lib/auth/authClient";

const BROWSER_SIGN_IN_HINT =
  "Sign-in opened in the browser. Complete the flow on the Holaboss page to continue.";

export function SignInScreen() {
  const { error, isPending, requestAuth } = useDesktopAuthSession();
  const [isStarting, setIsStarting] = useState(false);
  const [localError, setLocalError] = useState("");
  const [didOpenBrowser, setDidOpenBrowser] = useState(false);

  useEffect(() => {
    trackUmamiEvent("sign_in_screen_viewed");
  }, []);

  useEffect(() => {
    if (!error) {
      return;
    }
    setIsStarting(false);
    setDidOpenBrowser(false);
  }, [error]);

  async function handleSignIn() {
    setLocalError("");
    setDidOpenBrowser(false);
    setIsStarting(true);
    try {
      await requestAuth();
      setDidOpenBrowser(true);
      trackUmamiEvent("sign_in_browser_opened");
    } catch (caught) {
      setLocalError(
        caught instanceof Error && caught.message.trim()
          ? caught.message
          : "Failed to start sign-in.",
      );
      setIsStarting(false);
    }
  }

  const errorMessage = localError || error?.message || "";
  const isWaiting = isStarting && !errorMessage;
  const buttonLabel = isWaiting ? "Waiting for sign-in…" : "Sign in to holaOS";

  return (
    <div className="fixed inset-0 z-30 flex min-h-0 flex-col">
      <OnboardingShell>
        <div className="flex w-full flex-1 items-center justify-center px-5 py-8">
          <div className="w-full max-w-2xl rounded-2xl bg-background px-8 pt-9 pb-8 shadow-xs sm:px-10 sm:pt-10 sm:pb-9">
            <div className="flex flex-col items-center text-center">
              <WelcomeHero />
              <h1 className="mt-6 text-2xl font-semibold tracking-tight text-foreground">
                Welcome to holaOS
              </h1>
              <p className="mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
                Sign in to continue. Workspace files stay local on this machine —
                sign-in keeps your billing, models, and marketplace synced.
              </p>
            </div>

            <div className="mt-7 grid grid-cols-3 gap-3">
              <FeatureCard
                art={<Sparkles strokeWidth={1.25} />}
                caption="Run end-to-end."
                delayMs={120}
                title="Agents"
              />
              <FeatureCard
                art={<Plug strokeWidth={1.25} />}
                caption="Wired in."
                delayMs={220}
                title="Apps"
              />
              <FeatureCard
                art={<Zap strokeWidth={1.25} />}
                caption="Yours forever."
                delayMs={320}
                title="Local"
              />
            </div>

            {errorMessage ? (
              <div
                className="mt-6 rounded-lg bg-destructive/8 px-3 py-2.5 text-sm text-destructive"
                role="alert"
              >
                {errorMessage}
              </div>
            ) : didOpenBrowser && !errorMessage ? (
              <div className="mt-6 rounded-lg bg-fg-2 px-3 py-2.5 text-sm text-muted-foreground">
                {BROWSER_SIGN_IN_HINT}
              </div>
            ) : null}

            <div className="mt-7">
              <Button
                className="w-full"
                disabled={isWaiting || isPending}
                onClick={handleSignIn}
                size="lg"
                type="button"
              >
                {isWaiting ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    {buttonLabel}
                  </>
                ) : (
                  buttonLabel
                )}
              </Button>
            </div>

            {didOpenBrowser && !errorMessage ? (
              <div className="mt-4 text-center">
                <Button
                  className="text-muted-foreground"
                  onClick={handleSignIn}
                  size="xs"
                  type="button"
                  variant="ghost"
                >
                  Didn't open? Open the browser again
                </Button>
              </div>
            ) : null}
          </div>
        </div>
      </OnboardingShell>
    </div>
  );
}
