import { useQuery } from "@tanstack/react-query";
import { AppIcon } from "@/components/marketplace/AppIcon";
import { ArrowRight, Sparkles } from "@/components/ui/icons";
import { listAllIntegrationConnections } from "@/lib/listAllIntegrationConnections";
import { remoteApiQuery } from "@/lib/remoteApiQuery";
import { cn } from "@/lib/utils";
import { useWorkspaceSelection } from "@/lib/workspaceSelection";
import {
  composioToolkitSlugForProvider,
  useWorkspaceDesktop,
} from "@/lib/workspaceDesktop";
import { motion } from "motion/react";
import { useEffect, useMemo, useState } from "react";

interface PersonalizedSuggestionsProps {
  /** Fires when the user picks a suggestion. The parent decides whether to
   *  send immediately or drop the prompt into a composer for editing. */
  onSelect: (prompt: string) => void;
  /** Overrides the outer wrapper classes so callers can match their own
   *  container width and rhythm. */
  className?: string;
}

// Per-integration starter prompts. Kept to ONE prompt per slug so the row
// list stays scannable; if we ever want more, the principle is "every
// prompt must produce a tangible artifact the user can show someone."
const SUGGESTION_TEMPLATES: Record<string, string> = {
  gmail: "Summarize the last 24 hours of my inbox into a 1-page brief.",
  github:
    "Triage today's PR activity across my repos and draft a status note.",
  notion:
    "Pull the pages I edited this week into a single Markdown status update.",
  slack: "Catch me up on the most active channels from the last day.",
  linear:
    "Show me my open issues, sorted by urgency, with a suggested next action each.",
  googledrive:
    "Find documents I edited this week and summarize what changed in each.",
  googlecalendar:
    "Summarize my schedule for the rest of the day and surface anything I should prep for.",
  googlesheets:
    "Open my most recently edited spreadsheet and explain what's in it.",
  jira: "Show me my open issues and what's overdue.",
  zoom: "Summarize today's meetings if transcripts are available.",
};

// Capability examples — one per headline thing the agent can MAKE
// (Docs / Excel / PPT / Vibecoding). Each produces a real artifact, never
// a chat reply, so the empty state teaches "the product makes things"
// rather than just listing what's connected.
const CAPABILITY_SUGGESTIONS: ReadonlyArray<string> = [
  "Write me a 1-page brief on a topic I'll give you next.",
  "Build a comparison spreadsheet of three options I'll list.",
  "Draft a slide outline for a 5-minute internal update.",
  "Vibe-code a simple landing page from a one-line description.",
];

const MAX_ROWS = 4;
// Installed capabilities lead (the things the user just set up in onboarding),
// then connected integrations, then generic examples backfill the rest.
const MAX_CAPABILITY_ROWS = 2;

// Client-side heuristic starter for an installed capability, derived from the
// skills it bundles. This is the fallback: once capabilities ship authored
// `examplePrompts`, prefer those and let this cover the ones that haven't.
function capabilityStarterPrompt(cap: {
  name: string;
  installedSkillIds: string[];
}): string {
  const skills = cap.installedSkillIds.map((s) => s.toLowerCase());
  const has = (kw: string) => skills.some((s) => s.includes(kw));
  if (has("keyword")) {
    return "Research the top keywords for my topic.";
  }
  if (has("brief")) {
    return "Draft a content brief for a topic I'll give you.";
  }
  if (has("cluster")) {
    return "Plan a topic cluster around my niche.";
  }
  if (has("triage")) {
    return "Triage my inbox and draft the replies.";
  }
  if (has("competitor") || has("analysis")) {
    return "Analyze my top competitors and summarize the takeaways.";
  }
  if (has("repurpose")) {
    return "Repurpose one post into a version for each platform.";
  }
  if (has("write") || has("writer") || has("content") || has("post")) {
    return `Write a ${cap.name} post — I'll give you the topic.`;
  }
  return `Put ${cap.name} to work on a task I'll describe next.`;
}

export function PersonalizedSuggestions({
  onSelect,
  className = "mx-auto w-full max-w-3xl px-1 pt-3",
}: PersonalizedSuggestionsProps) {
  const { composioToolkitsByProvider } = useWorkspaceDesktop();
  const { selectedWorkspaceId } = useWorkspaceSelection();
  const installedQuery = useQuery(
    remoteApiQuery.capabilities.listInstalled.queryOptions({
      input: {},
      enabled: Boolean(selectedWorkspaceId),
    }),
  );
  const [connections, setConnections] = useState<
    IntegrationConnectionPayload[]
  >([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result =
          await listAllIntegrationConnections();
        if (!cancelled) {
          setConnections(result.connections);
        }
      } finally {
        if (!cancelled) {
          setLoaded(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const rows = useMemo(() => {
    const result: Array<{
      key: string;
      slug: string | null;
      name: string | null;
      logo: string | null;
      emoji: string | null;
      prompt: string;
    }> = [];
    const usedPrompts = new Set<string>();
    const push = (row: (typeof result)[number]) => {
      if (usedPrompts.has(row.prompt)) return;
      usedPrompts.add(row.prompt);
      result.push(row);
    };

    // 1. Installed capabilities first — surface what the user just set up.
    for (const cap of installedQuery.data?.capabilities ?? []) {
      if (result.length >= MAX_CAPABILITY_ROWS) break;
      push({
        key: `cap-${cap.capabilityId}`,
        slug: null,
        name: null,
        logo: null,
        emoji: cap.icon ?? null,
        prompt: capabilityStarterPrompt(cap),
      });
    }

    // 2. One row per connected integration that has a template.
    const seenSlugs = new Set<string>();
    for (const c of connections) {
      if (result.length >= MAX_ROWS) break;
      if (c.status !== "active") continue;
      const slug = composioToolkitSlugForProvider(c.provider_id);
      if (seenSlugs.has(slug)) continue;
      seenSlugs.add(slug);
      const prompt = SUGGESTION_TEMPLATES[slug];
      if (!prompt) continue;
      const toolkit = composioToolkitsByProvider[slug];
      push({
        key: `int-${slug}`,
        slug,
        name: toolkit?.name ?? null,
        logo: toolkit?.logo ?? null,
        emoji: null,
        prompt,
      });
    }

    // 3. Generic capability examples backfill to MAX_ROWS.
    for (const [i, prompt] of CAPABILITY_SUGGESTIONS.entries()) {
      if (result.length >= MAX_ROWS) break;
      push({
        key: `gen-${i}`,
        slug: null,
        name: null,
        logo: null,
        emoji: null,
        prompt,
      });
    }

    return result;
  }, [composioToolkitsByProvider, connections, installedQuery.data]);

  if (!loaded || rows.length === 0) return null;

  return (
    <motion.div
      animate={{ opacity: 1, y: 0 }}
      className={className}
      initial={{ opacity: 0, y: 6 }}
      transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className="px-2 pb-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/55">
        Try first
      </div>
      <div className="flex flex-col">
        {rows.map((row, index) => (
          <SuggestionRow
            emoji={row.emoji}
            index={index}
            key={row.key}
            logo={row.logo}
            name={row.name}
            onClick={() => onSelect(row.prompt)}
            prompt={row.prompt}
            slug={row.slug}
          />
        ))}
      </div>
    </motion.div>
  );
}

interface SuggestionRowProps {
  index: number;
  slug: string | null;
  name: string | null;
  logo: string | null;
  emoji: string | null;
  prompt: string;
  onClick: () => void;
}

function SuggestionRow({
  index,
  slug,
  name,
  logo,
  emoji,
  prompt,
  onClick,
}: SuggestionRowProps) {
  let icon = <Sparkles className="size-3.5" />;
  if (slug) {
    icon = (
      <AppIcon
        appId={slug}
        iconUrl={logo}
        label={name ?? slug}
        providerId={slug}
        size="row"
      />
    );
  } else if (emoji) {
    icon = <span className="text-sm leading-none">{emoji}</span>;
  }
  return (
    <motion.button
      animate={{ opacity: 1, y: 0 }}
      className={cn(
        "group flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors",
        "hover:bg-fg-4",
      )}
      initial={{ opacity: 0, y: 4 }}
      onClick={onClick}
      transition={{
        duration: 0.28,
        delay: index * 0.04,
        ease: [0.22, 1, 0.36, 1],
      }}
      type="button"
      whileHover={{ y: -0.5 }}
      whileTap={{ scale: 0.997 }}
    >
      <span className="grid size-5 shrink-0 place-items-center text-muted-foreground/65">
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate text-[13px] text-foreground/85 group-hover:text-foreground">
        {prompt}
      </span>
      <span className="shrink-0 text-muted-foreground/0 transition-colors group-hover:text-muted-foreground/60">
        <ArrowRight className="size-3" />
      </span>
    </motion.button>
  );
}
