import { Check, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { StatusDot } from "@/components/ui/status-dot";
import { cn } from "@/lib/utils";

interface CreatingViewProps {
  /** Outer section class — kept for API parity with the wizard shell. */
  sectionClassName: string;
  creatingViaMarketplace: boolean;
  /** Reserved for parity with previous API; the new shell renders chrome. */
  showUserButton?: boolean;
  panelVariant?: boolean;
  browserBootstrapMode?: "fresh" | "copy_workspace" | "import_browser";
  workspaceCreatePhase?:
    | "creating_workspace"
    | "copying_browser_profile"
    | "importing_browser_profile"
    | "finalizing";
}

export function CreatingView({
  sectionClassName,
  creatingViaMarketplace,
  panelVariant: _panelVariant = false,
  browserBootstrapMode = "fresh",
  workspaceCreatePhase = "creating_workspace",
}: CreatingViewProps) {
  const title = creatingViaMarketplace
    ? "Launching your workspace"
    : "Preparing your workspace";
  const detail = creatingViaMarketplace
    ? "Spinning up a sandbox and importing your template. This usually takes under a minute."
    : "Preparing the local runtime and importing your template.";
  const steps = creatingViaMarketplace
    ? [
        "Launching sandbox",
        browserBootstrapMode === "copy_workspace"
          ? "Copying browser profile"
          : browserBootstrapMode === "import_browser"
            ? "Importing browser data"
            : "Configuring workspace",
        "Opening desktop",
      ]
    : [
        "Preparing runtime",
        browserBootstrapMode === "copy_workspace"
          ? "Copying browser profile"
          : browserBootstrapMode === "import_browser"
            ? "Importing browser data"
            : "Importing template",
        "Opening workspace",
      ];

  const [activeStep, setActiveStep] = useState(0);
  useEffect(() => {
    if (workspaceCreatePhase === "creating_workspace") {
      setActiveStep(0);
    } else if (
      workspaceCreatePhase === "copying_browser_profile" ||
      workspaceCreatePhase === "importing_browser_profile"
    ) {
      setActiveStep(1);
    } else if (workspaceCreatePhase === "finalizing") {
      setActiveStep(2);
    }
  }, [workspaceCreatePhase]);

  useEffect(() => {
    if (workspaceCreatePhase !== "creating_workspace") {
      return;
    }
    const timer = setInterval(() => {
      setActiveStep((prev) => (prev < steps.length - 1 ? prev + 1 : prev));
    }, 4000);
    return () => clearInterval(timer);
  }, [steps.length, workspaceCreatePhase]);

  return (
    <section className={cn(sectionClassName, "grid place-items-center")}>
      <div className="w-full max-w-[440px] px-5 pb-8">
        <div className="rounded-2xl bg-background px-9 pt-12 pb-9 shadow-subtle-sm">
          {/* Halo spinner — same DNA as the publish success card */}
          <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-primary/10 ring-[6px] ring-primary/[0.05]">
            <svg
              aria-hidden
              className="size-6 animate-spin text-primary"
              fill="none"
              style={{ animationDuration: "1.4s" }}
              viewBox="0 0 24 24"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="9.5"
                stroke="currentColor"
                strokeWidth="2.5"
              />
              <path
                d="M12 2.5A9.5 9.5 0 0 1 21.5 12"
                stroke="currentColor"
                strokeLinecap="round"
                strokeWidth="2.5"
              />
            </svg>
          </div>

          {/* Title + body */}
          <h2 className="mt-6 text-center text-xl font-semibold tracking-tight text-foreground">
            {title}
          </h2>
          <p className="mx-auto mt-2 max-w-[320px] text-center text-sm leading-relaxed text-muted-foreground">
            {detail}
          </p>

          {/* Summary rows — one per step. Mirrors the FlowAI ready-to-automate
              card: icon block on the left, label + status text in the middle,
              status indicator on the right. */}
          <ol className="mt-8 grid gap-1.5">
            {steps.map((step, i) => {
              const isDone = i < activeStep;
              const isActive = i === activeStep;
              const status = isDone
                ? "Done"
                : isActive
                  ? "In progress…"
                  : "Up next";

              return (
                <li
                  className={cn(
                    "flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors shadow-subtle-xs",
                    isActive ? "bg-primary/[0.06]" : "bg-fg-2",
                  )}
                  key={step}
                >
                  <div
                    className={cn(
                      "flex size-7 shrink-0 items-center justify-center rounded-md transition-colors",
                      isDone
                        ? "bg-primary text-primary-foreground"
                        : isActive
                          ? "bg-background text-primary shadow-subtle-xs"
                          : "bg-background text-muted-foreground shadow-subtle-xs",
                    )}
                  >
                    {isDone ? (
                      <Check className="size-3.5" strokeWidth={3} />
                    ) : isActive ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <StatusDot variant="neutral" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p
                      className={cn(
                        "truncate text-sm transition-colors",
                        isDone || isActive
                          ? "font-medium text-foreground"
                          : "text-muted-foreground",
                      )}
                    >
                      {step}
                    </p>
                  </div>
                  <span
                    className={cn(
                      "shrink-0 text-xs tabular-nums transition-colors",
                      isActive
                        ? "text-primary"
                        : isDone
                          ? "text-muted-foreground"
                          : "text-muted-foreground/70",
                    )}
                  >
                    {status}
                  </span>
                </li>
              );
            })}
          </ol>
        </div>
      </div>
    </section>
  );
}
