import { useSetAtom } from "jotai";
import { useState } from "react";
import { apiKeyConnectedAppsAtom } from "@/components/layout/shell/state/ui";
import { Button } from "@/components/ui/button";
import { ArrowUpRight, KeyRound, LoaderCircle } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import type { ApiKeyGateConfig } from "@/lib/holaAppMarketplace";

/**
 * SURFACE-based install-gate overlay (OmniSocials, Publora). ChatPane renders it
 * whenever an API-key app's surface is open and its key isn't connected yet. It
 * explains how to get a key and takes it; on submit it connects the app's own
 * MCP server (holaApps:attachApiKeyMcp → main attachCustomMcpServer → the
 * runtime's mcp_connect) and marks the app connected, which clears the gate +
 * re-enables the composer. An absolute overlay in the chat panel's DOM (the app
 * surface beside it is a BrowserView, so a DOM overlay must live in the panel).
 */
export function ApiKeyInstallGate({ gate }: { gate: ApiKeyGateConfig }) {
  const setConnectedApps = useSetAtom(apiKeyConnectedAppsAtom);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    const key = apiKey.trim();
    if (!key || busy) {
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await window.electronAPI.holaApps.attachApiKeyMcp({
        holaAppId: gate.holaAppId,
        mcpUrl: gate.mcpUrl,
        apiKey: key,
        auth: gate.auth,
      });
      if (!result.ok) {
        // Key was rejected (or unverifiable) — keep the gate blocked and show the
        // server's reason so the user can fix it.
        setError(
          result.error ??
            `Couldn't verify that key for ${gate.title}. Check it and try again.`,
        );
        setBusy(false);
        return;
      }
      // Valid key attached → mark connected; the surface-based gate clears + the
      // composer unlocks.
      setConnectedApps((prev) => ({ ...prev, [gate.holaAppId]: true }));
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : `Couldn't connect ${gate.title}. Check the key and try again.`,
      );
      setBusy(false);
    }
  };

  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-background/80 p-6 backdrop-blur-sm">
      <div className="w-full max-w-sm rounded-xl border border-border bg-card p-5 shadow-xl">
        <div className="flex items-center gap-2.5">
          <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
            <KeyRound className="size-4" />
          </div>
          <div className="min-w-0">
            <div className="font-medium text-foreground text-sm">
              Connect {gate.title}
            </div>
            <div className="text-muted-foreground text-xs">
              Add your API key to unlock this chat.
            </div>
          </div>
        </div>

        <ol className="mt-4 flex flex-col gap-1.5 text-muted-foreground text-xs leading-relaxed">
          {gate.keyInstructions ? (
            <li>
              <span className="font-medium text-foreground">
                1. {gate.keyInstructions.title}
              </span>
              <br />
              {gate.keyInstructions.detail}
            </li>
          ) : (
            <>
              <li>1. Sign in to {gate.title} in the window beside this chat.</li>
              <li>
                2. Then create an API key
                {gate.instructionsUrl ? (
                  <>
                    {" at "}
                    <a
                      className="inline-flex items-center gap-0.5 text-primary hover:underline"
                      href={gate.instructionsUrl}
                      rel="noreferrer"
                      target="_blank"
                    >
                      Settings → API
                      <ArrowUpRight className="size-3" />
                    </a>
                  </>
                ) : null}
                .
              </li>
            </>
          )}
          <li>
            {gate.keyInstructions ? "2" : "3"}. Paste it below to connect it to
            your agent.
          </li>
        </ol>

        <div className="mt-4 flex flex-col gap-2">
          {/* biome-ignore lint/a11y/noAutofocus: gate is the sole focus target on open */}
          <Input
            autoFocus
            onChange={(event) => setApiKey(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void submit();
              }
            }}
            placeholder="Paste your API key"
            type="password"
            value={apiKey}
          />
          {error ? <p className="text-destructive text-xs">{error}</p> : null}
          <Button
            className="w-full"
            disabled={busy || apiKey.trim().length === 0}
            onClick={() => void submit()}
            size="sm"
            type="button"
          >
            {busy ? <LoaderCircle className="size-4 animate-spin" /> : null}
            Connect {gate.title}
          </Button>
        </div>
      </div>
    </div>
  );
}
