import { ReactNode } from "react";

interface PaneCardProps {
  title?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function PaneCard({ title, actions, children, className = "" }: PaneCardProps) {
  const hasHeader = Boolean(title) || Boolean(actions);

  return (
    <section
      data-pane-card="true"
      className={`relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-xl bg-card shadow-md backdrop-blur-sm ${className}`}
    >
      {hasHeader ? (
        <header className="flex shrink-0 items-center justify-between border-b border-border px-4 py-2.5">
          {title ? <h2 className="text-xs font-semibold uppercase tracking-widest text-foreground">{title}</h2> : <span />}
          <div className="flex items-center gap-1.5">{actions}</div>
        </header>
      ) : null}
      <div className="min-h-0 flex-1">{children}</div>
    </section>
  );
}
