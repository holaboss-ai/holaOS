import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { useSetAtom } from "jotai";
import { useCallback, useEffect, useState } from "react";
import { overlayOpenCountAtom } from "@/components/layout/shell/overlay-presence";
import { Button } from "@/components/ui/button";
import {
	AppWindow,
	Globe,
	Loader2,
	Plus,
	ShieldCheck,
	X,
} from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
	type CustomHolaApp,
	customHolaAppId,
	deleteCustomHolaApp,
	parseCustomMcpConfig,
	readCustomHolaApps,
	upsertCustomHolaApp,
} from "@/lib/localCustomHolaApps";
import { HolaAppIcon } from "./HolaAppIcon";

const MCP_PLACEHOLDER = `{
  "mcpServers": {
    "my-server": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}`;

// Manage LOCAL, user-created HolaApps: an app is a URL the desktop opens as its
// surface plus an OPTIONAL MCP server (pasted as an mcpServers-style JSON config)
// whose tools the agent gains while the app is installed. Everything is stored on
// this machine (localCustomHolaApps) — no backend. onChanged refreshes the shared
// HolaApp catalog so the new/removed app (and its MCP) reflects in the grid + sidebar.
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
	/** Called after a custom app is created or removed — refresh the app catalog. */
	onChanged: () => void;
	/** Active workspace — needed to run/check a custom MCP's OAuth authorization. */
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

	const [apps, setApps] = useState<CustomHolaApp[]>([]);
	const [title, setTitle] = useState("");
	const [url, setUrl] = useState("");
	const [iconUrl, setIconUrl] = useState("");
	const [mcpJson, setMcpJson] = useState("");
	const [error, setError] = useState("");
	const [saving, setSaving] = useState(false);

	const reload = useCallback(() => setApps(readCustomHolaApps()), []);
	useEffect(() => {
		if (open) {
			reload();
		}
	}, [open, reload]);

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

	const handleCreate = () => {
		const trimmedTitle = title.trim();
		const trimmedUrl = url.trim();
		if (!trimmedTitle) {
			setError("Give your app a name.");
			return;
		}
		if (!validUrl(trimmedUrl)) {
			setError("Enter a valid http(s) URL for the app to open.");
			return;
		}
		setSaving(true);
		setError("");
		try {
			const holaAppId = customHolaAppId(trimmedTitle);
			let mcp: CustomHolaApp["mcp"];
			const rawMcp = mcpJson.trim();
			if (rawMcp) {
				const parsed = parseCustomMcpConfig(rawMcp, holaAppId);
				if ("error" in parsed) {
					setError(parsed.error);
					setSaving(false);
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
			upsertCustomHolaApp(app);
			resetForm();
			reload();
			onChanged();
		} finally {
			setSaving(false);
		}
	};

	const handleRemove = (holaAppId: string) => {
		deleteCustomHolaApp(holaAppId);
		reload();
		onChanged();
	};

	return (
		<DialogPrimitive.Root onOpenChange={onOpenChange} open={open}>
			<DialogPrimitive.Portal>
				<DialogPrimitive.Backdrop className="fixed inset-0 z-[90] bg-foreground/20 backdrop-blur-sm ease-emphasized data-open:duration-snappy data-open:animate-in data-open:fade-in-0 data-closed:duration-tap data-closed:animate-out data-closed:fade-out-0" />
				<DialogPrimitive.Popup className="fixed top-[10%] left-1/2 z-[100] flex max-h-[80vh] w-[520px] -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-border bg-popover shadow-2xl outline-none ease-emphasized data-open:duration-snappy data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:duration-tap data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95">
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
						{apps.length > 0 ? (
							<div className="flex flex-col gap-1.5">
								<p className="font-medium text-foreground text-xs">Your apps</p>
								{apps.map((app) => (
									<div
										className="flex items-center gap-2.5 rounded-lg border border-border bg-background px-3 py-2"
										key={app.holaAppId}
									>
										<div className="grid size-7 shrink-0 place-items-center rounded-md border border-border">
											{app.iconUrl ? (
												<HolaAppIcon
													iconUrl={app.iconUrl}
													sizeClass="size-4"
													title={app.title}
												/>
											) : (
												<Globe className="size-3.5 text-muted-foreground" />
											)}
										</div>
										<div className="min-w-0 flex-1">
											<p className="truncate font-medium text-foreground text-sm leading-tight">
												{app.title}
											</p>
											<p className="truncate text-muted-foreground text-xs">
												{app.url}
												{app.mcp ? " · MCP" : ""}
											</p>
										</div>
										{app.mcp && Object.keys(app.mcp.headerKeys).length === 0 ? (
											<CustomAppAuthorize
												serverId={app.mcp.id}
												workspaceId={workspaceId}
											/>
										) : null}
										<button
											aria-label={`Remove ${app.title}`}
											className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
											onClick={() => handleRemove(app.holaAppId)}
											type="button"
										>
											<X className="size-3.5" />
										</button>
									</div>
								))}
								<div className="my-1 h-px bg-border" />
							</div>
						) : null}

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
								MCP server config{" "}
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
								Paste an MCP config to give the agent this app's tools. Remote
								(URL) servers; add auth headers for a static token, or leave
								them out and Authorize (OAuth) after it's added. Kept on this
								device.
							</p>
						</div>

						{error ? <p className="text-destructive text-xs">{error}</p> : null}
					</div>

					<div className="flex items-center justify-end gap-2 border-border border-t px-4 py-3">
						<DialogPrimitive.Close
							render={
								<Button size="sm" type="button" variant="ghost">
									Done
								</Button>
							}
						/>
						<Button
							disabled={saving || !title.trim() || !url.trim()}
							onClick={handleCreate}
							size="sm"
							type="button"
						>
							{saving ? (
								<Loader2 className="size-3.5 animate-spin" />
							) : (
								<Plus className="size-3.5" />
							)}
							Add app
						</Button>
					</div>
				</DialogPrimitive.Popup>
			</DialogPrimitive.Portal>
		</DialogPrimitive.Root>
	);
}

type AuthorizeState =
	| "checking"
	| "hidden"
	| "authorized"
	| "needs"
	| "authorizing"
	| "error";

// Proactive OAuth authorization for a custom app's MCP server. Rendered only for an
// MCP with NO static auth header (a header-less server is the OAuth case — a static
// token is already usable, so it never shows this). Checks the server's token on
// mount; the button runs the runtime's system-browser OAuth flow (authorizeMcpServer)
// — the same path as the inline chat Authorize card (McpAuthorizeCard).
function CustomAppAuthorize({
	serverId,
	workspaceId,
}: {
	serverId: string;
	workspaceId: string | null;
}) {
	const [state, setState] = useState<AuthorizeState>("checking");
	const [detail, setDetail] = useState("");

	useEffect(() => {
		if (!workspaceId) {
			setState("hidden");
			return;
		}
		let cancelled = false;
		window.electronAPI.workspace
			.mcpServerAuthorized(workspaceId, serverId)
			.then((result) => {
				if (cancelled) {
					return;
				}
				if (result.authorized) {
					setState("authorized");
				} else if (result.registered === false) {
					// Not attached yet (its catalog sync is still in flight) — nothing to do.
					setState("hidden");
				} else {
					setState("needs");
				}
			})
			.catch(() => {
				if (!cancelled) {
					setState("hidden");
				}
			});
		return () => {
			cancelled = true;
		};
	}, [workspaceId, serverId]);

	const authorize = async () => {
		if (!workspaceId) {
			return;
		}
		setState("authorizing");
		setDetail("");
		try {
			const result = await window.electronAPI.workspace.authorizeMcpServer(
				workspaceId,
				serverId,
				false,
			);
			if (result.ok) {
				setState("authorized");
			} else {
				setState("error");
				setDetail(result.detail || "Authorization failed.");
			}
		} catch (err) {
			setState("error");
			setDetail(err instanceof Error ? err.message : "Request failed.");
		}
	};

	if (state === "checking" || state === "hidden") {
		return null;
	}
	if (state === "authorized") {
		return (
			<span className="shrink-0 text-emerald-600 text-xs">Authorized</span>
		);
	}
	return (
		<div className="flex shrink-0 flex-col items-end gap-1">
			<Button
				disabled={state === "authorizing"}
				onClick={() => void authorize()}
				size="sm"
				type="button"
				variant="outline"
			>
				{state === "authorizing" ? (
					<Loader2 className="size-3.5 animate-spin" />
				) : (
					<ShieldCheck className="size-3.5" />
				)}
				{state === "authorizing"
					? "Signing in…"
					: state === "error"
						? "Try again"
						: "Authorize"}
			</Button>
			{state === "error" && detail ? (
				<span
					className="max-w-[180px] truncate text-[11px] text-destructive"
					title={detail}
				>
					{detail}
				</span>
			) : null}
		</div>
	);
}
