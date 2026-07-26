import { useQuery } from "@tanstack/react-query";
import { useAtom } from "jotai";
import { useEffect, useMemo, useState } from "react";
import { CustomHolaAppCreateDialog } from "@/components/layout/shell/CustomHolaAppCreateDialog";
import { HolaAppMarketplacePane } from "@/components/layout/shell/HolaAppMarketplacePane";
import {
	type CustomizeTab,
	customizeTabAtom,
	pendingHubInstallAtom,
} from "@/components/layout/shell/state/ui";
import { useHolaAppCatalog } from "@/components/layout/shell/useHolaAppCatalog";
import { useOpenDiscover } from "@/components/layout/shell/useOpenDiscover";
import { useStartCapabilityCreation } from "@/components/layout/shell/useStartCapabilityCreation";
import { useStartChatDraft } from "@/components/layout/shell/useStartChatDraft";
import { useStartSkillCreation } from "@/components/layout/shell/useStartSkillCreation";
import { CapabilityGlyph } from "@/components/marketplace/CapabilityGlyph";
import { CapabilitiesMarketPane } from "@/components/panes/CapabilitiesMarketPane";
import { CapabilityCreatePane } from "@/components/panes/CapabilityCreatePane";
import { CapabilityDetailView } from "@/components/panes/CapabilityDetailView";
import { CapabilityImportPane } from "@/components/panes/CapabilityImportPane";
import { McpsPane } from "@/components/panes/McpsPane";
import { SkillsStorePane } from "@/components/panes/SkillsStorePane";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import {
	ArrowUpRight,
	Boxes,
	ChevronLeft,
	ChevronRight,
	Plus,
	Search,
	Sparkles,
	Wrench,
} from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-shell";
import { remoteApiQuery } from "@/lib/remoteApiQuery";
import { cn } from "@/lib/utils";

const SEGMENTS: { id: CustomizeTab; label: string }[] = [
	{ id: "apps", label: "Apps" },
	{ id: "capabilities", label: "Combos" },
	{ id: "skills", label: "Skills" },
	{ id: "mcps", label: "MCPs" },
];

// Full browsing lives in the HolaHub Marketplace; each tab links out to its
// matching marketplace type. (Customize itself is for managing what's installed.)
const MARKETPLACE_TYPE_BY_TAB: Record<CustomizeTab, string> = {
	apps: "holaapp",
	capabilities: "capability",
	skills: "skill",
	mcps: "mcp",
};

export function CustomizePane({ workspaceId }: { workspaceId: string | null }) {
	const openDiscover = useOpenDiscover();
	const [tab, setTab] = useAtom(customizeTabAtom);
	const browseMarketplace = () =>
		openDiscover(`/marketplace?type=${MARKETPLACE_TYPE_BY_TAB[tab]}`);
	const { refresh: refreshHolaApps } = useHolaAppCatalog();
	const [customAppsOpen, setCustomAppsOpen] = useState(false);
	const [selectedCapabilityId, setSelectedCapabilityId] = useState<
		string | null
	>(null);
	const [capabilityView, setCapabilityView] = useState<"market" | "installed">(
		"market",
	);
	const [creating, setCreating] = useState(false);
	const [importing, setImporting] = useState(false);
	const [mcpsView, setMcpsView] = useState<"store" | "connected">("connected");
	const [mcpsQuery, setMcpsQuery] = useState("");
	// A catalog id to auto-open/install when HolaHub's "Install" op routes a
	// KEYED/gated item here (HeadlessInstaller → pendingHubInstallAtom) so the user
	// can complete its connect step — one per tab's native surface.
	const [openCapabilityRef, setOpenCapabilityRef] = useState<string | null>(
		null,
	);
	const [openMcpRef, setOpenMcpRef] = useState<string | null>(null);
	const [openSkillRef, setOpenSkillRef] = useState<string | null>(null);
	const [pendingInstall, setPendingInstall] = useAtom(pendingHubInstallAtom);
	const startSkillCreation = useStartSkillCreation();
	const startCapabilityCreation = useStartCapabilityCreation();
	const startChatDraft = useStartChatDraft();

	const installedQuery = useQuery(
		remoteApiQuery.capabilities.listInstalled.queryOptions({
			input: {},
			enabled: Boolean(workspaceId),
		}),
	);
	const installed = installedQuery.data?.capabilities ?? [];
	const installedIds = useMemo(
		() => new Set(installed.map((c) => c.capabilityId)),
		[installed],
	);
	const selectedCapability =
		installed.find((c) => c.capabilityId === selectedCapabilityId) ?? null;

	// Consume a HolaHub "install" intent (routed here by HeadlessInstaller for
	// keyed/gated items): open the item's tab and focus it in its native install
	// surface so the user can connect, then clear the intent.
	useEffect(() => {
		if (!pendingInstall) {
			return;
		}
		if (pendingInstall.type === "capability") {
			setTab("capabilities");
			setCapabilityView("market");
			setOpenCapabilityRef(pendingInstall.ref);
		} else if (pendingInstall.type === "mcp") {
			setTab("mcps");
			setMcpsView("store");
			setOpenMcpRef(pendingInstall.ref);
		} else if (pendingInstall.type === "skill") {
			setTab("skills");
			setOpenSkillRef(pendingInstall.ref);
		}
		setPendingInstall(null);
	}, [pendingInstall, setPendingInstall]);

	return (
		<div className="flex h-full min-h-0 flex-col">
			<PageHeader
				maxWidth="5xl"
				title="Customize"
				toolbar={
					<div className="flex items-center justify-between gap-3">
						<div className="inline-flex items-center gap-0.5 rounded-lg bg-fg-4 p-0.5">
							{SEGMENTS.map(({ id, label }) => (
								<button
									className={cn(
										"rounded-md px-3 py-1 font-medium text-sm transition-colors",
										tab === id
											? "bg-background text-foreground shadow-sm"
											: "text-muted-foreground hover:text-foreground",
									)}
									key={id}
									onClick={() => {
										setTab(id);
										setSelectedCapabilityId(null);
										setCreating(false);
										setImporting(false);
									}}
									type="button"
								>
									{label}
								</button>
							))}
						</div>
						<div className="flex shrink-0 items-center gap-3">
							{tab === "apps" ? (
								<button
									className="inline-flex items-center gap-1 font-medium text-foreground text-sm transition-colors hover:text-foreground/70"
									onClick={() => setCustomAppsOpen(true)}
									type="button"
								>
									<Plus className="size-4" />
									Create your own app
								</button>
							) : null}
							<button
								className="inline-flex items-center gap-1 font-medium text-primary text-sm transition-colors hover:text-primary/80"
								onClick={browseMarketplace}
								type="button"
							>
								Browse in Marketplace
								<ArrowUpRight className="size-4" />
							</button>
						</div>
					</div>
				}
			/>

			<div className="min-h-0 flex-1 overflow-hidden">
				{tab === "apps" ? (
					<HolaAppMarketplacePane
						embedded
						onBrowseMarketplace={browseMarketplace}
					/>
				) : tab === "skills" ? (
					<SkillsStorePane
						installRef={openSkillRef}
						manageOnly
						onBrowseMarketplace={browseMarketplace}
						onCreateSkill={startSkillCreation}
						onInstallHandled={() => setOpenSkillRef(null)}
						onTryWithAgent={(skillId) =>
							startChatDraft(`/${skillId}\n`, { returnTo: "customize" })
						}
						workspaceId={workspaceId}
					/>
				) : tab === "mcps" ? (
					mcpsView === "store" ? (
						<div className="flex h-full min-h-0 flex-col">
							<div className="mx-auto flex w-full max-w-5xl shrink-0 items-center gap-3 px-6 py-2.5">
								<div className="relative w-full max-w-xs">
									<Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
									<Input
										aria-label="Search MCP servers"
										className="h-8 w-full rounded-md pl-8 text-sm"
										onChange={(event) => setMcpsQuery(event.target.value)}
										placeholder="Search MCP servers"
										value={mcpsQuery}
									/>
								</div>
							</div>
							<div className="min-h-0 flex-1 overflow-hidden">
								<McpsPane
									browseQuery={mcpsQuery}
									installRef={openMcpRef}
									mode="browse"
									onInstallHandled={() => {
										setOpenMcpRef(null);
										setMcpsView("connected");
									}}
									onSeeInstalled={() => setMcpsView("connected")}
									workspaceId={workspaceId}
								/>
							</div>
						</div>
					) : (
						<div className="flex h-full min-h-0 flex-col">
							<div className="min-h-0 flex-1 overflow-hidden">
								<McpsPane
									onAddMcpServer={() =>
										startChatDraft("Add an MCP server: ", {
											returnTo: "customize",
										})
									}
									onBrowseMarketplace={browseMarketplace}
									workspaceId={workspaceId}
								/>
							</div>
						</div>
					)
				) : (
					<div className="flex h-full min-h-0 flex-col">
						{capabilityView === "market" ? (
							<div className="min-h-0 flex-1">
								<CapabilitiesMarketPane
									installedCount={installed.length}
									installedIds={installedIds}
									manageOnly
									onBrowseMarketplace={browseMarketplace}
									onChanged={() => void installedQuery.refetch()}
									onDetailOpened={() => setOpenCapabilityRef(null)}
									onManage={() => setCapabilityView("installed")}
									onNew={startCapabilityCreation}
									openDetailRef={openCapabilityRef}
									workspaceId={workspaceId}
								/>
							</div>
						) : (
							<div className="flex min-h-0 flex-1 flex-col">
								<div className="mx-auto flex w-full max-w-5xl shrink-0 items-center gap-2 px-6 py-2">
									<button
										className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-muted-foreground text-sm transition-colors hover:bg-accent hover:text-foreground"
										onClick={() => {
											setSelectedCapabilityId(null);
											setCreating(false);
											setImporting(false);
											setCapabilityView("market");
										}}
										type="button"
									>
										<ChevronLeft className="size-3.5" />
										Marketplace
									</button>
									<span className="text-muted-foreground text-sm">·</span>
									<span className="font-medium text-foreground text-sm">
										Installed
									</span>
									<DropdownMenu>
										<DropdownMenuTrigger
											render={
												<Button
													className="ml-auto h-7 gap-1.5"
													size="sm"
													type="button"
													variant="outline"
												/>
											}
										>
											<Plus className="size-3.5" />
											New
										</DropdownMenuTrigger>
										<DropdownMenuContent align="end">
											<DropdownMenuItem onClick={startCapabilityCreation}>
												<Sparkles className="text-muted-foreground" />
												Create with agent
											</DropdownMenuItem>
											<DropdownMenuItem
												onClick={() => {
													setSelectedCapabilityId(null);
													setCreating(true);
												}}
											>
												<Wrench className="text-muted-foreground" />
												Build manually
											</DropdownMenuItem>
										</DropdownMenuContent>
									</DropdownMenu>
								</div>

								<div className="min-h-0 flex-1 overflow-hidden">
									{importing ? (
										<CapabilityImportPane
											onClose={() => setImporting(false)}
											onImported={(capabilityId) => {
												setImporting(false);
												setSelectedCapabilityId(capabilityId);
											}}
										/>
									) : creating ? (
										<CapabilityCreatePane
											onClose={() => setCreating(false)}
											onCreated={(capabilityId) => {
												setCreating(false);
												setSelectedCapabilityId(capabilityId);
											}}
											workspaceId={workspaceId ?? ""}
										/>
									) : selectedCapability ? (
										<CapabilityDetailView
											backLabel="All installed"
											capabilityId={selectedCapability.capabilityId}
											connectorProviders={Object.keys(
												selectedCapability.integrationStatus ?? {},
											)}
											description={selectedCapability.description}
											icon={selectedCapability.icon}
											installed
											name={selectedCapability.name}
											onBack={() => setSelectedCapabilityId(null)}
											onUninstalled={() => setSelectedCapabilityId(null)}
											skillIds={selectedCapability.installedSkillIds}
											status={selectedCapability.status}
											workspaceId={workspaceId ?? ""}
										/>
									) : installed.length === 0 ? (
										<div className="flex h-full items-center justify-center p-6">
											<EmptyState
												action={
													<Button
														onClick={() => setCapabilityView("market")}
														size="sm"
														variant="outline"
													>
														Browse marketplace
													</Button>
												}
												description="Combos bundle related skills and integrations. Add some from the marketplace."
												icon={Boxes}
												size="md"
												title="No combos installed"
											/>
										</div>
									) : (
										<div className="h-full overflow-y-auto py-5">
											<div className="mx-auto grid w-full max-w-5xl grid-cols-1 gap-x-8 gap-y-1 px-6 sm:grid-cols-2">
												{installed.map((capability) => (
													<button
														className="flex items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors hover:bg-fg-2"
														key={capability.capabilityId}
														onClick={() =>
															setSelectedCapabilityId(capability.capabilityId)
														}
														type="button"
													>
														<CapabilityGlyph
															className="size-12"
															icon={capability.icon ?? undefined}
															id={capability.capabilityId}
														/>
														<div className="min-w-0 flex-1">
															<p className="truncate font-semibold text-[15px] text-foreground leading-tight">
																{capability.name}
															</p>
															{capability.description ? (
																<p className="mt-0.5 truncate text-[13px] text-muted-foreground leading-5">
																	{capability.description}
																</p>
															) : null}
														</div>
														<ChevronRight className="size-4 shrink-0 text-muted-foreground" />
													</button>
												))}
											</div>
										</div>
									)}
								</div>
							</div>
						)}
					</div>
				)}
			</div>

			<CustomHolaAppCreateDialog
				onChanged={() => void refreshHolaApps()}
				onOpenChange={setCustomAppsOpen}
				open={customAppsOpen}
				workspaceId={workspaceId}
			/>
		</div>
	);
}
