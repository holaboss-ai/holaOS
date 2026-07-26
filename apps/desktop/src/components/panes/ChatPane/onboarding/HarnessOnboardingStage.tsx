import { AnimatePresence, motion } from "motion/react";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import { HarnessAvatar } from "@/components/harness/HarnessAvatar";
import {
	CODE_PLAN_HINT,
	isBetaHarness,
	usesExternalCodePlan,
} from "@/components/harness/harnessMeta";
import {
	type HarnessReadinessRecord,
	useHarnessReadiness,
} from "@/components/harness/harnessReadiness";
import { useAvailableHarnesses } from "@/components/harness/useAvailableHarnesses";
import {
	AlertTriangle,
	ArrowRight,
	Check,
	Loader2,
	RotateCcw,
	SparklesFilled,
} from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import { OnboardingStageLayout } from "./OnboardingStageLayout";

// The runtime marks its always-on built-in brain (Hola / pi) with this
// detection sentinel — it has no binary to find on PATH.
const BUILT_IN_DETECTION = "in-process";

/** Alphabetical, so each section reads stably across re-detects. */
function byName(
	a: HarnessAvailabilityEntryPayload,
	b: HarnessAvailabilityEntryPayload,
): number {
	return a.display_name.localeCompare(b.display_name);
}

// The lifecycle an agent moves through. The three top-level buckets — built-in,
// detected (installed here), not-installed (supported elsewhere) — are the
// distinction users kept conflating, so they get their own list sections; the
// verify/verified/needs_setup states only apply within "detected".
type AgentStatus =
	| "built_in"
	| "not_installed"
	| "verify"
	| "verifying"
	| "verified"
	| "needs_setup";

function resolveStatus(
	entry: HarnessAvailabilityEntryPayload,
	readiness: HarnessReadinessRecord | null,
	testing: boolean,
): AgentStatus {
	if (entry.detection === BUILT_IN_DETECTION) return "built_in";
	if (!entry.available) return "not_installed";
	if (testing) return "verifying";
	if (readiness?.status === "ready") return "verified";
	if (readiness?.status === "needs_setup") return "needs_setup";
	return "verify";
}

interface HarnessOnboardingStageProps {
	stageIndex: number;
	totalStages: number;
	onBack: () => void;
	onSkip: () => void;
	/** Fires when the user clicks Finish — flips the dismissed atom. */
	onFinish: () => void;
	/** Required for the harness detection + connection-test IPC. */
	workspaceId: string;
}

/**
 * Stage 3: optional "bring your own agent". Splits the catalogue into three
 * clearly-labelled buckets so the states don't blur together:
 *   • Built-in — Hola, always ready
 *   • On this Mac — installed CLIs; each needs a live **Verify** to confirm it
 *     actually launches + authenticates (green = verified, not merely detected)
 *   • Not installed — agents we support that aren't on this machine yet
 * Optional throughout: Hola is built in, so Finish is always enabled.
 */
export function HarnessOnboardingStage({
	stageIndex,
	totalStages,
	onBack,
	onSkip,
	onFinish,
	workspaceId,
}: HarnessOnboardingStageProps) {
	const { harnesses, isLoading, error, refresh } =
		useAvailableHarnesses(workspaceId);
	const readiness = useHarnessReadiness();
	const getReadiness = readiness.get;

	const { builtIn, detected, notInstalled } = useMemo(() => {
		const b: HarnessAvailabilityEntryPayload[] = [];
		const d: HarnessAvailabilityEntryPayload[] = [];
		const n: HarnessAvailabilityEntryPayload[] = [];
		for (const entry of harnesses) {
			if (entry.detection === BUILT_IN_DETECTION) b.push(entry);
			else if (entry.available) d.push(entry);
			else n.push(entry);
		}
		d.sort(byName);
		n.sort(byName);
		return { builtIn: b, detected: d, notInstalled: n };
	}, [harnesses]);

	// "Verified" = usable with confidence: the built-in Hola, plus any detected
	// agent a connection test has confirmed.
	const verifiedCount = useMemo(
		() =>
			builtIn.length +
			detected.filter((entry) => getReadiness(entry.id)?.status === "ready")
				.length,
		[builtIn.length, detected, getReadiness],
	);

	const testConnection = useCallback(
		(harnessId: string) =>
			window.electronAPI.workspace.testHarnessConnection(
				workspaceId,
				harnessId,
			),
		[workspaceId],
	);

	const renderCard = (entry: HarnessAvailabilityEntryPayload) => (
		<AgentCard
			entry={entry}
			key={entry.id}
			onReDetect={() => void refresh()}
			onTest={() => testConnection(entry.id)}
			reDetecting={isLoading}
		/>
	);

	return (
		<OnboardingStageLayout
			left={
				<>
					<div className="space-y-2.5">
						<h2 className="font-serif text-[26px] leading-[1.15] tracking-tight text-foreground">
							Bring your own agent
						</h2>
						<p className="max-w-[440px] text-[13.5px] text-muted-foreground leading-[1.55]">
							Hola is built in and always ready. The agent CLIs on this Mac just
							need a quick <span className="text-foreground/80">Verify</span>.
							Anything not installed can be added later.
						</p>
					</div>

					{error ? (
						<div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-[12px] text-destructive">
							<AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
							<span className="wrap-break-word">{error}</span>
						</div>
					) : isLoading && harnesses.length === 0 ? (
						<div className="flex items-center gap-2 px-1 py-6 text-[12.5px] text-muted-foreground">
							<Loader2 className="size-3.5 animate-spin" />
							Detecting agents…
						</div>
					) : (
						// Sectioned + scrollable so the layout height stays fixed.
						<div className="-mr-2 flex max-h-[366px] flex-col gap-4 overflow-y-auto pr-2">
							{builtIn.length > 0 ? (
								<Section title="Built-in">{builtIn.map(renderCard)}</Section>
							) : null}
							{detected.length > 0 ? (
								<Section
									title={`On this Mac · ${detected.length}`}
									hint="Verify to start using"
								>
									{detected.map(renderCard)}
								</Section>
							) : null}
							{notInstalled.length > 0 ? (
								<Section
									title={`Not installed · ${notInstalled.length}`}
									hint="Supported — install, then re-check"
								>
									{notInstalled.map(renderCard)}
								</Section>
							) : null}
						</div>
					)}

					<button
						className="inline-flex w-fit items-center gap-1.5 rounded-md px-1.5 py-1 text-[11.5px] text-muted-foreground transition-colors hover:text-foreground disabled:cursor-progress disabled:opacity-60"
						disabled={isLoading}
						onClick={() => void refresh()}
						type="button"
					>
						{isLoading ? (
							<Loader2 className="size-3 animate-spin" />
						) : (
							<RotateCcw className="size-3" />
						)}
						Re-detect after installing
					</button>
				</>
			}
			onBack={onBack}
			onPrimaryAction={onFinish}
			onSkip={onSkip}
			// Optional — Hola is always available, so never block finishing.
			primaryActionDisabled={false}
			primaryActionLabel="Finish"
			right={<AgentsLegend verifiedCount={verifiedCount} />}
			skipLabel="Skip"
			stageIndex={stageIndex}
			totalStages={totalStages}
		/>
	);
}

function Section({
	title,
	hint,
	children,
}: {
	title: string;
	hint?: string;
	children: ReactNode;
}) {
	return (
		<div className="flex flex-col gap-1.5">
			<div className="flex items-baseline gap-2 px-0.5">
				<span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
					{title}
				</span>
				{hint ? (
					<span className="text-[10.5px] text-muted-foreground/45">{hint}</span>
				) : null}
			</div>
			{children}
		</div>
	);
}

// ──────────────────────────────────────────────────────────────────────
// Agent card — left-side row. Its section provides the top-level bucket; the
// right-hand chip carries the within-bucket state and (for detected agents)
// doubles as the Verify call to action.

function AgentCard({
	entry,
	onTest,
	onReDetect,
	reDetecting,
}: {
	entry: HarnessAvailabilityEntryPayload;
	onTest: () => Promise<HarnessConnectionTestResultPayload>;
	onReDetect: () => void;
	reDetecting: boolean;
}) {
	const models = entry.supported_models ?? [];
	const [testing, setTesting] = useState(false);
	const readiness = useHarnessReadiness();
	const record = readiness.get(entry.id);
	const status = resolveStatus(entry, record, testing);

	// Only installed, non-built-in agents can be verified. Once verified, the
	// row is done — clicking should NOT re-run the test (verify / needs-setup
	// rows stay clickable so the user can run or retry).
	const testable = entry.available && entry.detection !== BUILT_IN_DETECTION;
	// not_installed rows are actionable too — the app can't install these CLIs
	// for you, but clicking re-detects so a just-installed one flips to ready.
	const interactive =
		(testable && status !== "verified") || status === "not_installed";

	const run = useCallback(async () => {
		if (!interactive || testing) return;
		setTesting(true);
		try {
			const result = await onTest();
			readiness.record(
				entry.id,
				result.ok ? "ready" : "needs_setup",
				result.detail ?? "",
			);
		} catch (error) {
			readiness.record(
				entry.id,
				"needs_setup",
				error instanceof Error ? error.message : "Connection test failed.",
			);
		} finally {
			setTesting(false);
		}
	}, [entry.id, onTest, readiness, interactive, testing]);

	const modelsLabel =
		models.length > 0
			? `${models.length} ${models.length === 1 ? "model" : "models"}`
			: null;

	const subtitle = ((): string => {
		switch (status) {
			case "built_in":
				return "Always ready — no setup needed";
			case "not_installed":
				return entry.detection;
			case "verifying":
				return "Checking the connection…";
			case "verified":
				return modelsLabel
					? `Verified · ${modelsLabel} · ready to use`
					: "Verified · ready to use";
			case "needs_setup":
				return record?.detail || "Couldn't verify — check its login and retry";
			default:
				return modelsLabel
					? `${modelsLabel} · not verified yet`
					: "Installed · not verified yet";
		}
	})();

	return (
		<motion.button
			aria-label={
				status === "verify"
					? `Verify ${entry.display_name}`
					: status === "needs_setup"
						? `Retry verifying ${entry.display_name}`
						: status === "verified"
							? `${entry.display_name} — verified`
							: status === "built_in"
								? `${entry.display_name} — built in`
								: `Re-check ${entry.display_name}`
			}
			className={cn(
				"group/agent-card relative flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors",
				interactive
					? "border-border bg-background hover:border-foreground/15 hover:bg-fg-2"
					: status === "verified"
						? "cursor-default border-border bg-background"
						: "cursor-default border-border/40 bg-muted/40",
				(testing || reDetecting) && "cursor-progress opacity-90",
			)}
			disabled={!interactive || testing || reDetecting}
			onClick={() => {
				if (status === "not_installed") {
					onReDetect();
					return;
				}
				void run();
			}}
			title={record?.detail || undefined}
			transition={{ type: "spring", stiffness: 420, damping: 28, mass: 0.5 }}
			type="button"
			whileHover={
				interactive && !testing && !reDetecting ? { y: -1 } : undefined
			}
			whileTap={
				interactive && !testing && !reDetecting ? { scale: 0.985 } : undefined
			}
		>
			<HarnessAvatar
				className={cn(status === "not_installed" && "opacity-60")}
				harnessId={entry.id}
				size="lg"
			/>
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-1.5">
					<span
						className={cn(
							"truncate text-[13px] font-medium",
							status === "not_installed"
								? "text-muted-foreground"
								: "text-foreground",
						)}
					>
						{entry.display_name}
					</span>
					{isBetaHarness(entry.id) ? (
						<span className="rounded border border-amber-500/30 bg-amber-500/10 px-1 py-px text-[9.5px] font-medium text-amber-700 dark:text-amber-400">
							Beta
						</span>
					) : null}
					{usesExternalCodePlan(entry.id) ? (
						<span className="shrink-0 whitespace-nowrap text-[11px] text-muted-foreground">
							{CODE_PLAN_HINT}
						</span>
					) : null}
				</div>
				<div
					className={cn(
						"truncate text-[11.5px]",
						status === "needs_setup"
							? "text-destructive/80"
							: "text-muted-foreground",
					)}
				>
					{subtitle}
				</div>
			</div>
			<div className="shrink-0">
				<AnimatePresence initial={false} mode="wait">
					<motion.span
						animate={{ opacity: 1 }}
						exit={{ opacity: 0 }}
						initial={{ opacity: 0 }}
						key={status}
						transition={{ duration: 0.18 }}
					>
						<StatusChip status={status} />
					</motion.span>
				</AnimatePresence>
			</div>
		</motion.button>
	);
}

/** The right-side chip — carries the within-bucket state and, for `verify` /
 *  `needs_setup`, doubles as the call to action (the whole row is the button). */
function StatusChip({ status }: { status: AgentStatus }) {
	switch (status) {
		case "built_in":
			return (
				<span className="rounded-md border border-border bg-fg-2 px-2 py-0.5 text-[10.5px] font-medium text-muted-foreground">
					Built-in
				</span>
			);
		case "not_installed":
			return (
				<span className="inline-flex items-center gap-1 text-[10.5px] text-muted-foreground/70 transition-colors group-hover/agent-card:text-foreground">
					<RotateCcw className="size-3" />
					Re-check
				</span>
			);
		case "verifying":
			return (
				<span className="inline-flex items-center gap-1 rounded-md bg-fg-2 px-2 py-0.5 text-[10.5px] font-medium text-muted-foreground">
					<Loader2 className="size-3 animate-spin" />
					Verifying…
				</span>
			);
		case "verified":
			return (
				<span className="inline-flex items-center gap-1 rounded-md bg-success/15 px-2 py-0.5 text-[10.5px] font-medium text-success">
					<Check className="size-3" />
					Verified
				</span>
			);
		case "needs_setup":
			return (
				<span className="inline-flex items-center gap-1 rounded-md border border-destructive/30 bg-destructive/5 px-2 py-0.5 text-[10.5px] font-medium text-destructive">
					<AlertTriangle className="size-3" />
					Needs setup
				</span>
			);
		default:
			// Call to action — amber so it reads as "do this", with an arrow to
			// signal the (whole-row) click.
			return (
				<span className="inline-flex items-center gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10.5px] font-semibold text-amber-700 transition-colors group-hover/agent-card:bg-amber-500/20 dark:text-amber-400">
					Verify
					<ArrowRight className="size-3" />
				</span>
			);
	}
}

// ──────────────────────────────────────────────────────────────────────
// Right panel: a legend that defines each state (the whole point of this
// step is teaching that vocabulary) plus the running verified count. Replaces
// the earlier roster, which duplicated the left list and blurred the states.

function AgentsLegend({ verifiedCount }: { verifiedCount: number }) {
	return (
		<div
			aria-hidden
			className="w-full max-w-[320px] overflow-hidden rounded-[14px] border border-border/60 bg-background shadow-[0_1px_2px_rgba(0,0,0,0.04),0_12px_28px_-12px_rgba(0,0,0,0.10)]"
		>
			<div className="flex items-baseline justify-between border-b border-border/40 px-4 py-3">
				<span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/60">
					Agents
				</span>
				<span className="text-[11px] tabular-nums text-muted-foreground">
					<span className="font-semibold text-success">{verifiedCount}</span>{" "}
					verified
				</span>
			</div>

			<div className="flex flex-col gap-3 px-4 py-4">
				<LegendRow
					swatch={
						<LegendSwatch className="bg-primary/12 text-primary">
							<SparklesFilled className="size-2.5" />
						</LegendSwatch>
					}
					label="Built-in"
					desc="Hola — always ready, no setup"
				/>
				<LegendRow
					swatch={
						<LegendSwatch className="bg-success/15 text-success">
							<Check className="size-2.5" />
						</LegendSwatch>
					}
					label="Verified"
					desc="Tested — ready to use"
				/>
				<LegendRow
					swatch={
						<LegendSwatch className="bg-amber-500/15">
							<span className="size-1.5 rounded-full bg-amber-500" />
						</LegendSwatch>
					}
					label="On this Mac"
					desc="Installed — Verify to start using"
				/>
				<LegendRow
					swatch={
						<LegendSwatch className="border border-dashed border-muted-foreground/40" />
					}
					label="Not installed"
					desc="Supported — install it, then re-check"
				/>
			</div>
		</div>
	);
}

// Uniform circular status chip so every state reads from the same geometry —
// only the fill/color changes. Filled = present state, hollow ring = absent.
function LegendSwatch({
	className,
	children,
}: {
	className?: string;
	children?: ReactNode;
}) {
	return (
		<span
			className={cn(
				"inline-flex size-4 items-center justify-center rounded-full",
				className,
			)}
		>
			{children}
		</span>
	);
}

function LegendRow({
	swatch,
	label,
	desc,
}: {
	swatch: ReactNode;
	label: string;
	desc: string;
}) {
	return (
		<div className="flex items-center gap-2.5">
			<span className="grid w-4 shrink-0 place-items-center">{swatch}</span>
			<span className="w-[92px] shrink-0 text-[12px] font-medium text-foreground">
				{label}
			</span>
			<span className="min-w-0 flex-1 truncate text-[11.5px] text-muted-foreground">
				{desc}
			</span>
		</div>
	);
}
