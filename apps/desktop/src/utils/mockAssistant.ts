export interface ChatMessage {
  id: string;
  role: "assistant" | "user";
  text: string;
}

const rules: Array<{ triggers: string[]; reply: string }> = [
  {
    triggers: ["document", "report"],
    reply:
      "I can draft a clean outline first, then generate a polished first version with executive summary, key insights, and next actions."
  },
  {
    triggers: ["data", "chart"],
    reply:
      "Share the dataset shape and metrics you care about. I can propose chart types, summarize trends, and draft talking points."
  },
  {
    triggers: ["ppt", "presentation", "slide"],
    reply:
      "I can build a slide narrative with title flow, visuals to include, and speaker notes for each section."
  },
  {
    triggers: ["organize", "files"],
    reply:
      "I can suggest a folder taxonomy, naming standard, and cleanup checklist to make your workspace searchable and stable."
  },
  {
    triggers: ["research", "topic"],
    reply:
      "I can break the topic into questions, gather structured findings, and provide a concise brief with cited takeaways."
  },
  {
    triggers: ["email", "draft", "send"],
    reply:
      "I can produce a ready-to-send email with tone options: concise, persuasive, or formal. Tell me audience and objective."
  },
  {
    triggers: ["code", "debug", "bug"],
    reply:
      "I can inspect the issue, isolate likely failure points, and propose a patch plus a test plan so it stays fixed."
  }
];

export function generateMockReply(input: string): string {
  const lower = input.toLowerCase();
  const matchedRule = rules.find((rule) => rule.triggers.some((trigger) => lower.includes(trigger)));

  if (matchedRule) {
    return matchedRule.reply;
  }

  return "I can help you map the task, draft the output, and break it into actionable steps. Tell me your target outcome.";
}

export const initialAssistantMessage: ChatMessage = {
  id: "assistant-initial",
  role: "assistant",
  text: "Welcome aboard. I can help with productivity, coding, documents, and focused research in this workspace."
};

export const suggestionPills = [
  "Help me create a document or report",
  "Analyze data or make charts",
  "Design a PPT presentation",
  "Organize my files",
  "Research a topic for me",
  "Draft and send an email",
  "Write or debug some code"
];
