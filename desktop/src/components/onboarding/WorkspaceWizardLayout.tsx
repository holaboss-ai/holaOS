import { ArrowRight, Loader2 } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface WizardAction {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  loading?: boolean;
  hideIcon?: boolean;
}

interface WorkspaceWizardLayoutProps {
  stepIndex: number;
  stepTotal: number;
  title: string;
  description?: string;
  /** Width of the inner card. */
  width?: "sm" | "md" | "lg";
  children: ReactNode;
  primary: WizardAction;
  secondary?: WizardAction;
  /** Tertiary ghost action shown below the action bar (e.g. "Skip"). */
  tertiary?: WizardAction;
  errorMessage?: string | null;
  /** Optional content (e.g. dynamic banner) rendered between body and action bar. */
  belowBody?: ReactNode;
}

const WIDTH_MAP: Record<NonNullable<WorkspaceWizardLayoutProps["width"]>, string> = {
  sm: "max-w-[420px]",
  md: "max-w-2xl",
  lg: "max-w-3xl",
};

export function WorkspaceWizardLayout({
  stepIndex,
  stepTotal,
  title,
  description,
  width = "md",
  children,
  primary,
  secondary,
  tertiary,
  errorMessage,
  belowBody,
}: WorkspaceWizardLayoutProps) {
  return (
    <div className="flex w-full flex-1 items-start justify-center px-5 pb-8">
      <div
        className={cn(
          "w-full rounded-2xl bg-background px-8 pt-9 pb-8 shadow-xs sm:px-10 sm:pt-10 sm:pb-9",
          WIDTH_MAP[width],
        )}
      >
        {/* Step counter — short dashes mirror the FlowAI reference but use our tokens */}
        <div className="flex items-center gap-2 text-xs text-muted-foreground tabular-nums">
          <span>
            Step {stepIndex} of {stepTotal}
          </span>
          <div className="ml-1 flex items-center gap-1">
            {Array.from({ length: stepTotal }).map((_, i) => (
              <span
                aria-hidden
                className={cn(
                  "h-[3px] w-5 rounded-full transition-colors",
                  i < stepIndex ? "bg-foreground" : "bg-fg-6",
                )}
                key={i}
              />
            ))}
          </div>
        </div>

        {/* Title + description */}
        <div className="mt-5">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            {title}
          </h1>
          {description ? (
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              {description}
            </p>
          ) : null}
        </div>

        {/* Body */}
        <div className="mt-7">{children}</div>

        {belowBody}

        {errorMessage ? (
          <div className="mt-5 rounded-lg bg-destructive/8 px-3 py-2.5 text-sm text-destructive">
            {errorMessage}
          </div>
        ) : null}

        {/* Action bar — matches publish flow */}
        <div className="mt-8 flex items-center gap-2.5">
          {secondary ? (
            <Button
              className="flex-1"
              disabled={secondary.disabled}
              onClick={secondary.onClick}
              size="lg"
              type="button"
              variant="bordered"
            >
              {secondary.label}
            </Button>
          ) : null}
          <Button
            className="flex-1"
            disabled={primary.disabled || primary.loading}
            onClick={primary.onClick}
            size="lg"
            type="button"
          >
            {primary.loading ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                {primary.label}
              </>
            ) : (
              <>
                {primary.label}
                {primary.hideIcon ? null : <ArrowRight className="size-3.5" />}
              </>
            )}
          </Button>
        </div>

        {tertiary ? (
          <div className="mt-4 text-center">
            <Button
              disabled={tertiary.disabled}
              onClick={tertiary.onClick}
              size="xs"
              type="button"
              variant="link"
            >
              {tertiary.label}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Attio-style field row used inside wizard steps: label above, control below,
 * help below that. Mirrors the `Field` helper in PublishScreen.
 */
export function WizardField({
  htmlFor,
  label,
  required,
  optional,
  help,
  children,
}: {
  htmlFor?: string;
  label: ReactNode;
  required?: boolean;
  optional?: boolean;
  help?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div>
      <label
        className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-foreground"
        htmlFor={htmlFor}
      >
        {label}
        {required ? <span className="text-destructive">*</span> : null}
        {optional ? (
          <span className="ml-0.5 text-xs font-normal text-muted-foreground">
            optional
          </span>
        ) : null}
      </label>
      {children}
      {help ? (
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
          {help}
        </p>
      ) : null}
    </div>
  );
}
