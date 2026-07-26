import { useAtom, useSetAtom } from "jotai";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useState } from "react";
import { holabossLogoUrl } from "@/lib/assetPaths";
import { useDesktopAuthSession } from "@/lib/auth/authClient";
import { useWorkspaceSelection } from "@/lib/workspaceSelection";
import { HarnessOnboardingStage } from "./HarnessOnboardingStage";
import { IntegrationsOnboardingStage } from "./IntegrationsOnboardingStage";
import { onboardingDismissedAtom, onboardingStageAtom } from "./state";

const TOTAL_STAGES = 2;

/**
 * Top-level onboarding router. Owns which stage is visible (driven by
 * `onboardingStageAtom`) and the cross-stage transitions.
 *
 * In the single-workspace world the legacy "name your workspace" stage
 * is gone: the server lazily provisions one workspace on first sign-in
 * (see GET /api/v1/workspaces in the runtime), so by the time the user
 * sees onboarding a workspace already exists. HarnessOnboardingStage
 * reads that workspace id from `useWorkspaceSelection()` directly
 * instead of receiving it via a stage handoff.
 *
 * Each stage is dumb: it gets `onNext` / `onBack` / `onSkip` callbacks
 * and an index, and renders the shared `OnboardingStageLayout`. All the
 * "is the user done?" / "which stage shows next?" logic lives here.
 */
export function OnboardingFlow() {
	const [stage, setStage] = useAtom(onboardingStageAtom);
	const setDismissed = useSetAtom(onboardingDismissedAtom);
	const { selectedWorkspaceId } = useWorkspaceSelection();
	const auth = useDesktopAuthSession();
	const [signingOut, setSigningOut] = useState(false);

	const handleSignOut = useCallback(async () => {
		if (signingOut) return;
		setSigningOut(true);
		try {
			await auth.signOut();
		} finally {
			setSigningOut(false);
		}
	}, [auth, signingOut]);

	// Direction is +1 when advancing, -1 when going back. Used to flip the
	// slide axis on the AnimatePresence motion variants below so transitions
	// feel directional rather than always "from the right".
	const [direction, setDirection] = useState(1);

	const advance = useCallback(() => {
		setDirection(1);
		setStage((current) => Math.min(current + 1, TOTAL_STAGES - 1));
	}, [setStage]);

	const goBack = useCallback(() => {
		setDirection(-1);
		setStage((current) => Math.max(current - 1, 0));
	}, [setStage]);

	const dismiss = useCallback(() => {
		setDismissed(true);
		// Reset stage so a future re-trigger (e.g. clearing the dismissed
		// key in localStorage) starts from the beginning rather than
		// resuming mid-flow with stale state.
		setStage(0);
	}, [setDismissed, setStage]);

	const variants = {
		enter: (dir: number) => ({
			opacity: 0,
			x: dir * 24,
		}),
		center: { opacity: 1, x: 0 },
		exit: (dir: number) => ({
			opacity: 0,
			x: dir * -24,
		}),
	};

	return (
		<div className="relative flex min-h-screen w-screen flex-col bg-fg-2">
			{/* macOS draggable region — keeps the frameless window movable
			 * even when the cursor is over the brand header background. */}
			<div className="titlebar-drag-region pointer-events-none fixed top-0 right-0 left-0 z-10 h-[38px]" />

			{/* Brand header: holaboss logo + label on the left, sign-out on
			 * the right. Mirrors the existing OnboardingShell rhythm so this
			 * surface feels continuous with sign-in / first-workspace flows. */}
			<header className="window-drag relative z-20 flex shrink-0 items-center justify-between px-7 pt-[44px] pb-4 sm:px-9">
				<div className="flex min-w-0 items-center gap-2.5">
					<img
						alt=""
						aria-hidden
						className="size-7 shrink-0 object-contain"
						src={holabossLogoUrl}
					/>
					<span className="truncate text-base font-semibold tracking-tight text-foreground">
						holaOS
					</span>
				</div>
				<button
					className="window-no-drag rounded-md px-2 py-1 text-[12px] text-muted-foreground transition-colors hover:bg-fg-6 hover:text-foreground disabled:cursor-progress disabled:opacity-60"
					disabled={signingOut}
					onClick={() => void handleSignOut()}
					type="button"
				>
					{signingOut ? "Signing out…" : "Sign out"}
				</button>
			</header>

			{/* Centered stage canvas */}
			<main className="flex flex-1 items-center justify-center px-6 pb-8">
				<AnimatePresence custom={direction} initial={false} mode="wait">
					<motion.div
						animate="center"
						className="w-full"
						custom={direction}
						exit="exit"
						initial="enter"
						key={stage}
						transition={{
							duration: 0.32,
							ease: [0.22, 1, 0.36, 1],
						}}
						variants={variants}
					>
						{stage === 0 ? (
							<IntegrationsOnboardingStage
								onNext={() => advance()}
								onSkip={dismiss}
								stageIndex={1}
								totalStages={TOTAL_STAGES}
								workspaceHint={null}
							/>
						) : null}
						{stage === 1 ? (
							// Agents stage — needs a workspace id for harness detection +
							// connection tests. If provisioning failed and nothing is
							// selected, there's nothing to detect against, so just finish.
							selectedWorkspaceId ? (
								<HarnessOnboardingStage
									onBack={goBack}
									onFinish={dismiss}
									onSkip={dismiss}
									stageIndex={2}
									totalStages={TOTAL_STAGES}
									workspaceId={selectedWorkspaceId}
								/>
							) : (
								<DismissOnMount onMount={dismiss} />
							)
						) : null}
					</motion.div>
				</AnimatePresence>
			</main>
		</div>
	);
}

/**
 * Fires `onMount` exactly once on first render. Used as the degenerate-
 * case fallback for the agents stage when no workspace is selected (auto-
 * provisioning failed, so there's nothing to detect agents against);
 * dismissing puts the user in the regular AppShell, which surfaces its
 * own "Setting up your workspace…" placeholder.
 */
function DismissOnMount({ onMount }: { onMount: () => void }) {
	useEffect(() => {
		onMount();
	}, [onMount]);
	return null;
}
