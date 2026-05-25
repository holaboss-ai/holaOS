/**
 * Client-side mirror of the toolkit display names. Kept in sync manually
 * with `runtime/api-server/src/integration-store-catalog.ts` — when adding
 * a toolkit to the store catalog, add its display name here too.
 *
 * Used by chat-side surfaces (IntegrationErrorBanner, IntegrationProposalCard,
 * IntegrationConnectCard) to render the same human-readable provider name
 * regardless of which slug variant comes from the runtime / Composio.
 */

const TOOLKIT_DISPLAY_NAMES: Record<string, string> = {
  // email
  gmail: "Gmail",
  outlook: "Outlook",
  mailchimp: "Mailchimp",
  klaviyo: "Klaviyo",
  kit: "Kit",
  sendgrid: "SendGrid",
  // calendar
  googlecalendar: "Google Calendar",
  // productivity
  googledrive: "Google Drive",
  notion: "Notion",
  // comm
  slack: "Slack",
  discord: "Discord",
  microsoft_teams: "Microsoft Teams",
  zoom: "Zoom",
  intercom: "Intercom",
  // dev
  github: "GitHub",
  gitlab: "GitLab",
  linear: "Linear",
  jira: "Jira",
  asana: "Asana",
  confluence: "Confluence",
  clickup: "ClickUp",
  trello: "Trello",
  monday: "Monday",
  shortcut: "Shortcut",
  height: "Height",
  // ci_cloud
  vercel: "Vercel",
  cloudflare: "Cloudflare",
  fly: "Fly.io",
  render: "Render",
  // db
  supabase: "Supabase",
  airtable: "Airtable",
  googlesheets: "Google Sheets",
  // observability
  sentry: "Sentry",
  datadog: "Datadog",
  pagerduty: "PagerDuty",
  // ai_data
  hugging_face: "Hugging Face",
  pinecone: "Pinecone",
  // social
  twitter: "Twitter",
  linkedin: "LinkedIn",
  reddit: "Reddit",
  youtube: "YouTube",
  facebook: "Facebook",
  // analytics
  google_analytics: "Google Analytics",
  mixpanel: "Mixpanel",
  amplitude: "Amplitude",
  posthog: "PostHog",
  // crm
  hubspot: "HubSpot",
  salesforce: "Salesforce",
  pipedrive: "Pipedrive",
  attio: "Attio",
  zendesk: "Zendesk",
  freshdesk: "Freshdesk",
  zoho: "Zoho",
  // ads
  googleads: "Google Ads",
  metaads: "Meta Ads",
  linkedin_ads: "LinkedIn Ads",
  // commerce
  stripe: "Stripe",
  shopify: "Shopify",
  // design
  figma: "Figma",
  // aliases / fallbacks for upstream variants
  google: "Google",
};

export function toolkitDisplayName(slug: string): string {
  if (!slug) return "this provider";
  const key = slug.trim().toLowerCase();
  const known = TOOLKIT_DISPLAY_NAMES[key];
  if (known) return known;
  return key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, " ");
}

export function knownToolkitSlugs(): string[] {
  return Object.keys(TOOLKIT_DISPLAY_NAMES);
}
