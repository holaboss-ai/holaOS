# First-Launch Onboarding — Redesign

**Status:** Draft · 2026-06-04
**Owner:** TBD
**Surfaces affected:** `apps/desktop` (renderer)

## Problem

The current first-launch experience for the desktop app is a three-step modal wizard (name → folder → layout) followed by an empty workspace with two abstract action cards (`Build an app` / `Hire a teammate`). The wizard adds friction before any value is delivered, the post-wizard landing is too generic to communicate what holaOS uniquely does, and there is no model-provider transparency, no in-product tour, and no contextual integration prompts. New users have to discover everything by themselves with the sidebar full of empty sections staring back at them.

We are also out of step with how mainstream AI SaaS (ChatGPT, Claude.ai, Cursor, v0, Bolt, Lovable, Replit Agent, Perplexity) onboards: they all skip role/industry capture and put the user in front of a productive input on the first screen.

## Goals

1. **One screen, one action** between login and the first chat message.
2. **Make holaOS's differentiator visible in 60 seconds** — apps, teammates, skills, integrations should appear naturally as a side-effect of the user's first task, not as a checklist.
3. **Model provider is transparent**, not hidden in Settings.
4. **Integration prompts are contextual** (appear when needed) rather than upfront grids.
5. **Power features get one-shot coachmarks** when the user is about to use them.

## Non-goals

- Forced API-key setup (default Holaboss Proxy works out of the box).
- Role / industry / "tell us about yourself" surveys.
- Modal video tours, splash carousels, or auto-playing tutorials.
- Folder-location / layout pickers on first launch (default values are fine, both are changeable later).

## Flow

```
Sign in ──→  Welcome Screen (one screen)  ──→  Workspace + Chat
                  │                              ↑
                  ├─ Type a prompt ───────────────┤
                  ├─ Click a starter chip ────────┤
                  ├─ Click a template card ───────┤ (template seeds apps + teammates)
                  └─ "Skip & start blank" ────────┘
```

The workspace is created **after** the user picks one of the four entry points, not before. Name is derived from the action ("Inbox summary", "Content creator workspace", etc.); folder uses the default Holaboss-managed path; layout defaults to `split`. All three are editable later.

## Screen 1 — Welcome

The only onboarding screen. Replaces the current `FirstWorkspacePane` wizard.

```
╭──────────────────────────────────────────────────────────────╮
│  ● ● ●                                                        │
│                                                                │
│                       holaOS                                   │
│                  your AI workspace                             │
│                                                                │
│       ╭──────────────────────────────────────────────╮       │
│       │  ✦  What would you like to get done?     ↵  │       │
│       ╰──────────────────────────────────────────────╯       │
│                                                                │
│       Try one of these                                         │
│       ╭──────────────────╮  ╭──────────────────╮             │
│       │ ✉️  Summarize my │  │ 🔍 Research the  │             │
│       │    inbox today   │  │   best CRM tools │             │
│       ╰──────────────────╯  ╰──────────────────╯             │
│       ╭──────────────────╮  ╭──────────────────╮             │
│       │ ✍️  Draft a cold │  │ 📅 Plan my week  │             │
│       │    email to …    │  │   from my cal.   │             │
│       ╰──────────────────╯  ╰──────────────────╯             │
│                                                                │
│       ─────────  or start from a template  ─────────          │
│                                                                │
│   ╭──────────────╮  ╭──────────────╮  ╭──────────────╮       │
│   │  👤          │  │  ✍️           │  │  🔍          │       │
│   │  Personal    │  │  Content     │  │  Researcher  │       │
│   │  Assistant   │  │  Creator     │  │              │       │
│   │  ─────────   │  │  ─────────   │  │  ─────────   │       │
│   │  Gmail · Cal │  │  Twitter ·   │  │  Browser ·   │       │
│   │  · memory    │  │  LinkedIn    │  │  summarizer  │       │
│   ╰──────────────╯  ╰──────────────╯  ╰──────────────╯       │
│                                                                │
│                  Skip & start blank                            │
╰──────────────────────────────────────────────────────────────╯
```

**Interaction rules**
- Input box is autofocused. The keyboard-driven path is the fastest path.
- A starter chip click does **not** drop the user into the composer to edit — it sends the message immediately. Confidence over edit-anxiety.
- A template card creates a workspace pre-loaded with that template's apps + teammates + skills, then drops the user into chat with a template-specific prefill (e.g., `Help me get started with my Researcher workspace`).
- `Skip & start blank` is visually small. It is an escape hatch, not a recommendation.

**Visual tone**
- Linear-style empty state. Generous vertical whitespace.
- Inter for the H1 / chips. Newsreader for the tagline only ("your AI workspace") to add a touch of craft.
- No gradients on cards. Solid backgrounds, fine 1px borders.
- The composer input is the visual anchor — bigger and more contrasted than anything else on the screen.

## Screen 2 — Post-first-message

After the user sends their first message (via any of the four entry points), they land in the regular workspace shell with the chat already in progress.

```
╭────────────╮ ╭──────────────────────────────────────────────╮
│ ▾ Personal │ │ ◀ Home  Inbox  Artifacts  ⊕                 │
├────────────┤ ├──────────────────────────────────────────────┤
│            │ │  You                                          │
│ (sidebar   │ │  Summarize my inbox today                     │
│  fades in  │ │                                               │
│  AFTER     │ │  ● Connecting to Gmail…                       │
│  first     │ │                                               │
│  reply)    │ │  Assistant                                    │
│            │ │  Here's what's in your inbox today…           │
│            │ │  …                                            │
│            │ │  ╭──────────────────────────────────────╮   │
│            │ │  │ 💡 Want this on your real inbox?     │   │
│            │ │  │ Connect Gmail to make this live.     │   │
│            │ │  │           [Connect]  [Maybe later]   │   │
│            │ │  ╰──────────────────────────────────────╯   │
│            │ ├──────────────────────────────────────────────┤
│            │ │ ▷ Reply…                 Claude Sonnet 4.6  │
│            │ ╰──────────────────────────────────────────────╯
╰────────────╯
```

**Three deliberate details**

1. **Sidebar is faded out** until the first assistant reply finishes streaming. Empty `Apps` / `Skills` / `Cronjobs` sections staring at a new user is a cognitive tax; defer them until the user has seen value first.
2. **The composer chrome always shows the current model** ("Claude Sonnet 4.6", "via Holaboss Proxy", etc.) — clickable to open Settings → Providers. Transparency = trust.
3. **Integration nudge cards appear contextually**, only when the message actually used a tool that needs a real integration (e.g., the agent invoked the Gmail tool but no Gmail account is bound). One nudge per missing integration per session.

## Coachmarks

One-shot, dismissible, surfaced when the user is about to need the feature.

```
                                     ╭──────────────────────╮
                                     │ Press ⌘T to open more│
                                     │ tabs anywhere.       │
                                     │             [ Got it ]│
                                     ╰─────────┬────────────╯
                                               │
   ╭──────────────────────────────────────────▾──╮
   │  ◀ Home  Inbox  Artifacts  ⊕                │
   ╰──────────────────────────────────────────────╯
```

**Triggers**
| Coachmark | Triggered when |
|---|---|
| `⌘T` opens tabs | User opens the second tab manually |
| `⌘K` global search | User hovers the sidebar search > 3s without typing |
| `/` slash commands | First time composer is focused with > 0 characters typed |
| `@` mentions | After the user has sent 3+ messages |

**Rules**
- Never two coachmarks visible at the same time.
- Each shown at most once per user, ever (persisted via electron settings).
- A single global "Reset onboarding tips" entry in Settings for users who want them again.

## Templates (initial set)

Three templates plus blank. Each template is concrete enough to demonstrate holaOS's apps + teammates layer in the first session.

| Template | Pre-installed apps | Pre-hired teammate | Prefill message |
|---|---|---|---|
| **Personal Assistant** | Gmail, Calendar, Notes | "Alex" (assistant persona) | `Help me organize my day` |
| **Content Creator** | Twitter, LinkedIn, Browser | "Sam" (content strategist) | `Draft a post about [topic]` |
| **Researcher** | Browser, Notes | "Maya" (research lead) | `Help me research [topic]` |
| **Blank** | — | — | (empty composer) |

Three is enough to cover the bulk of "I don't know what I want" users. More templates can be added once we see which ones get clicked.

## Starter chips (initial set)

Six concrete prompts. Each one resolves to a chat message that exercises at least one app or skill.

1. `Summarize my inbox today` (gmail)
2. `Research the best CRM tools for product designers` (browser + summarize)
3. `Draft a cold email to investors` (writing skill)
4. `Plan my week from my calendar` (calendar)
5. `Build me a personal CRM with contacts and notes` (app builder)
6. `Hire me a teammate who helps me review code` (teammates)

These are not random — each is chosen to reveal a different surface of the product (integrations, browser, writing skills, app builder, teammates).

## What we are explicitly NOT doing

- ❌ Role / industry / persona dropdowns
- ❌ Workspace name field on first launch
- ❌ Folder picker on first launch
- ❌ Layout picker on first launch
- ❌ "How did you hear about us" surveys
- ❌ Forced API-key setup before first chat
- ❌ Modal video tours
- ❌ Auto-playing splash carousels

## Phased rollout

**P0 — Welcome screen replaces wizard.** Highest impact, independent. Measure first-message conversion before/after.

**P0 — Starter chips + templates.** Same screen, ships together. Three templates is enough for v1.

**P1 — Model visible in composer chrome.** Small, isolated change in the chat composer header.

**P1 — Contextual integration nudges.** Wire the existing `connect integration` flow to the agent's tool-call site so the nudge appears when (and only when) a missing integration was needed.

**P2 — Coachmarks system.** Build a generic `useCoachmark(id, trigger, anchor)` hook with electron-settings-backed dismissal state. Add the four initial coachmarks.

**P2 — Sidebar fade-in on first message.** Polish; don't gate P0 / P1 on it.

## Open questions

- Should the starter chips also surface in the empty composer of any new chat session (not just first launch), as a recurring "what next" affordance?
- Should templates be editable post-creation (e.g., "convert this workspace to Researcher template")? Probably not for v1.
- Where do we persist the "user has completed first-launch onboarding" flag? Electron settings, runtime DB, or backend user profile? Backend is best so it survives reinstall, but electron settings is fastest to ship.
- Does the auto-derived workspace name come from a local heuristic on the prompt, or from a quick LLM call? LLM gives nicer names but adds latency.

## Success metrics

- **Time from sign-in to first sent message.** Target: median < 30 seconds.
- **% of new users who send a first message within the same session as sign-up.** Target: > 80%.
- **Distribution of entry points** (typed prompt vs starter chip vs template vs skip). Use this to refine the chip and template lists.
- **% of new users who connect at least one integration in the first 7 days.** Indirect signal that the contextual nudge works.
