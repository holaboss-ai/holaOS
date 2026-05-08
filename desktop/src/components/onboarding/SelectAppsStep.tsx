import { Check, Lock } from "lucide-react";
import { cn } from "@/lib/utils";
import { WorkspaceWizardLayout } from "./WorkspaceWizardLayout";

interface SelectAppsStepProps {
  stepIndex: number;
  stepTotal: number;
  template: TemplateMetadataPayload;
  selectedApps: Set<string>;
  onToggleApp: (appName: string) => void;
  onBack: () => void;
  onContinue: () => void;
}

export function SelectAppsStep({
  stepIndex,
  stepTotal,
  template,
  selectedApps,
  onToggleApp,
  onBack,
  onContinue,
}: SelectAppsStepProps) {
  const apps = template.apps;
  const minOptional = template.min_optional_apps ?? 0;
  const optionalSelectedCount = [...selectedApps].filter(
    (name) => !apps.find((a) => a.name === name && a.required),
  ).length;
  const canContinue = minOptional === 0 || optionalSelectedCount >= minOptional;

  const description =
    minOptional > 0
      ? `Pick the apps to install. At least ${minOptional} optional app${
          minOptional === 1 ? "" : "s"
        } required.`
      : "Pick the apps to install in this workspace.";

  return (
    <WorkspaceWizardLayout
      description={description}
      primary={{
        label: "Continue",
        onClick: onContinue,
        disabled: !canContinue,
      }}
      secondary={{ label: "Back", onClick: onBack }}
      stepIndex={stepIndex}
      stepTotal={stepTotal}
      title="Choose your apps"
      width="md"
    >
      <ul className="grid gap-1.5">
        {apps.map((app) => {
          const isChecked = selectedApps.has(app.name);
          const isLocked = app.required;
          return (
            <li key={app.name}>
              <button
                aria-pressed={isChecked}
                className={cn(
                  "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors shadow-2xs focus-visible:[box-shadow:none!important]",
                  isChecked ? "bg-primary/[0.06]" : "bg-fg-2 hover:bg-fg-4",
                  isLocked ? "cursor-default" : "cursor-pointer",
                )}
                disabled={isLocked}
                onClick={() => onToggleApp(app.name)}
                type="button"
              >
                <span
                  className={cn(
                    "flex size-4 shrink-0 items-center justify-center rounded border transition-colors",
                    isChecked
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-fg-24 bg-background",
                  )}
                >
                  {isChecked ? <Check className="size-3" strokeWidth={3} /> : null}
                </span>
                <span className="flex-1 text-sm font-medium capitalize text-foreground">
                  {app.name}
                </span>
                {isLocked ? (
                  <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                    <Lock className="size-3" />
                    Required
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
    </WorkspaceWizardLayout>
  );
}
