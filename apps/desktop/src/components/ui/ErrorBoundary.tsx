import * as Sentry from "@sentry/electron/renderer";
import { AlertTriangle, ChevronRight, RotateCw } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";

import { Button } from "@/components/ui/button";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  message: string;
}

/**
 * Last-resort renderer fallback when a React subtree throws. Stays as a
 * class component (only API for `componentDidCatch`) but the rendered
 * fallback uses the same restrained vocabulary as `BlockingErrorScreen` —
 * `bg-fg-2` canvas, single max-w-md card, no destructive fill or radial
 * gradients. We can't reuse `BlockingErrorScreen` directly without risking
 * a re-throw inside the boundary itself, so the markup is duplicated by
 * design. Friendly copy + Reload up top, technical detail behind a
 * disclosure (auto-open in dev) so a normal user isn't reading a stack
 * trace they can't act on.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = {
    hasError: false,
    message: "",
  };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      message: error.message || "Unknown renderer error",
    };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary]", error, info.componentStack);
    Sentry.captureException(error, {
      tags: {
        surface: "renderer_error_boundary",
      },
      extra: {
        page_url: window.location.href,
      },
      contexts: { react: { componentStack: info.componentStack } },
    });
  }

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    const detailsDefaultOpen = Boolean(import.meta.env.DEV);

    return (
      <main className="flex h-full min-h-0 min-w-0 items-center justify-center overflow-y-auto bg-fg-2 px-6 py-12">
        <div className="w-full max-w-md">
          <div className="rounded-2xl bg-background p-8 shadow-xs ring-1 ring-border/40 sm:p-10">
            <div className="flex size-9 items-center justify-center rounded-full bg-destructive/8 ring-1 ring-destructive/20">
              <AlertTriangle aria-hidden className="size-4 text-destructive" />
            </div>

            <h2 className="mt-5 text-xl font-semibold tracking-tight text-foreground sm:text-[22px]">
              Something went wrong
            </h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              Reloading usually fixes this. If it keeps happening after a
              reload, it's worth restarting the app.
            </p>

            <div className="mt-6">
              <Button
                className="w-full"
                onClick={this.handleReload}
                size="lg"
                type="button"
              >
                <RotateCw />
                Reload the app
              </Button>
            </div>

            <details className="group mt-6" open={detailsDefaultOpen}>
              <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-md py-1 text-xs text-muted-foreground transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
                <ChevronRight
                  aria-hidden
                  className="size-3 transition-transform group-open:rotate-90"
                />
                Show technical details
              </summary>
              <pre className="mt-2 overflow-auto rounded-lg bg-fg-2 px-3.5 py-3 font-mono text-xs leading-5 break-all whitespace-pre-wrap text-foreground/85">
                {this.state.message}
              </pre>
            </details>
          </div>
        </div>
      </main>
    );
  }
}
