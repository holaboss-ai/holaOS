import { Mail } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useWorkspaceDesktop } from "@/lib/workspaceDesktop";

export function DeterministicWorkspaceOnboardingSurface() {
  const {
    selectedWorkspace,
    workspaceErrorMessage,
    continueDeterministicOnboarding,
  } = useWorkspaceDesktop();
  const [isContinuing, setIsContinuing] = useState(false);

  async function handleContinue() {
    setIsContinuing(true);
    try {
      await continueDeterministicOnboarding();
    } finally {
      setIsContinuing(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-1 items-center justify-center px-6 py-10 sm:px-10">
      <div className="flex w-full max-w-xl flex-col items-center gap-6">
        <div className="w-full rounded-[32px] border border-border/70 bg-background/90 px-8 py-10 shadow-[0_28px_90px_rgba(15,23,42,0.08)] backdrop-blur sm:px-12 sm:py-12">
          <div className="mx-auto flex size-20 items-center justify-center rounded-[28px] bg-[#F75A54]/10 text-[#F75A54]">
            <Mail size={34} strokeWidth={1.75} />
          </div>
          <div className="mt-8 space-y-3 text-center">
            <p className="text-xs font-semibold uppercase tracking-[0.32em] text-muted-foreground">
              Deterministic onboarding
            </p>
            <h1 className="text-3xl font-semibold tracking-tight text-foreground">
              {selectedWorkspace?.name?.trim() || "Workspace"} is ready
            </h1>
            <p className="text-sm leading-7 text-muted-foreground">
              Continue into the workspace when you&apos;re ready.
            </p>
          </div>
        </div>
        <Button
          className="min-w-[180px]"
          disabled={isContinuing}
          onClick={() => {
            void handleContinue();
          }}
          size="lg"
          type="button"
        >
          {isContinuing ? "Continuing..." : "Continue"}
        </Button>
        {workspaceErrorMessage ? (
          <p className="max-w-md text-center text-sm text-destructive">
            {workspaceErrorMessage}
          </p>
        ) : null}
      </div>
    </div>
  );
}
