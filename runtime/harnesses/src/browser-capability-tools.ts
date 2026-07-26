import {
  browserCapabilityAvailable,
  closeBrowserCapabilityProfile,
  executeBrowserCapabilityTool,
  launchBrowserCapabilityProfile,
  listBrowserCapabilityProfiles,
  resolveBrowserCapabilityBaseUrl,
} from "./browser-capability-client.js";
import {
  DESKTOP_BROWSER_TOOL_DEFINITIONS,
  type DesktopBrowserToolDefinition,
  type DesktopBrowserToolId,
} from "./desktop-browser-tools.js";

/**
 * The browser-profile tools this module adds ON TOP of the desktop browser
 * capability manifest. Because they aren't in that manifest, the harness-host
 * request `tools` allowlist (derived from the manifest) would filter them out —
 * so the pi request builder must enable these names explicitly when the browser
 * family is active (mirrors how resolved MCP tools are force-enabled). Keep in
 * sync with the tool `name`s below.
 */
export const BROWSER_PROFILE_TOOL_NAMES = [
  "browser_launch_profile",
  "browser_close_profile",
  "browser_use_profile",
  "browser_list_profiles",
] as const;

/**
 * Every browser tool name the harness surfaces: the desktop capability tools
 * (browser_navigate / browser_get_state / browser_click / …) plus the profile
 * tools above. The whole family is resolved outside `mcp_tool_refs`, so NONE of
 * these are in the request `tools` allowlist derived from the capability
 * manifest — the pi request builder must enable all of them when the browser
 * family is active, or they're silently filtered out.
 */
export const ALL_BROWSER_TOOL_NAMES: readonly string[] = [
  ...DESKTOP_BROWSER_TOOL_DEFINITIONS.map((definition) => definition.id),
  ...BROWSER_PROFILE_TOOL_NAMES,
];

export interface HarnessDesktopBrowserToolOptions {
  runtimeApiBaseUrl: string;
  workspaceId?: string | null;
  sessionId?: string | null;
  inputId?: string | null;
  space?: "agent" | null;
  // Initial browser profile the agent drives (the desktop falls back to its
  // Default profile when unset). Mutable at runtime via browser_use_profile.
  browserProfileId?: string | null;
  fetchImpl?: typeof fetch;
}

/** Mutable holder for the agent's currently-selected browser profile. */
interface BrowserProfileSelection {
  current: string | null;
}

function normalizeSelectedBrowserProfileId(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

interface NumberedBrowserProfile {
  id: string;
  name: string;
  index: number;
  running?: boolean;
  /** The user's pinned default browser — used when a tool names no profile. */
  isDefault?: boolean;
}

/**
 * Resolve a user/agent profile reference to a concrete profile. Accepts the
 * profile number as shown in the Profiles page and browser_list_profiles
 * ("1", "#1"), the profile name (case-insensitive, exact or a unique partial),
 * or the raw profile id — so "use profile #1" works.
 */
export function resolveBrowserProfileSelector(
  raw: string,
  profiles: NumberedBrowserProfile[],
): NumberedBrowserProfile | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const byId = profiles.find((profile) => profile.id === trimmed);
  if (byId) {
    return byId;
  }
  const numericToken = trimmed.replace(/^#/, "");
  if (/^\d+$/.test(numericToken)) {
    const byIndex = profiles.find(
      (profile) => profile.index === Number(numericToken),
    );
    if (byIndex) {
      return byIndex;
    }
  }
  const lower = trimmed.toLowerCase();
  const byNameExact = profiles.find(
    (profile) => profile.name.toLowerCase() === lower,
  );
  if (byNameExact) {
    return byNameExact;
  }
  const byNamePartial = profiles.filter((profile) =>
    profile.name.toLowerCase().includes(lower),
  );
  return byNamePartial.length === 1 ? byNamePartial[0] : null;
}

/** Pull a profile selector string from tool params (number/name/id + aliases). */
function readProfileSelector(params: Record<string, unknown>): string | null {
  const candidate =
    params.profile ??
    params.browser_profile ??
    params.browser_profile_id ??
    params.name ??
    params.index;
  return typeof candidate === "number"
    ? String(candidate)
    : normalizeSelectedBrowserProfileId(candidate);
}

/**
 * Entry tools that accept an optional `browser_profile` selector. When the agent
 * names none, the tool auto-picks the user's pinned default, else the
 * currently-open browser, else the first profile (see pickFallbackBrowserProfile).
 * (See docs/cdp/migration-to-real-chrome.md.)
 */
const BROWSER_PROFILE_ENTRY_TOOLS: ReadonlySet<string> = new Set([
  "browser_navigate",
  "browser_open_tab",
]);

/** Schema for the optional `browser_profile` selector on the entry tools. */
function browserProfileParamSchema(): Record<string, unknown> {
  return {
    type: "string",
    description:
      'Which of the user\'s Browser Profiles to drive — its name, its number from browser_list_profiles (e.g. "1" or "#1"), or its id. Pass this when the user named or clearly implied a specific browser. OMIT it to auto-pick: the user\'s pinned default, else a currently-open browser, else their only/first profile. This is the app\'s built-in browser-profile system — NEVER a third-party tool like AdsPower.',
    minLength: 1,
  };
}

function browserToolTextResult(
  text: string,
): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text }] };
}

/** Drop the harness-only profile selector so it never reaches the desktop body. */
function stripProfileSelector(
  params: Record<string, unknown>,
): Record<string, unknown> {
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (
      key !== "profile" &&
      key !== "browser_profile" &&
      key !== "browser_profile_id" &&
      key !== "name" &&
      key !== "index"
    ) {
      rest[key] = value;
    }
  }
  return rest;
}

/**
 * The profile an entry tool drives when the agent names none and the session has
 * no active profile yet: honour the user's pinned default first (an explicit,
 * durable choice — often the browser they're logged into), then a currently-open
 * (running) browser, then the sole/first profile.
 *
 * The pin MUST outrank a merely-running profile: the permanent "Main" profile is
 * auto-created and its detached Chromium is sticky-running (adopted across
 * restarts), so a running-first rule would let incidental Main hijack every
 * no-name browse even after the user pinned a different default.
 */
export function pickFallbackBrowserProfile(
  profiles: NumberedBrowserProfile[],
): NumberedBrowserProfile | null {
  return (
    profiles.find((profile) => profile.isDefault) ??
    profiles.find((profile) => profile.running) ??
    profiles[0] ??
    null
  );
}

/**
 * Fetch the live profile list and resolve a selector against it. When `raw` is
 * empty, `match` auto-picks via pickFallbackBrowserProfile (pinned default, else
 * currently-open, else first) so an entry tool with no explicit `browser_profile`
 * drives a sensible browser instead of erroring.
 */
async function resolveProfileFromSelector(
  raw: string,
  options: HarnessDesktopBrowserToolOptions,
  signal?: AbortSignal,
): Promise<{ match: NumberedBrowserProfile | null; available: string }> {
  const profiles = await listBrowserCapabilityProfiles({
    runtimeApiBaseUrl: options.runtimeApiBaseUrl,
    workspaceId: options.workspaceId,
    sessionId: options.sessionId,
    inputId: options.inputId,
    space: options.space,
    fetchImpl: options.fetchImpl,
    signal,
  });
  const available = profiles.length
    ? profiles.map((profile) => `#${profile.index} ${profile.name}`).join(", ")
    : "none";
  const match = raw.trim()
    ? resolveBrowserProfileSelector(raw, profiles)
    : pickFallbackBrowserProfile(profiles);
  return { match, available };
}

export interface HarnessDesktopBrowserToolDefinitionLike {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  parameters: Record<string, unknown>;
  execute: (...args: any[]) => Promise<any>;
}

function browserToolLabel(toolId: DesktopBrowserToolId): string {
  return toolId
    .split("_")
    .map((part) => (part === "browser" ? "Browser" : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(" ");
}

function literalStringUnion(values: string[], description: string): Record<string, unknown> {
  return {
    anyOf: values.map((value) => ({ type: "string", const: value })),
    description,
  };
}

function browserLocatorProperties(): Record<string, unknown> {
  return {
    ref: {
      type: "string",
      description: "Stable ref returned by browser_find.",
    },
    text: {
      type: "string",
      description: "Visible text to find. Matches case-insensitively unless exact=true.",
    },
    label: {
      type: "string",
      description: "Accessible label, title, aria-label, value, or nearby label text to find.",
    },
    placeholder: {
      type: "string",
      description: "Input placeholder text to find.",
    },
    role: {
      type: "string",
      description: "ARIA or inferred element role, such as button, link, textbox, combobox, option, dialog, or menuitem.",
    },
    selector: {
      type: "string",
      description: "CSS selector to locate the target.",
    },
    xpath: {
      type: "string",
      description: "XPath expression to locate the target.",
    },
    exact: {
      type: "boolean",
      description: "Require an exact normalized text/label/placeholder match.",
    },
    scope: {
      anyOf: [
        { type: "string", const: "main" },
        { type: "string", const: "viewport" },
        { type: "string", const: "focused" },
        { type: "string", const: "dialog" },
        { type: "string", const: "active_dialog" },
        { type: "string", const: "modal" },
      ],
      description:
        "Limit matching to the main document, current viewport, focused subtree, or active dialog. `active_dialog` and `modal` are accepted aliases for `dialog`.",
    },
  };
}

function browserWaitConditionValues(): string[] {
  return [
    "load",
    "load_state",
    "url",
    "text",
    "element",
    "hidden",
    "dom_change",
    "dom_mutation",
    "change",
    "mutation",
    "function",
    "download_started",
    "download_completed",
  ];
}

function browserWaitShorthandValues(): string[] {
  return [
    "load",
    "url",
    "text",
    "element",
    "hidden",
    "dom_change",
    "dom_mutation",
    "change",
    "mutation",
    "function",
    "download_started",
    "download_completed",
    "interactive",
    "domcontentloaded",
    "complete",
  ];
}

function browserWaitForParameters(description: string): Record<string, unknown> {
  return {
    anyOf: [
      {
        type: "string",
        enum: browserWaitShorthandValues(),
      },
      {
        type: "object",
        properties: {
          condition: literalStringUnion(
            browserWaitConditionValues(),
            "Browser condition to wait for.",
          ),
          load_state: literalStringUnion(
            ["interactive", "domcontentloaded", "complete", "load"],
            "Explicit page readiness target for load waits.",
          ),
          expression: {
            type: "string",
            description:
              "JavaScript expression or function source to poll until it returns a truthy value when condition=function.",
          },
          url: {
            type: "string",
            description: "URL substring or regular expression body to wait for when condition=url.",
          },
          filename: {
            type: "string",
            description:
              "Download filename substring or exact name to wait for when condition=download_started or download_completed.",
          },
          ...browserLocatorProperties(),
        },
        additionalProperties: false,
      },
    ],
    description,
  };
}

function browserToolParameters(toolId: DesktopBrowserToolId): Record<string, unknown> {
  switch (toolId) {
    case "browser_navigate":
      return {
        type: "object",
        properties: {
          browser_profile: browserProfileParamSchema(),
          url: {
            type: "string",
            description: "The URL to open in the browser profile window.",
            minLength: 1,
          },
        },
        required: ["url"],
        additionalProperties: false,
      };
    case "browser_open_tab":
      return {
        type: "object",
        properties: {
          browser_profile: browserProfileParamSchema(),
          url: {
            type: "string",
            description: "The URL to open in a new tab of the browser profile window.",
            minLength: 1,
          },
          background: {
            type: "boolean",
            description: "Open the tab without switching focus.",
          },
        },
        required: ["url"],
        additionalProperties: false,
      };
    case "browser_get_state":
      return {
        type: "object",
        properties: {
          mode: {
            anyOf: [
              { type: "string", const: "state" },
              { type: "string", const: "text" },
              { type: "string", const: "structured" },
              { type: "string", const: "visual" },
            ],
            description:
              "State mode to return. Use `state` by default, `text` for scoped visible text, `structured` for schema-like extraction state, and `visual` only when a screenshot is needed.",
          },
          detail: {
            anyOf: [
              { type: "string", const: "compact" },
              { type: "string", const: "standard" },
            ],
            description:
              "Response detail level. `compact` is the default and returns a smaller actionable snapshot. Use `standard` when you need a broader page inventory.",
          },
          scope: {
            anyOf: [
              { type: "string", const: "main" },
              { type: "string", const: "viewport" },
              { type: "string", const: "focused" },
              { type: "string", const: "dialog" },
              { type: "string", const: "active_dialog" },
              { type: "string", const: "modal" },
            ],
            description:
              "Limit browser state to the main document, viewport, focused element subtree, or active dialog. `active_dialog` and `modal` are accepted aliases for `dialog`.",
          },
          max_nodes: {
            type: "integer",
            description:
              "Maximum combined element/media nodes to return. Returned indexes still reference the original page order for follow-up click/type tools.",
            minimum: 1,
          },
          since_revision: {
            type: "string",
            description:
              "Prior revision returned by browser_get_state. Use together with changed_only=true to avoid a full snapshot when the page has not changed.",
            minLength: 1,
          },
          changed_only: {
            type: "boolean",
            description:
              "When true and since_revision matches the current page revision, return only revision metadata instead of a full snapshot.",
          },
          include_page_text: {
            type: "boolean",
            description:
              "Include current page text when content extraction is needed. Leave false for cheaper action-focused state checks.",
          },
          include_screenshot: {
            type: "boolean",
            description:
              "Include a page screenshot artifact handle when visual appearance, layout, overlays, charts, PDFs, or user-visible confirmation matter, or when DOM signals are ambiguous.",
          },
        },
        additionalProperties: false,
      };
    case "browser_find":
      return {
        type: "object",
        properties: {
          ...browserLocatorProperties(),
          include_hidden: {
            type: "boolean",
            description: "Include hidden/offscreen elements. Leave false for ordinary browser interaction.",
          },
          max_results: {
            type: "integer",
            description: "Maximum matches to return.",
            minimum: 1,
            maximum: 100,
          },
        },
        additionalProperties: false,
      };
    case "browser_act":
      return {
        type: "object",
        properties: {
          action: literalStringUnion(
            ["click", "double_click", "hover", "focus", "fill", "type", "press", "select", "check", "uncheck", "scroll_into_view"],
            "Browser action to perform.",
          ),
          ...browserLocatorProperties(),
          value: {
            type: "string",
            description: "Text/value for fill, type, or select actions.",
          },
          key: {
            type: "string",
            description: "Keyboard key for press actions.",
          },
          clear: {
            type: "boolean",
            description: "Clear editable content before fill/type. Defaults true for fill and false for type.",
          },
          submit: {
            type: "boolean",
            description: "Submit after fill/type, usually by pressing Enter or requestSubmit.",
          },
          wait_for: browserWaitForParameters(
            "Optional inline stabilization wait. Use a string shorthand like `interactive` or a full wait object for element, text, URL, DOM change, function, or download waits.",
          ),
          wait_timeout_ms: {
            type: "integer",
            description: "Maximum inline stabilization wait time in milliseconds.",
            minimum: 100,
            maximum: 30000,
          },
          post_state: literalStringUnion(
            ["none", "page", "state"],
            "Post-action follow-up to return. `page` is a cheap page summary, `state` returns a compact post-action snapshot, and `none` skips follow-up state.",
          ),
        },
        required: ["action"],
        additionalProperties: false,
      };
    case "browser_select_tab":
    case "browser_close_tab":
      return {
        type: "object",
        properties: {
          tab_id: {
            type: "string",
            description: "Browser tab id returned by browser_list_tabs.",
            minLength: 1,
          },
        },
        required: ["tab_id"],
        additionalProperties: false,
      };
    case "browser_wait":
      return {
        type: "object",
        properties: {
          condition: literalStringUnion(
            browserWaitConditionValues(),
            "Browser condition to wait for.",
          ),
          load_state: literalStringUnion(
            ["interactive", "domcontentloaded", "complete", "load"],
            "Explicit page readiness target for load waits. Use `interactive` or `domcontentloaded` after lightweight SPA transitions, or `complete`/`load` for full page load completion.",
          ),
          expression: {
            type: "string",
            description:
              "JavaScript expression or function source to poll until it returns a truthy value when condition=function.",
          },
          url: {
            type: "string",
            description: "URL substring or regular expression body to wait for when condition=url.",
          },
          filename: {
            type: "string",
            description:
              "Download filename substring or exact name to wait for when condition=download_started or download_completed.",
          },
          ...browserLocatorProperties(),
          timeout_ms: {
            type: "integer",
            description: "Maximum wait time in milliseconds.",
            minimum: 100,
            maximum: 30000,
          },
        },
        additionalProperties: false,
      };
    case "browser_evaluate":
      return {
        type: "object",
        properties: {
          expression: {
            type: "string",
            description: "JavaScript expression or IIFE to evaluate in the active page.",
            minLength: 1,
          },
          allow_mutation: {
            type: "boolean",
            description:
              "Set true when the expression intentionally mutates page state. Leave false for read-only inspection.",
          },
          timeout_ms: {
            type: "integer",
            description: "Maximum evaluation time in milliseconds.",
            minimum: 100,
            maximum: 30000,
          },
        },
        required: ["expression"],
        additionalProperties: false,
      };
    case "browser_debug":
      return {
        type: "object",
        properties: {
          x: {
            type: "number",
            description: "Viewport x coordinate for elementFromPoint hit testing.",
          },
          y: {
            type: "number",
            description: "Viewport y coordinate for elementFromPoint hit testing.",
          },
          include_dom_sample: {
            type: "boolean",
            description: "Include a compact sample of visible DOM text and element tags.",
          },
        },
        additionalProperties: false,
      };
    case "browser_click":
      return {
        type: "object",
        properties: {
          index: {
            type: "integer",
            description: "Interactive element index from browser_get_state.",
            minimum: 1,
          },
          wait_for: browserWaitForParameters(
            "Optional inline stabilization wait. Use a string shorthand like `interactive` or a full wait object for URL, text, element, DOM change, function, or download waits.",
          ),
          wait_timeout_ms: {
            type: "integer",
            description: "Maximum inline stabilization wait time in milliseconds.",
            minimum: 100,
            maximum: 30000,
          },
          post_state: literalStringUnion(
            ["none", "page", "state"],
            "Post-click follow-up to return. `page` is the default for browser_click.",
          ),
        },
        required: ["index"],
        additionalProperties: false,
      };
    case "browser_context_click":
      return {
        type: "object",
        properties: {
          index: {
            type: "integer",
            description: "Element or media index from browser_get_state.",
            minimum: 1,
          },
          target: literalStringUnion(
            ["element", "media"],
            "Target list to use for the index. Use `media` for visible images or other media items.",
          ),
        },
        required: ["index"],
        additionalProperties: false,
      };
    case "browser_type":
      return {
        type: "object",
        properties: {
          index: {
            type: "integer",
            description: "Interactive element index from browser_get_state.",
            minimum: 1,
          },
          text: {
            type: "string",
            description: "Text to enter into the target element.",
          },
          clear: {
            type: "boolean",
            description: "Clear the target element before typing.",
          },
          submit: {
            type: "boolean",
            description: "Submit after typing, typically by pressing Enter.",
          },
          wait_for: browserWaitForParameters(
            "Optional inline stabilization wait. Use this when typing triggers autosuggests, submit flows, downloads, or other page updates.",
          ),
          wait_timeout_ms: {
            type: "integer",
            description: "Maximum inline stabilization wait time in milliseconds.",
            minimum: 100,
            maximum: 30000,
          },
          post_state: literalStringUnion(
            ["none", "page", "state"],
            "Post-type follow-up to return. Leave `none` for the cheapest path when no follow-up read is needed.",
          ),
        },
        required: ["index", "text"],
        additionalProperties: false,
      };
    case "browser_press":
      return {
        type: "object",
        properties: {
          key: {
            type: "string",
            description: "Keyboard key to press.",
            minLength: 1,
          },
        },
        required: ["key"],
        additionalProperties: false,
      };
    case "browser_scroll":
      return {
        type: "object",
        properties: {
          direction: literalStringUnion(["up", "down"], "Scroll direction when delta_y is not provided."),
          amount: {
            type: "integer",
            description: "Positive scroll amount.",
            minimum: 1,
          },
          delta_y: {
            type: "integer",
            description: "Raw vertical scroll delta.",
          },
        },
        additionalProperties: false,
      };
    case "browser_screenshot":
      return {
        type: "object",
        properties: {
          format: literalStringUnion(["png", "jpeg"], "Screenshot image format."),
          quality: {
            type: "integer",
            description: "JPEG quality from 0-100.",
            minimum: 0,
            maximum: 100,
          },
          full_page: {
            type: "boolean",
            description:
              "Capture the entire scrollable page rather than just the visible viewport. Use this when verifying a dashboard or any layout taller than the viewport — the default viewport-only screenshot hides everything below the fold.",
          },
        },
        additionalProperties: false,
      };
    case "browser_back":
    case "browser_forward":
    case "browser_reload":
    case "browser_list_tabs":
    case "browser_list_downloads":
      return {
        type: "object",
        properties: {},
        additionalProperties: false,
      };
    case "browser_get_console":
      return {
        type: "object",
        properties: {
          limit: {
            type: "integer",
            description: "Maximum number of recent console entries to return.",
            minimum: 1,
            maximum: 100,
          },
          level: literalStringUnion(
            ["debug", "info", "warning", "error"],
            "Optional minimum console level to include.",
          ),
        },
        additionalProperties: false,
      };
    case "browser_get_errors":
      return {
        type: "object",
        properties: {
          limit: {
            type: "integer",
            description: "Maximum number of recent browser failures to return.",
            minimum: 1,
            maximum: 100,
          },
          source: literalStringUnion(
            ["page", "runtime", "network"],
            "Restrict results to one browser failure source.",
          ),
        },
        additionalProperties: false,
      };
    case "browser_list_requests":
      return {
        type: "object",
        properties: {
          limit: {
            type: "integer",
            description: "Maximum number of recent requests to return.",
            minimum: 1,
            maximum: 100,
          },
          resource_type: {
            type: "string",
            description:
              "Optional resource type filter such as mainFrame, subFrame, script, image, xhr, fetch, media, font, or other.",
            minLength: 1,
          },
          failures_only: {
            type: "boolean",
            description:
              "When true, include only failed network requests or HTTP error responses.",
          },
        },
        additionalProperties: false,
      };
    case "browser_get_request":
      return {
        type: "object",
        properties: {
          request_id: {
            type: "string",
            description: "Request id returned by browser_list_requests.",
            minLength: 1,
          },
        },
        required: ["request_id"],
        additionalProperties: false,
      };
    case "browser_storage_get":
      return {
        type: "object",
        properties: {
          storage: literalStringUnion(
            ["local", "session"],
            "Browser storage namespace to read. Defaults to `local`.",
          ),
          key: {
            type: "string",
            description: "Single storage key to read.",
            minLength: 1,
          },
          keys: {
            type: "array",
            description: "Explicit storage keys to read.",
            items: { type: "string", minLength: 1 },
            minItems: 1,
            maxItems: 50,
          },
          prefix: {
            type: "string",
            description: "Only return storage entries whose keys start with this prefix.",
            minLength: 1,
          },
          max_entries: {
            type: "integer",
            description: "Maximum number of storage entries to return.",
            minimum: 1,
            maximum: 100,
          },
        },
        additionalProperties: false,
      };
    case "browser_storage_set":
      return {
        type: "object",
        properties: {
          storage: literalStringUnion(
            ["local", "session"],
            "Browser storage namespace to mutate. Defaults to `local`.",
          ),
          key: {
            type: "string",
            description: "Storage key to write or delete.",
            minLength: 1,
          },
          value: {
            type: "string",
            description: "String value to store when delete is false.",
          },
          delete: {
            type: "boolean",
            description: "Remove the key instead of setting it.",
          },
        },
        required: ["key"],
        additionalProperties: false,
      };
    case "browser_cookies_get":
      return {
        type: "object",
        properties: {
          url: {
            type: "string",
            description:
              "URL whose cookie jar should be read. Defaults to the active browser page URL when omitted.",
            minLength: 1,
          },
          name: {
            type: "string",
            description: "Single cookie name to read.",
            minLength: 1,
          },
          names: {
            type: "array",
            description: "Explicit cookie names to include.",
            items: { type: "string", minLength: 1 },
            minItems: 1,
            maxItems: 50,
          },
          domain: {
            type: "string",
            description: "Restrict results to a specific cookie domain.",
            minLength: 1,
          },
          max_results: {
            type: "integer",
            description: "Maximum cookies to return.",
            minimum: 1,
            maximum: 100,
          },
        },
        additionalProperties: false,
      };
    case "browser_cookies_set":
      return {
        type: "object",
        properties: {
          url: {
            type: "string",
            description:
              "URL to associate with the cookie. Defaults to the active browser page URL when omitted.",
            minLength: 1,
          },
          name: {
            type: "string",
            description: "Cookie name.",
            minLength: 1,
          },
          value: {
            type: "string",
            description: "Cookie value.",
          },
          domain: {
            type: "string",
            description: "Optional cookie domain.",
            minLength: 1,
          },
          path: {
            type: "string",
            description: "Optional cookie path. Defaults to `/`.",
            minLength: 1,
          },
          secure: {
            type: "boolean",
            description: "Mark the cookie as secure.",
          },
          http_only: {
            type: "boolean",
            description: "Mark the cookie as HTTP-only.",
          },
          same_site: literalStringUnion(
            ["unspecified", "no_restriction", "lax", "strict"],
            "Cookie SameSite policy.",
          ),
          expiration_date: {
            type: "number",
            description: "Cookie expiration date in seconds since the Unix epoch.",
          },
        },
        required: ["name", "value"],
        additionalProperties: false,
      };
  }
}

export function createHarnessDesktopBrowserToolDefinition(
  definition: DesktopBrowserToolDefinition,
  options: HarnessDesktopBrowserToolOptions,
  selection?: BrowserProfileSelection,
): HarnessDesktopBrowserToolDefinitionLike {
  return {
    name: definition.id,
    label: browserToolLabel(definition.id),
    description: definition.description,
    promptSnippet: `${definition.id}: ${definition.description}`,
    parameters: browserToolParameters(definition.id),
    execute: async (_toolCallId, toolParams, signal) => {
      let params = (toolParams ?? {}) as Record<string, unknown>;
      // Entry tools resolve which browser to drive, make it this session's active
      // browser, and strip the selector from the request body. A named profile
      // wins; with none named we keep the already-selected profile, else auto-pick
      // the pinned default, else a currently-open browser (never arbitrary).
      if (selection && BROWSER_PROFILE_ENTRY_TOOLS.has(definition.id)) {
        const raw = readProfileSelector(params);
        if (raw || !selection.current) {
          const { match, available } = await resolveProfileFromSelector(
            raw ?? "",
            options,
            signal,
          );
          if (!match) {
            return browserToolTextResult(
              raw
                ? `No browser profile matches "${raw}". Say which browser to use — available: ${available}.`
                : `No browser profiles exist yet — ask the user to create one on the Browsers page.`,
            );
          }
          selection.current = match.id;
        }
        params = stripProfileSelector(params);
      }
      // Non-entry tools keep operating on the session's active browser (set by
      // the entry tool's browser_profile), falling back to the initial option.
      return await executeBrowserCapabilityTool({
        toolId: definition.id,
        toolParams: params,
        runtimeApiBaseUrl: options.runtimeApiBaseUrl,
        workspaceId: options.workspaceId,
        sessionId: options.sessionId,
        inputId: options.inputId,
        space: options.space,
        browserProfileId: selection
          ? selection.current
          : (options.browserProfileId ?? null),
        fetchImpl: options.fetchImpl,
        signal,
      });
    },
  };
}

export function createHarnessDesktopBrowserToolDefinitions(
  options: HarnessDesktopBrowserToolOptions,
): HarnessDesktopBrowserToolDefinitionLike[] {
  // One mutable selection shared by every browser tool in this session, so
  // browser_use_profile re-targets all subsequent browser_* calls.
  const selection: BrowserProfileSelection = {
    current: normalizeSelectedBrowserProfileId(options.browserProfileId),
  };
  const tools = DESKTOP_BROWSER_TOOL_DEFINITIONS.map((definition) =>
    createHarnessDesktopBrowserToolDefinition(definition, options, selection),
  );
  tools.push(
    createBrowserLaunchProfileToolDefinition(selection, options),
    createBrowserCloseProfileToolDefinition(options),
    createBrowserUseProfileToolDefinition(selection, options),
    createBrowserListProfilesToolDefinition(options),
  );
  return tools;
}

function createBrowserUseProfileToolDefinition(
  selection: BrowserProfileSelection,
  options: HarnessDesktopBrowserToolOptions,
): HarnessDesktopBrowserToolDefinitionLike {
  return {
    name: "browser_use_profile",
    label: "Browser Use Profile",
    description:
      'Select which of the user\'s built-in Browser Profiles subsequent browser_* tools drive. `profile` accepts the profile number shown by browser_list_profiles (e.g. "1" or "#1"), the profile name, or the profile id — so a request like "use profile #1" works. This is the user\'s browser-profile system: ALWAYS use these built-in browser_* profile tools for the user\'s browser profiles, NEVER a third-party browser-automation tool (e.g. AdsPower). The choice persists for this session until changed.',
    promptSnippet:
      "browser_use_profile: choose which built-in Browser Profile the browser tools drive (by number, name, or id).",
    parameters: {
      type: "object",
      properties: {
        profile: {
          type: "string",
          description:
            'Which profile to drive: its number from browser_list_profiles (e.g. "1" or "#1"), its name, or its profile id.',
          minLength: 1,
        },
      },
      required: ["profile"],
      additionalProperties: false,
    },
    execute: async (_toolCallId, toolParams, signal) => {
      const raw = readProfileSelector((toolParams ?? {}) as Record<string, unknown>);
      if (!raw) {
        return {
          content: [
            {
              type: "text",
              text: "Specify which profile to use — a number (e.g. 1), a name, or a profile id.",
            },
          ],
        };
      }
      const { match, available } = await resolveProfileFromSelector(
        raw,
        options,
        signal,
      );
      if (!match) {
        return {
          content: [
            {
              type: "text",
              text: `No browser profile matches "${raw}". Available: ${available}.`,
            },
          ],
        };
      }
      selection.current = match.id;
      return {
        content: [
          {
            type: "text",
            text: `Now driving browser profile #${match.index} ${match.name} (${match.id}).`,
          },
        ],
      };
    },
  };
}

function createBrowserLaunchProfileToolDefinition(
  selection: BrowserProfileSelection,
  options: HarnessDesktopBrowserToolOptions,
): HarnessDesktopBrowserToolDefinitionLike {
  return {
    name: "browser_launch_profile",
    label: "Browser Launch Profile",
    description:
      'Open one of the user\'s built-in Browser Profiles in its own window — a real Chrome for that profile. `profile` accepts the profile number from browser_list_profiles (e.g. "1" or "#1"), its name, or its id. This is the user\'s native browser-profile system: for requests like "launch/open browser profile N" ALWAYS use this, and NEVER a third-party browser-automation tool (e.g. AdsPower). Also selects that profile as the active target for subsequent browser_* tools.',
    promptSnippet:
      "browser_launch_profile: open one of the app's Browser Profiles in its own window.",
    parameters: {
      type: "object",
      properties: {
        profile: {
          type: "string",
          description:
            'Which profile to launch: its number from browser_list_profiles (e.g. "1" or "#1"), its name, or its id.',
          minLength: 1,
        },
      },
      required: ["profile"],
      additionalProperties: false,
    },
    execute: async (_toolCallId, toolParams, signal) => {
      const raw = readProfileSelector((toolParams ?? {}) as Record<string, unknown>);
      if (!raw) {
        return {
          content: [
            {
              type: "text",
              text: "Specify which profile to launch — a number (e.g. 1), a name, or a profile id.",
            },
          ],
        };
      }
      const { match, available } = await resolveProfileFromSelector(
        raw,
        options,
        signal,
      );
      if (!match) {
        return {
          content: [
            {
              type: "text",
              text: `No browser profile matches "${raw}". Available: ${available}.`,
            },
          ],
        };
      }
      const result = await launchBrowserCapabilityProfile({
        runtimeApiBaseUrl: options.runtimeApiBaseUrl,
        workspaceId: options.workspaceId,
        sessionId: options.sessionId,
        inputId: options.inputId,
        space: options.space,
        browserProfileId: match.id,
        fetchImpl: options.fetchImpl,
        signal,
      });
      if (!result.ok) {
        return {
          content: [
            {
              type: "text",
              text: `Couldn't launch browser profile #${match.index} ${match.name}: ${result.error ?? "unknown error"}`,
            },
          ],
        };
      }
      selection.current = match.id;
      return {
        content: [
          {
            type: "text",
            text: `Launched browser profile #${match.index} ${match.name} in its own window. It is now the active profile for browser tools.`,
          },
        ],
      };
    },
  };
}

function createBrowserCloseProfileToolDefinition(
  options: HarnessDesktopBrowserToolOptions,
): HarnessDesktopBrowserToolDefinitionLike {
  return {
    name: "browser_close_profile",
    label: "Browser Close Profile",
    description:
      'Close a running built-in Browser Profile window (the user\'s native browser). `profile` accepts the profile number from browser_list_profiles (e.g. "1" or "#1"), its name, or its id. Use this for the user\'s browser profiles, never a third-party browser-automation tool (e.g. AdsPower).',
    promptSnippet:
      "browser_close_profile: close a running Browser Profile window.",
    parameters: {
      type: "object",
      properties: {
        profile: {
          type: "string",
          description:
            'Which profile to close: its number from browser_list_profiles (e.g. "1" or "#1"), its name, or its id.',
          minLength: 1,
        },
      },
      required: ["profile"],
      additionalProperties: false,
    },
    execute: async (_toolCallId, toolParams, signal) => {
      const raw = readProfileSelector((toolParams ?? {}) as Record<string, unknown>);
      if (!raw) {
        return {
          content: [
            {
              type: "text",
              text: "Specify which profile to close — a number (e.g. 1), a name, or a profile id.",
            },
          ],
        };
      }
      const { match, available } = await resolveProfileFromSelector(
        raw,
        options,
        signal,
      );
      if (!match) {
        return {
          content: [
            {
              type: "text",
              text: `No browser profile matches "${raw}". Available: ${available}.`,
            },
          ],
        };
      }
      const result = await closeBrowserCapabilityProfile({
        runtimeApiBaseUrl: options.runtimeApiBaseUrl,
        workspaceId: options.workspaceId,
        sessionId: options.sessionId,
        inputId: options.inputId,
        space: options.space,
        browserProfileId: match.id,
        fetchImpl: options.fetchImpl,
        signal,
      });
      if (!result.ok) {
        return {
          content: [
            {
              type: "text",
              text: `Couldn't close browser profile #${match.index} ${match.name}: ${result.error ?? "unknown error"}`,
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `Closed browser profile #${match.index} ${match.name}.`,
          },
        ],
      };
    },
  };
}

function createBrowserListProfilesToolDefinition(
  options: HarnessDesktopBrowserToolOptions,
): HarnessDesktopBrowserToolDefinitionLike {
  return {
    name: "browser_list_profiles",
    label: "Browser List Profiles",
    description:
      "List the user's built-in Browser Profiles — the persistent browser identities managed in this app — each with a number (#1, #2, …), name, and id; the numbers match the desktop Browser Profiles page. The entry marked \"— default\" is the user's pinned default browser, and \"— running\" marks a profile that is currently open. This IS the user's browser-profile system: for ANY request about \"my/the browser profiles\" ALWAYS use these built-in browser_* profile tools and NEVER a third-party browser-automation tool (e.g. AdsPower). The user may refer to a profile by its number; pass that number (or a name/id) to browser_use_profile / browser_launch_profile / browser_close_profile. CHOOSING A PROFILE: when the user does NOT name a browser, prefer the user's pinned default (\"— default\") profile, else a currently-open (\"— running\") profile, else the only profile — omit browser_profile / skip browser_use_profile to let the tools auto-pick in that order. EXCEPTION: when the user has MORE THAN ONE profile and the task depends on which logged-in identity is used (their email/calendar, an account's private data, posting/acting as someone), pick the profile whose NAME best fits the task with browser_use_profile, or ASK the user which to use rather than auto-picking. For identity-agnostic browsing (public pages, search, docs), the auto-pick is fine.",
    promptSnippet:
      "browser_list_profiles: list the user's built-in Browser Profiles (not a third-party tool).",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async (_toolCallId, _toolParams, signal) => {
      const profiles = await listBrowserCapabilityProfiles({
        runtimeApiBaseUrl: options.runtimeApiBaseUrl,
        workspaceId: options.workspaceId,
        sessionId: options.sessionId,
        inputId: options.inputId,
        space: options.space,
        fetchImpl: options.fetchImpl,
        signal,
      });
      const text = profiles.length
        ? profiles
            .map(
              (profile) =>
                `#${profile.index} ${profile.name}${profile.isDefault ? " — default" : ""}${profile.running ? " — running" : ""} (${profile.id})`,
            )
            .join("\n")
        : "No browser profiles found.";
      return { content: [{ type: "text", text }] };
    },
  };
}

export async function resolveHarnessDesktopBrowserToolDefinitions(
  options: {
    runtimeApiBaseUrl?: string | null;
    workspaceId?: string | null;
    sessionId?: string | null;
    inputId?: string | null;
    space?: "agent" | null;
    browserProfileId?: string | null;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<HarnessDesktopBrowserToolDefinitionLike[]> {
  const runtimeApiBaseUrl = resolveBrowserCapabilityBaseUrl(
    options.runtimeApiBaseUrl ?? process.env.SANDBOX_RUNTIME_API_URL,
  );
  if (!runtimeApiBaseUrl) {
    return [];
  }

  const available = await browserCapabilityAvailable({
    runtimeApiBaseUrl,
    workspaceId: options.workspaceId,
    sessionId: options.sessionId,
    inputId: options.inputId,
    space: options.space,
    fetchImpl: options.fetchImpl,
  });
  if (!available) {
    return [];
  }

  return createHarnessDesktopBrowserToolDefinitions({
    runtimeApiBaseUrl,
    workspaceId: options.workspaceId,
    sessionId: options.sessionId,
    inputId: options.inputId,
    space: options.space,
    browserProfileId: options.browserProfileId,
    fetchImpl: options.fetchImpl,
  });
}
