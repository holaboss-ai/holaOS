import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Check,
  CircleAlert,
  LoaderCircle,
  ShieldCheck,
} from "@/components/ui/icons";
import type { ChatMcpAuthorization } from "../types";

// Inline "Authorize" card for a remote MCP server that reported `auth_required`
// during discovery (e.g. HeyGen). Lets the user run the OAuth flow right in the
// chat instead of navigating to Settings → MCP: the runtime opens the system
// browser and blocks on consent, then the server's tools apply next turn.
export function AssistantTurnMcpAuthorizations({
  mcpAuthorizations,
  workspaceId,
  createdAt,
  onAfterAuthorize,
}: {
  mcpAuthorizations: ChatMcpAuthorization[];
  workspaceId: string | null;
  /** When this turn was produced — used to age out stale prompts. */
  createdAt?: string;
  /** Auto-continue the turn once the server is authorized (discover its tools). */
  onAfterAuthorize?: (serverId: string) => void;
}) {
  if (mcpAuthorizations.length === 0) {
    return null;
  }
  const seen = new Set<string>();
  const unique = mcpAuthorizations.filter((entry) => {
    const key = entry.serverId.trim().toLowerCase();
    if (!key || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
  return (
    <div className="mt-3 flex flex-col gap-2">
      {unique.map((entry) => (
        <McpAuthorizeCard
          key={entry.serverId}
          serverId={entry.serverId}
          reauthorize={entry.reauthorize === true}
          workspaceId={workspaceId}
          createdAt={createdAt}
          onAfterAuthorize={onAfterAuthorize}
        />
      ))}
    </div>
  );
}

// Bound the "Signing in…" spinner: a hair above the runtime's outer authorize
// timeout (~195s) so the prior attempt has released the fixed callback port and
// an immediate "Try again" works.
const AUTHORIZE_WATCHDOG_MS = 200_000;
// An untouched Authorize prompt older than this is treated as stale (from a past
// session) — it renders muted/de-emphasized instead of a live red button.
const AUTHORIZE_STALE_MS = 10 * 60 * 1000;

function isStalePrompt(createdAt?: string): boolean {
  if (!createdAt) {
    return false;
  }
  const at = Date.parse(createdAt);
  return Number.isFinite(at) && Date.now() - at > AUTHORIZE_STALE_MS;
}

/** The runtime rejected the authorize because the server no longer exists. */
function isNotRegistered(detail?: string): boolean {
  return typeof detail === "string" && /not registered/i.test(detail);
}

type CardState =
  | { kind: "idle" }
  // Already authorized (a valid token exists) — a stale card from an earlier
  // session self-corrects to a muted "Authorized" instead of a live button.
  | { kind: "already" }
  // A prompt from a past session that was never acted on — de-emphasized.
  | { kind: "expired" }
  // The server was uninstalled since this card was shown — nothing to authorize.
  | { kind: "removed" }
  | { kind: "authorizing" }
  | { kind: "done"; toolCount: number }
  | { kind: "error"; detail: string };

function McpAuthorizeCard({
  serverId,
  reauthorize = false,
  workspaceId,
  createdAt,
  onAfterAuthorize,
}: {
  serverId: string;
  reauthorize?: boolean;
  workspaceId: string | null;
  createdAt?: string;
  onAfterAuthorize?: (serverId: string) => void;
}) {
  // A prompt from a past session (untouched, older than the stale window) starts
  // de-emphasized rather than as a loud red button. Re-authorize cards are always
  // fresh (agent-initiated this turn), so never stale.
  const [state, setState] = useState<CardState>(() =>
    !reauthorize && isStalePrompt(createdAt) ? { kind: "expired" } : { kind: "idle" },
  );

  // Self-correct: if the server is already authorized (has a valid token), show
  // "Authorized" instead of an idle/expired prompt. Skip for re-authorize cards
  // (the whole point there is to re-run even when already signed in).
  useEffect(() => {
    if (reauthorize || !workspaceId) {
      return;
    }
    let cancelled = false;
    window.electronAPI.workspace
      .mcpServerAuthorized(workspaceId, serverId)
      .then((result) => {
        if (cancelled) {
          return;
        }
        // Resolve idle/expired prompts against reality: server gone → "removed";
        // already has a token → "already". Don't override an in-flight/terminal
        // action the user has taken.
        setState((current) => {
          if (current.kind !== "idle" && current.kind !== "expired") {
            return current;
          }
          if (result.registered === false) {
            return { kind: "removed" };
          }
          if (result.authorized) {
            return { kind: "already" };
          }
          return current;
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [workspaceId, serverId, reauthorize]);

  const authorize = async () => {
    if (!workspaceId || state.kind === "authorizing") {
      return;
    }
    setState({ kind: "authorizing" });
    // Watchdog: the underlying sign-in attempt (its loopback callback server)
    // only stays live for the auth window, after which completing consent no
    // longer works. Don't let "Signing in…" spin past that — surface a clear
    // timed-out state (with a usable "Try again") once the window has elapsed.
    // Set slightly ABOVE the runtime's outer timeout so the previous attempt has
    // already released the fixed callback port, making an immediate retry work.
    let settled = false;
    const watchdog = setTimeout(() => {
      if (!settled) {
        settled = true;
        setState({
          kind: "error",
          detail: "Sign-in timed out — the browser sign-in wasn't completed in time.",
        });
      }
    }, AUTHORIZE_WATCHDOG_MS);
    try {
      const result = await window.electronAPI.workspace.authorizeMcpServer(
        workspaceId,
        serverId,
        reauthorize,
      );
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(watchdog);
      if (result.ok) {
        setState({ kind: "done", toolCount: result.tool_count });
        // Auto-continue: queue a turn so the newly-authorized server's tools get
        // discovered and the agent proceeds — no manual "send one more message".
        onAfterAuthorize?.(serverId);
      } else {
        setState(
          isNotRegistered(result.detail)
            ? { kind: "removed" }
            : { kind: "error", detail: result.detail || "Authorization failed." },
        );
      }
    } catch (error) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(watchdog);
      const detail = error instanceof Error ? error.message : "Request failed.";
      // The server was uninstalled between showing the card and clicking — show
      // "removed" rather than a raw "not registered" error.
      setState(
        isNotRegistered(detail)
          ? { kind: "removed" }
          : { kind: "error", detail },
      );
    }
  };

  if (state.kind === "done") {
    const count = state.toolCount;
    return (
      <div className="flex max-w-[380px] items-center gap-3 rounded-xl border border-border bg-card px-3 py-2.5 text-sm text-foreground">
        <div className="grid size-7 shrink-0 place-items-center rounded-md bg-emerald-500/15 text-emerald-600">
          <Check className="size-3.5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">
            {reauthorize ? "Re-authorized" : "Authorized"} {serverId}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {count > 0
              ? `${count} tool${count === 1 ? "" : "s"} available.`
              : "Loading its tools…"}
          </div>
        </div>
      </div>
    );
  }

  // Stale card whose server is already connected — show a muted, non-actionable
  // confirmation instead of a live Authorize button.
  if (state.kind === "already") {
    return (
      <div className="flex max-w-[380px] items-center gap-3 rounded-xl border border-border bg-card px-3 py-2.5 text-sm text-muted-foreground">
        <div className="grid size-7 shrink-0 place-items-center rounded-md bg-emerald-500/15 text-emerald-600">
          <Check className="size-3.5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-foreground">
            {serverId} authorized
          </div>
          <div className="truncate text-xs">
            Already signed in — its tools are available.
          </div>
        </div>
      </div>
    );
  }

  // The server was uninstalled since this card was shown — there's nothing to
  // authorize (authorizing would just error "not registered").
  if (state.kind === "removed") {
    return (
      <div className="flex max-w-[380px] items-center gap-3 rounded-xl border border-border bg-card px-3 py-2.5 text-sm text-muted-foreground">
        <div className="grid size-7 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
          <ShieldCheck className="size-3.5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-foreground">
            {serverId} is no longer connected
          </div>
          <div className="truncate text-xs">
            Reconnect the server to authorize and use its tools.
          </div>
        </div>
      </div>
    );
  }

  // A prompt left over from an earlier session — de-emphasized (no loud red
  // button), but still clickable via a subtle action if the user does want to
  // sign in now (a fresh attempt runs).
  if (state.kind === "expired") {
    return (
      <div className="flex max-w-[380px] items-center gap-3 rounded-xl border border-border bg-card px-3 py-2.5 text-sm text-muted-foreground">
        <div className="grid size-7 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
          <ShieldCheck className="size-3.5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-foreground">
            Authorize {serverId}
          </div>
          <div className="truncate text-xs">
            From an earlier session — click to sign in, or use Settings → MCP.
          </div>
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="shrink-0"
          disabled={!workspaceId}
          onClick={() => void authorize()}
        >
          Authorize
        </Button>
      </div>
    );
  }

  const authorizing = state.kind === "authorizing";
  const erroredOnce = state.kind === "error";
  const idleActionLabel = erroredOnce
    ? "Try again"
    : reauthorize
      ? "Switch account"
      : "Authorize";
  return (
    <div className="flex max-w-[380px] flex-col gap-2 rounded-xl border border-border bg-card px-3 py-3">
      <div className="flex items-center gap-3">
        <div className="grid size-7 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
          <ShieldCheck className="size-3.5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-foreground">
            {reauthorize ? `Re-authorize ${serverId}` : `Authorize ${serverId}`}
          </div>
          <div className="text-xs text-muted-foreground">
            {authorizing
              ? "Complete the sign-in in the browser window that just opened — no need to send another message."
              : reauthorize
                ? "Sign in again to switch the connected account. (Sign out of the current account in your browser first to change it.)"
                : "This MCP server needs sign-in before its tools work."}
          </div>
        </div>
      </div>
      <div className="flex items-center justify-end gap-2">
        <Button
          size="sm"
          disabled={!workspaceId || authorizing}
          onClick={() => void authorize()}
        >
          {authorizing ? (
            <LoaderCircle size={13} className="animate-spin" />
          ) : (
            <ShieldCheck size={13} />
          )}
          {authorizing ? "Signing in…" : idleActionLabel}
        </Button>
      </div>
      {state.kind === "error" ? (
        <div className="flex items-start gap-2.5 rounded-md border border-destructive/30 bg-destructive/[0.04] px-2.5 py-2 text-xs">
          <CircleAlert
            className="mt-px size-3.5 shrink-0 text-destructive"
            strokeWidth={2}
          />
          <span className="leading-relaxed text-muted-foreground">
            {state.detail}
          </span>
        </div>
      ) : null}
    </div>
  );
}
