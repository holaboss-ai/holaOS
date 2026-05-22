import { holabossLogoUrl } from "@/lib/assetPaths";

/**
 * Pinned to the viewport because the macOS body is translucent for vibrancy —
 * a non-fixed pane would leave a thin desktop-coloured frame around the splash.
 */
export function BootSplash() {
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
      </div>
    </section>
  );
}
