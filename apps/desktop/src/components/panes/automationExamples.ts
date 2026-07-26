/** Curated first-run examples, outcome-named. Clicking one opens a preview
 *  (sample output + Set up); "Set up" prefills the manual create dialog so no
 *  chat turn is spent. `draftPrompt` remains the optional Hola-interview path.
 *  "News watch" needs no connected integration so a fresh user always has a
 *  path that succeeds. */
export interface AutomationExampleSample {
  title: string;
  intro: string;
  bullets: Array<{ label: string; text: string }>;
}

export interface AutomationExample {
  id: string;
  name: string;
  scheduleHint: string;
  benefit: string;
  /** Ready-to-run instruction used to prefill the manual create dialog.
   *  Written to degrade gracefully untouched: where personalization matters
   *  it tells the agent to check memory or ask in the run itself. */
  instruction: string;
  /** Default 5-field cron matching `scheduleHint`. */
  cron: string;
  /** Illustrative output shown in the example preview. */
  sample: AutomationExampleSample;
  draftPrompt: string;
}

export const AUTOMATION_EXAMPLES: AutomationExample[] = [
  {
    id: "morning-briefing",
    name: "Morning briefing",
    scheduleHint: "Daily 9:00",
    benefit: "Summarize unread email into one note",
    instruction:
      "Go through my unread email and summarize what matters into one short note: what needs a reply, what's just FYI, and anything time-sensitive. Draft replies only if something is urgent.",
    cron: "0 9 * * *",
    sample: {
      title: "Inbox brief · Mon 9:02",
      intro: "Morning — 14 unread, 3 worth your time.",
      bullets: [
        {
          label: "Acme renewal",
          text: "Legal redlines are back; the SLA clause is the only blocker. They asked for a reply by EOD.",
        },
        {
          label: "Invoice #482",
          text: "Finance flagged a total mismatch — I drafted a correction for your review.",
        },
        {
          label: "FYI",
          text: "Two PTO requests are waiting on your approval.",
        },
      ],
    },
    draftPrompt:
      "Set up an automation for me: every morning around 9, go through my unread email and summarize what matters into one short note. Ask me what you need to know, then create it.",
  },
  {
    id: "content-ideas",
    name: "Content ideas",
    scheduleHint: "Mon 9:00",
    benefit: "Draft post ideas from last week's news in your field",
    instruction:
      "Draft three social post ideas based on the past week's news in my industry. For each one give a hook, the angle, and which platform it fits. Check memory for my industry and voice; if you don't know them yet, infer from my recent work and say what you assumed.",
    cron: "0 9 * * 1",
    sample: {
      title: "Post ideas · Mon 9:00",
      intro: "Three angles from last week's news:",
      bullets: [
        {
          label: "LinkedIn",
          text: "“Most teams track the wrong retention number” — react to the churn report everyone shared last week.",
        },
        {
          label: "X thread",
          text: "5 takeaways from LaunchCo's pricing change, closing with your own contrarian take.",
        },
        {
          label: "Carousel",
          text: "Before/after: what your Monday morning looks like once the busywork runs itself.",
        },
      ],
    },
    draftPrompt:
      "Set up an automation for me: every Monday morning around 9, draft a few post ideas based on the past week's news in my industry. Ask me which industry and platforms to focus on, then create it.",
  },
  {
    id: "news-watch",
    name: "News watch",
    scheduleHint: "Daily 8:00",
    benefit: "Track a topic on the web, report what changed",
    instruction:
      "Check the web for news about the topics I care about and give me a short summary of what changed since yesterday. Check memory for my topics; if you don't know them yet, infer from my recent work and say what you picked.",
    cron: "0 8 * * *",
    sample: {
      title: "News watch · Jul 5",
      intro: "Three developments on your topics since yesterday.",
      bullets: [
        {
          label: "Competitor",
          text: "LaunchCo shipped scheduled posting — overlaps your Q3 roadmap item.",
        },
        {
          label: "Platform",
          text: "X raised API rate limits for verified apps; posting quotas loosen next month.",
        },
        {
          label: "Trend",
          text: "Short-form carousels keep outperforming single images across B2B accounts.",
        },
      ],
    },
    draftPrompt:
      "Set up an automation for me: every morning around 8, check the web for news about a topic I care about and give me a short summary of what changed. Ask me for the topic, then create it.",
  },
  {
    id: "meeting-prep",
    name: "Meeting prep",
    scheduleHint: "Weekdays 8:30",
    benefit: "Brief you on today's calendar before the day starts",
    instruction:
      "Look at today's calendar and brief me on my meetings: attendees, agenda, relevant context from recent email and notes, and anything I should prepare beforehand.",
    cron: "30 8 * * 1-5",
    sample: {
      title: "Today · 2 meetings",
      intro: "Product review moved up to 10:00; your afternoon is clear.",
      bullets: [
        {
          label: "10:00 Product review",
          text: "Q3 roadmap sign-off. Priya owes the metrics readout; the open question is whether search lands in Q3.",
        },
        {
          label: "Prep",
          text: "I pulled current velocity numbers into the doc — honest answer is Q3 if sorting is cut.",
        },
      ],
    },
    draftPrompt:
      "Set up an automation for me: every weekday around 8:30, look at today's calendar and brief me on my meetings and anything I should prepare. Ask me what you need, then create it.",
  },
];
