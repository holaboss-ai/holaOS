import { useQuery } from "@tanstack/react-query";
import { useSetAtom } from "jotai";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check } from "@/components/ui/icons";
import { useDesktopAuthSession } from "@/lib/auth/authClient";
import { billingRpcFetch } from "@/lib/app-sdk-client";
import { projectViewAtom, workspaceOverlayAtom } from "./state/ui";

// The reward engine has no push channel — completion is observed when the shared
// ["rewards","listQuests"] cache refetches and a quest flips completed:false→true.
interface QuestLite {
  id: string;
  title: string;
  rewardCredits: number;
  completed: boolean;
}

interface ListQuestsLite {
  quests: QuestLite[];
  campaigns: QuestLite[];
}

interface CompletionToast {
  key: number;
  title: string;
  credits: number;
}

const DISMISS_MS = 5500;

// A single celebratory card. Owns its own auto-dismiss timer so each toast
// disappears on its own schedule regardless of what else is on screen.
function ToastCard({
  toast,
  onDismiss,
  onOpen,
}: {
  toast: CompletionToast;
  onDismiss: (key: number) => void;
  onOpen: () => void;
}) {
  useEffect(() => {
    const id = setTimeout(() => onDismiss(toast.key), DISMISS_MS);
    return () => clearTimeout(id);
  }, [toast.key, onDismiss]);

  return (
    <motion.button
      animate={{ opacity: 1, x: 0 }}
      className="pointer-events-auto flex w-full items-center gap-3 rounded-xl border border-border bg-popover p-3 text-left shadow-lg transition-colors hover:bg-accent"
      exit={{ opacity: 0, x: -12 }}
      initial={{ opacity: 0, x: -12 }}
      onClick={() => {
        onOpen();
        onDismiss(toast.key);
      }}
      transition={{ type: "spring", stiffness: 380, damping: 30 }}
      type="button"
    >
      <span className="grid size-9 shrink-0 place-items-center rounded-full bg-emerald-500/12 text-emerald-600 dark:text-emerald-400">
        <Check className="size-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-muted-foreground text-xs">
          Task complete
        </span>
        <span className="block truncate font-medium text-foreground text-sm">
          {toast.title}
        </span>
      </span>
      <span className="shrink-0 font-mono font-semibold text-primary text-sm tabular-nums">
        +{toast.credits.toLocaleString()}
      </span>
    </motion.button>
  );
}

export function RewardCompletionNotifier() {
  const session = useDesktopAuthSession();
  const enabled = Boolean(session.data?.user?.id?.trim());
  const setProjectView = useSetAtom(projectViewAtom);
  const setWorkspaceOverlay = useSetAtom(workspaceOverlayAtom);

  const { data } = useQuery({
    enabled,
    queryKey: ["rewards", "listQuests"],
    queryFn: () => billingRpcFetch<ListQuestsLite>("/rpc/rewards/listQuests"),
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });

  // null until the first payload establishes a baseline — so already-completed
  // tasks on launch never fire a toast, only genuine transitions after do.
  const seenCompleted = useRef<Set<string> | null>(null);
  const nextKey = useRef(0);
  const [toasts, setToasts] = useState<CompletionToast[]>([]);

  useEffect(() => {
    if (!data) {
      return;
    }
    const all = [...data.quests, ...data.campaigns];
    const completedNow = all.filter((quest) => quest.completed);
    if (seenCompleted.current === null) {
      seenCompleted.current = new Set(completedNow.map((quest) => quest.id));
      return;
    }
    const fresh = completedNow.filter(
      (quest) => !seenCompleted.current?.has(quest.id),
    );
    if (fresh.length === 0) {
      return;
    }
    for (const quest of fresh) {
      seenCompleted.current.add(quest.id);
    }
    setToasts((prev) => [
      ...prev,
      ...fresh.map((quest) => ({
        key: nextKey.current++,
        title: quest.title,
        credits: quest.rewardCredits,
      })),
    ]);
  }, [data]);

  const dismiss = (key: number) =>
    setToasts((prev) => prev.filter((toast) => toast.key !== key));

  const openRewards = () => {
    setProjectView(null);
    setWorkspaceOverlay("rewards");
  };

  if (toasts.length === 0) {
    return null;
  }

  // Bottom-LEFT on purpose: it sits over the sidebar column (pure HTML, next to
  // the Rewards footer), the one corner not covered by the center BrowserView
  // that hides anything drawn bottom/right (see the Toaster note in App.tsx).
  return createPortal(
    <div className="pointer-events-none fixed bottom-3 left-3 z-[999999990] flex w-72 flex-col-reverse gap-2">
      <AnimatePresence initial={false}>
        {toasts.map((toast) => (
          <ToastCard
            key={toast.key}
            onDismiss={dismiss}
            onOpen={openRewards}
            toast={toast}
          />
        ))}
      </AnimatePresence>
    </div>,
    document.body,
  );
}
