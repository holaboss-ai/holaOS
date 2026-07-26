import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { useSetAtom } from "jotai";
import { useEffect, useRef, useState } from "react";
import { overlayOpenCountAtom } from "@/components/layout/shell/overlay-presence";
import { Button } from "@/components/ui/button";
import { AppWindow, Loader2, Plus, X } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
	type CustomHolaApp,
	customHolaAppId,
	deleteCustomHolaApp,
	normalizeRemoteUrl,
	parseCustomMcpConfig,
	upsertCustomHolaApp,
} from "@/lib/localCustomHolaApps";

// Lead with the simplest form — a bare URL — so the field doesn't look like it demands
// a full JSON blob. The help text + parser also accept a { mcpServers } config and an
// `npx mcp-remote <url>` config.
const MCP_PLACEHOLDER = `https://mcp.example.com/mcp

…or a full JSON / "npx mcp-remote <url>" config`;

// Run the browser OAuth for a just-added custom app's MCP. The MCP attaches
// asynchronously (onChanged → catalog refresh → syncAppOwned), so poll until the
// server registers, then run the runtime's system-browser authorize (the same path
// as the inline chat Authorize card). Best-effort: any failure/timeout is swallowed
// — the agent's reactive Authorize card prompts when it first uses the tools.
async function runCustomAppOAuth(
	workspaceId: string,
	serverId: string,
): Promise<{ ok: boolean; reason: string }> {
	for (let attempt = 0; attempt < 8; attempt += 1) {
		const status = await window.electronAPI.workspace.mcpServerAuthorized(
			workspaceId,
			serverId,
		);
		if (status.authorized) {
			return { ok: true, reason: "" };
		}
		if (status.registered !== false) {
			const result = await window.electronAPI.workspace.authorizeMcpServer(
				workspaceId,
				serverId,
				false,
			);
			return { ok: result.ok === true, reason: result.detail ?? "" };
		}
		await new Promise((resolve) => setTimeout(resolve, 1200));
	}
	return { ok: false, reason: "the MCP server didn't register in time" };
}

// A small "create your own app" form: a URL the desktop opens as the app's surface,
// plus an OPTIONAL MCP server (pasted as an mcpServers-style JSON config) whose tools
// the agent gains. Everything is stored on this machine (localCustomHolaApps) — no
// backend. onChanged refreshes the shared HolaApp catalog so the new app (and its MCP)
// shows in the grid + sidebar; the dialog then closes. Manage/remove custom apps from
// their card in Customize → Apps.
//
// Rendered as a Dialog above the native BrowserView layer, bumping the shell overlay
// counter so the surface detaches — same pattern as McpInstallDialog.
export function CustomHolaAppCreateDialog({
	open,
	onOpenChange,
	onChanged,
	workspaceId,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** Called after a custom app is created — refresh the app catalog. */
	onChanged: () => void;
	/** Active workspace — needed to run a header-less MCP's OAuth after adding. */
	workspaceId: string | null;
}) {
	const setOverlayCount = useSetAtom(overlayOpenCountAtom);
	useEffect(() => {
		if (!open) {
			return;
		}
		setOverlayCount((c) => c + 1);
		return () => {
			setOverlayCount((c) => Math.max(0, c - 1));
		};
	}, [open, setOverlayCount]);

	const [title, setTitle] = useState("");
	const [url, setUrl] = useState("");
	const [iconUrl, setIconUrl] = useState("");
	const [mcpJson, setMcpJson] = useState("");
	const [error, setError] = useState("");
	const [phase, setPhase] = useState<"idle" | "authorizing">("idle");
	// The just-saved app awaiting sign-in — kept so a cancel can roll it back. authAbort
	// guards handleCreate's success path when the user cancels while OAuth is in flight.
	const pendingAppIdRef = useRef<string | null>(null);
	const authAbortRef = useRef(false);

	const resetForm = () => {
		setTitle("");
		setUrl("");
		setIconUrl("");
		setMcpJson("");
		setError("");
	};

	const validUrl = (value: string): boolean => {
		try {
			const parsed = new URL(value);
			return parsed.protocol === "http:" || parsed.protocol === "https:";
		} catch {
			return false;
		}
	};

	const handleCreate = async () => {
		const trimmedTitle = title.trim();
		const trimmedUrl = normalizeRemoteUrl(url);
		if (!trimmedTitle) {
			setError("Give your app a name.");
			return;
		}
		if (!validUrl(trimmedUrl)) {
			setError("Enter a valid URL for the app to open.");
			return;
		}
		setError("");

		const holaAppId = pendingAppIdRef.current ?? customHolaAppId(trimmedTitle);
		let mcp: CustomHolaApp["mcp"];
		const rawMcp = mcpJson.trim();
		if (rawMcp) {
			const parsed = parseCustomMcpConfig(rawMcp, holaAppId);
			if ("error" in parsed) {
				setError(parsed.error);
				return;
			}
			mcp = parsed.attach;
		}

		const app: CustomHolaApp = {
			holaAppId,
			title: trimmedTitle,
			url: trimmedUrl,
			...(iconUrl.trim() ? { iconUrl: iconUrl.trim() } : {}),
			...(mcp ? { mcp } : {}),
			...(rawMcp ? { mcpConfigJson: rawMcp } : {}),
		};
		// A header-less MCP is the OAuth case (a static-token server is already usable). The
		// app is only KEPT if sign-in succeeds: save it as a DRAFT (`pending`) so the MCP
		// attaches (auth needs it registered) yet a killed session's leftover can be purged on
		// startup; a retry reuses it, it commits on success, and it's discarded if you close.
		const needsOAuth =
			Boolean(mcp) && Object.keys(mcp?.headerKeys ?? {}).length === 0;
		upsertCustomHolaApp(needsOAuth ? { ...app, pending: true } : app);
		// Fire the catalog refresh — attaches the app-owned MCP + shows the app.
		onChanged();

		if (needsOAuth && workspaceId && mcp) {
			pendingAppIdRef.current = holaAppId;
			authAbortRef.current = false;
			setPhase("authorizing");
			let ok = false;
			let reason = "";
			try {
				const result = await runCustomAppOAuth(workspaceId, mcp.id);
				ok = result.ok;
				reason = result.reason;
			} catch {
				// reactive fallback — ignore
			}
			setPhase("idle");
			if (authAbortRef.current) {
				return;
			}
			if (!ok) {
				// Keep the draft (same id) so a retry reuses the SAME server, no attach/detach
				// churn or a conflicting sign-in; it's discarded when the dialog is closed.
				setError(
					reason
						? `Sign-in didn't complete: ${reason}. Try again, or close to discard.`
						: "Sign-in didn't complete. Try again to authorize, or close to discard.",
				);
				return;
			}
			// Authorized — commit the app (drop its draft `pending` flag).
			upsertCustomHolaApp(app);
		}

		// Committed — release the draft so a later add starts a fresh app.
		pendingAppIdRef.current = null;
		resetForm();
		onOpenChange(false);
	};

	const busy = phase === "authorizing";

	const handleRootOpenChange = (next: boolean) => {
		// Closing the dialog (Cancel / X / Esc / backdrop) discards any un-committed draft
		// app, so a cancelled or abandoned sign-in never leaves an app behind.
		if (!next) {
			authAbortRef.current = true;
			if (pendingAppIdRef.current) {
				deleteCustomHolaApp(pendingAppIdRef.current);
				pendingAppIdRef.current = null;
				onChanged();
			}
			setPhase("idle");
		}
		onOpenChange(next);
	};

	return (
		<DialogPrimitive.Root onOpenChange={handleRootOpenChange} open={open}>
			<DialogPrimitive.Portal>
				<DialogPrimitive.Backdrop className="fixed inset-0 z-[90] bg-foreground/20 backdrop-blur-sm ease-emphasized data-open:duration-snappy data-open:animate-in data-open:fade-in-0 data-closed:duration-tap data-closed:animate-out data-closed:fade-out-0" />
				<DialogPrimitive.Popup className="fixed top-[12%] left-1/2 z-[100] flex max-h-[80vh] w-[520px] -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-border bg-popover shadow-2xl outline-none ease-emphasized data-open:duration-snappy data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:duration-tap data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95">
					<div className="flex items-center gap-3 border-border border-b px-4 py-3">
						<div className="grid size-9 shrink-0 place-items-center rounded-lg border border-border bg-background">
							<AppWindow className="size-5 text-muted-foreground" />
						</div>
						<div className="min-w-0 flex-1">
							<DialogPrimitive.Title className="truncate font-medium text-foreground text-sm">
								Create your own app
							</DialogPrimitive.Title>
							<DialogPrimitive.Description className="mt-0.5 text-muted-foreground text-xs">
								A URL the app opens, plus an optional MCP server for its tools.
								Stored only on this device.
							</DialogPrimitive.Description>
						</div>
						<DialogPrimitive.Close
							aria-label="Close"
							className="grid size-7 shrink-0 place-items-center rounded-md text-foreground/60 transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
						>
							<X className="size-3.5" />
						</DialogPrimitive.Close>
					</div>

					<div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
						<div className="flex flex-col gap-1.5">
							<Label
								className="text-foreground text-xs"
								htmlFor="custom-app-name"
							>
								Name
							</Label>
							<Input
								autoComplete="off"
								id="custom-app-name"
								onChange={(event) => setTitle(event.target.value)}
								placeholder="My App"
								value={title}
							/>
						</div>

						<div className="flex flex-col gap-1.5">
							<Label
								className="text-foreground text-xs"
								htmlFor="custom-app-url"
							>
								URL
							</Label>
							<Input
								autoComplete="off"
								id="custom-app-url"
								onChange={(event) => setUrl(event.target.value)}
								placeholder="https://example.com"
								value={url}
							/>
							<p className="text-muted-foreground text-xs">
								The page the app opens as its surface, next to your agent.
							</p>
						</div>

						<div className="flex flex-col gap-1.5">
							<Label
								className="text-foreground text-xs"
								htmlFor="custom-app-icon"
							>
								Icon URL{" "}
								<span className="text-muted-foreground">(optional)</span>
							</Label>
							<Input
								autoComplete="off"
								id="custom-app-icon"
								onChange={(event) => setIconUrl(event.target.value)}
								placeholder="https://example.com/favicon.ico"
								value={iconUrl}
							/>
						</div>

						<div className="flex flex-col gap-1.5">
							<Label
								className="text-foreground text-xs"
								htmlFor="custom-app-mcp"
							>
								MCP server{" "}
								<span className="text-muted-foreground">(optional)</span>
							</Label>
							<Textarea
								autoComplete="off"
								className="min-h-[132px] font-mono text-xs"
								id="custom-app-mcp"
								onChange={(event) => setMcpJson(event.target.value)}
								placeholder={MCP_PLACEHOLDER}
								spellCheck={false}
								value={mcpJson}
							/>
							<p className="text-muted-foreground text-xs">
								Gives the agent this app's tools. Paste a JSON config, an{" "}
								<code>npx mcp-remote &lt;url&gt;</code> config, or just the
								remote server URL. Add auth headers for a static token, or leave
								them out and we'll open sign-in (OAuth) when you add it. Kept on
								this device.
							</p>
						</div>

						{error ? <p className="text-destructive text-xs">{error}</p> : null}
					</div>

					<div className="flex items-center justify-end gap-2 border-border border-t px-4 py-3">
						<DialogPrimitive.Close
							render={
								<Button size="sm" type="button" variant="ghost">
									{busy ? "Cancel sign-in" : "Cancel"}
								</Button>
							}
						/>
						<Button
							disabled={busy || !title.trim() || !url.trim()}
							onClick={() => void handleCreate()}
							size="sm"
							type="button"
						>
							{busy ? (
								<Loader2 className="size-3.5 animate-spin" />
							) : (
								<Plus className="size-3.5" />
							)}
							{busy ? "Signing in…" : "Add app"}
						</Button>
					</div>
				</DialogPrimitive.Popup>
			</DialogPrimitive.Portal>
		</DialogPrimitive.Root>
	);
}
