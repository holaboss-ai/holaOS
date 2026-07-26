import { holabossLogoUrl } from "@/lib/assetPaths";

interface BootSplashProps {
  /** Primary status line under the wordmark, e.g. "Optimizing storage…". */
  message?: string;
  /** Secondary explainer under the message. */
  submessage?: string;
  /** When set, renders a determinate progress bar + "done / total" readout. */
  progress?: { done: number; total: number } | null;
}

/**
 * Pinned to the viewport because the macOS body is translucent for vibrancy —
 * a non-fixed pane would leave a thin desktop-coloured frame around the splash.
 *
 * The look is unified: it's ALWAYS the plain logo + "Holaboss" + dots. A
 * `message` adds a status line (runtime boot, org switch); a `progress` attaches
 * a thin determinate bar BELOW the dots (the first-run DB storage sweep) — the
 * same splash, just with progress, never a distinct-looking maintenance screen.
 */
export function BootSplash({ message, submessage, progress }: BootSplashProps = {}) {
  const total = progress && progress.total > 0 ? progress.total : 0;
  const done = progress ? Math.min(progress.done, total || progress.done) : 0;
  const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;

  return (
    <section className="fixed inset-0 z-20 flex items-center justify-center overflow-hidden bg-background px-6">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 60% 50% at 50% 42%, color-mix(in srgb, var(--primary) 10%, transparent), transparent 70%)",
        }}
      />
      <div
        className="relative flex flex-col items-center text-center"
        style={{ animation: "var(--animate-fade-in-once)" }}
      >
        <div className="relative flex h-16 w-16 items-center justify-center">
          <img
            alt="holaOS"
            className="relative h-14 w-14 rounded-2xl select-none"
            draggable={false}
            height={56}
            src={holabossLogoUrl}
            width={56}
          />
        </div>
        <h1
          className="mt-6 text-[17px] font-semibold tracking-tight text-foreground"
          style={{ letterSpacing: "-0.01em" }}
        >
          holaOS
        </h1>

        {message ? (
          <p className="mt-3 text-[13px] font-medium text-foreground/90">
            {message}
          </p>
        ) : null}
        {submessage ? (
          <p className="mt-1 max-w-xs text-xs text-muted-foreground">
            {submessage}
          </p>
        ) : null}

        {/* The dots are the plain splash's signature and stay on every state. */}
        <div
          aria-label="Loading"
          className="mt-5 flex items-center gap-1.5"
          role="status"
        >
          {[0, 1, 2].map((i) => (
            <span
              className="block h-1 w-1 rounded-full bg-muted-foreground/70"
              key={i}
              style={{
                animation: "holaboss-splash-dot 1.2s ease-in-out infinite",
                animationDelay: `${i * 160}ms`,
              }}
            />
          ))}
        </div>

        {/* A determinate progress bar attaches BELOW the plain splash (e.g. the
            first-run storage sweep) — same splash, just with progress. */}
        {total > 0 ? (
          <div className="mt-4 flex w-64 flex-col items-center gap-1.5">
            <div
              aria-label="Progress"
              aria-valuemax={100}
              aria-valuemin={0}
              aria-valuenow={percent}
              className="h-1 w-full overflow-hidden rounded-full bg-muted"
              role="progressbar"
            >
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-500 ease-out"
                style={{ width: `${percent}%` }}
              />
            </div>
            <span className="text-[11px] text-muted-foreground tabular-nums">
              {done.toLocaleString()} / {total.toLocaleString()} · {percent}%
            </span>
          </div>
        ) : null}
      </div>
    </section>
  );
}
