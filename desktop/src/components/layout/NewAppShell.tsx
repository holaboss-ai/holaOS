/**
 * NewAppShell — side-by-side scaffold for the layout redesign.
 *
 * Gated by `VITE_NEW_LAYOUT_SHELL=1`. Pure visual skeleton — no state,
 * no providers, no IPC. Each region is a placeholder. Built out in
 * subsequent PRs (universal tabs → sidebar → chat panel → cohabited
 * browser). See `holaOS/docs/plans/2026-05-14-layout-redesign-audit.md`.
 */

export function NewAppShell() {
  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
      <TopChrome />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <Center />
        <ChatPanel />
      </div>
    </div>
  );
}

function TopChrome() {
  return (
    <header className="shrink-0 border-b border-border">
      <div className="h-7 border-b border-border" aria-hidden />
      <div className="flex h-9 items-center gap-2 px-3">
        <PlaceholderChip>tab</PlaceholderChip>
        <PlaceholderChip active>active tab</PlaceholderChip>
        <PlaceholderChip>tab</PlaceholderChip>
        <button
          type="button"
          className="ml-1 grid size-6 place-items-center rounded text-muted-foreground hover:bg-accent"
          aria-label="New tab"
        >
          +
        </button>
      </div>
    </header>
  );
}

function Sidebar() {
  return (
    <aside className="flex w-[260px] shrink-0 flex-col border-r border-border">
      <Zone label="Identity">
        <PlaceholderRow>🟧 Workspace ▾</PlaceholderRow>
      </Zone>
      <Zone label="Always-on">
        <PlaceholderRow>🔍 Search</PlaceholderRow>
        <PlaceholderRow>📥 Inbox</PlaceholderRow>
        <PlaceholderRow>📦 Artifacts</PlaceholderRow>
      </Zone>
      <Zone label="Work" grow>
        <PlaceholderRow>〰 Recents</PlaceholderRow>
        <PlaceholderRow>📌 Pinned</PlaceholderRow>
      </Zone>
      <Zone label="System">
        <PlaceholderRow>🔌 Apps</PlaceholderRow>
        <PlaceholderRow>🛒 Marketplace</PlaceholderRow>
        <PlaceholderRow>⚙ Settings</PlaceholderRow>
      </Zone>
      <Zone label="Account">
        <PlaceholderRow>👤 Account</PlaceholderRow>
      </Zone>
    </aside>
  );
}

function Center() {
  return (
    <main className="flex min-w-[480px] flex-1 items-center justify-center text-sm text-muted-foreground">
      Active focus (placeholder)
    </main>
  );
}

function ChatPanel() {
  return (
    <aside className="flex w-[480px] shrink-0 flex-col border-l border-border">
      <div className="flex h-9 items-center justify-between border-b border-border px-3 text-sm">
        <span>≣ Thread switcher</span>
        <span className="text-muted-foreground">⏷</span>
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-2 text-sm text-muted-foreground">
        Conversation (placeholder)
      </div>
      <div className="border-t border-border p-2">
        <div className="rounded-md border border-border px-3 py-2 text-sm text-muted-foreground">
          Ask anything...
        </div>
      </div>
    </aside>
  );
}

function Zone({
  label,
  grow,
  children,
}: {
  label: string;
  grow?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section
      className={`flex flex-col gap-0.5 border-b border-border px-2 py-2 ${
        grow ? "flex-1" : ""
      }`}
      aria-label={label}
    >
      {children}
    </section>
  );
}

function PlaceholderRow({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded px-2 py-1 text-sm text-foreground hover:bg-accent">
      {children}
    </div>
  );
}

function PlaceholderChip({
  active,
  children,
}: {
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`rounded-md px-3 py-1 text-xs ${
        active
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:bg-accent/50"
      }`}
    >
      {children}
    </div>
  );
}
