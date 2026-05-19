/**
 * Static template catalog shown when the user is not authenticated.
 * Keeps the marketplace browsable before sign-in.
 * Mirrors the official templates from the backend marketplace registry.
 */

const FLUENT_CDN = "https://cdn.jsdelivr.net/gh/microsoft/fluentui-emoji/assets";

function emojiUrl(name: string): string {
  const slug = name.toLowerCase().replaceAll(" ", "_").replaceAll("%20", "_");
  return `${FLUENT_CDN}/${name}/3D/${slug}_3d.png`;
}

export const FALLBACK_TEMPLATES: TemplateMetadataPayload[] = [
  {
    name: "social_operator",
    display_name: "Social Operator",
    repo: "",
    path: "",
    default_ref: "main",
    description:
      "Runs content creation and scheduling across Twitter, LinkedIn, and Reddit.",
    is_hidden: false,
    is_coming_soon: false,
    allowed_user_ids: [],
    icon: "Megaphone01Icon",
    emoji: emojiUrl("Megaphone"),
    apps: [
      { name: "twitter", required: false },
      { name: "linkedin", required: false },
      { name: "reddit", required: false },
    ],
    min_optional_apps: 1,
    tags: ["social media", "automation", "content"],
    category: "marketing",
    long_description:
      "A complete social media operations template. Creates content, schedules posts across platforms, and tracks engagement — you set the direction and review results.",
    agents: [],
    views: [
      { name: "Content Calendar", description: "Timeline of all scheduled content" },
      { name: "Publish Status", description: "Real-time publishing status across platforms" },
      { name: "Engagement Analytics", description: "Interaction trends and AI recommendations" }
    ]
  },
  {
    name: "inbox_worker",
    display_name: "Inbox",
    repo: "",
    path: "",
    default_ref: "main",
    description:
      "Searches threads, reads conversations, and drafts replies in Gmail.",
    is_hidden: false,
    is_coming_soon: false,
    allowed_user_ids: [],
    icon: "Mail01Icon",
    emoji: emojiUrl("E-mail"),
    apps: [{ name: "gmail", required: true }],
    min_optional_apps: 0,
    tags: ["gmail", "email", "mcp"],
    category: "productivity",
    long_description:
      "A Gmail-first workspace template with AI-powered inbox management. Searches threads, reads conversations, and creates email drafts — you just review and send.",
    agents: [],
    views: [
      { name: "Inbox", description: "Search and inspect Gmail threads" },
      { name: "Drafts", description: "Create and review Gmail drafts" }
    ]
  },
  {
    name: "devrel_worker",
    display_name: "DevRel",
    repo: "",
    path: "",
    default_ref: "main",
    description:
      "Turns GitHub commits into social posts. Ship code, grow audience.",
    is_hidden: false,
    is_coming_soon: false,
    allowed_user_ids: [],
    icon: "StartUp02Icon",
    emoji: emojiUrl("Rocket"),
    apps: [
      { name: "github", required: true },
      { name: "twitter", required: false },
      { name: "linkedin", required: false },
    ],
    min_optional_apps: 0,
    tags: ["developer", "github", "content"],
    category: "marketing",
    long_description:
      "Connects GitHub and turns commits, releases, and issues into engaging social posts. Perfect for indie hackers and dev teams who want to build in public without the effort.",
    agents: [],
    views: [
      { name: "Activity Feed", description: "GitHub activity timeline" },
      { name: "Content Queue", description: "Drafted posts ready for review" }
    ]
  },
  {
    name: "starter",
    display_name: "Starter",
    repo: "",
    path: "",
    default_ref: "main",
    description: "A blank slate — build your own AI workflows from scratch.",
    is_hidden: false,
    is_coming_soon: false,
    allowed_user_ids: [],
    icon: "StartUp02Icon",
    emoji: emojiUrl("Glowing%20star"),
    apps: [],
    min_optional_apps: 0,
    tags: ["starter", "developer"],
    category: "featured",
    long_description:
      "A blank canvas workspace with minimal configuration. Ideal for developers who want to build custom AI workflows and add modules one by one.",
    agents: [],
    views: []
  },
  {
    name: "sales_worker",
    display_name: "Sales CRM",
    repo: "",
    path: "",
    default_ref: "main",
    description: "Manages contacts and deals via Gmail and Google Sheets.",
    is_hidden: false,
    is_coming_soon: false,
    allowed_user_ids: [],
    icon: "Contact02Icon",
    emoji: emojiUrl("Handshake"),
    apps: [
      { name: "gmail", required: true },
      { name: "sheets", required: true },
    ],
    min_optional_apps: 0,
    tags: ["crm", "email", "contacts"],
    category: "productivity",
    long_description:
      "A lightweight CRM template that uses Google Sheets as your contact database and Gmail for email conversations. Syncs contacts, reads email threads for context, drafts personalized follow-ups, and tracks your pipeline — all through natural conversation.",
    agents: [],
    views: [
      { name: "Contacts", description: "Contact list with pipeline stages" },
      { name: "Email Drafts", description: "Pending emails awaiting confirmation" }
    ]
  }
];
