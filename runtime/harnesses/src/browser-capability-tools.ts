import {
  browserCapabilityAvailable,
  executeBrowserCapabilityTool,
  resolveBrowserCapabilityBaseUrl,
} from "./browser-capability-client.js";
import {
  DESKTOP_BROWSER_TOOL_DEFINITIONS,
  type DesktopBrowserToolDefinition,
  type DesktopBrowserToolId,
} from "./desktop-browser-tools.js";

export interface HarnessDesktopBrowserToolOptions {
  runtimeApiBaseUrl: string;
  workspaceId?: string | null;
  sessionId?: string | null;
  inputId?: string | null;
  space?: "agent" | "user" | null;
  fetchImpl?: typeof fetch;
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
          url: {
            type: "string",
            description: "The URL to open in the in-app browser.",
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
          url: {
            type: "string",
            description: "The URL to open in a new in-app browser tab.",
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
): HarnessDesktopBrowserToolDefinitionLike {
  return {
    name: definition.id,
    label: browserToolLabel(definition.id),
    description: definition.description,
    promptSnippet: `${definition.id}: ${definition.description}`,
    parameters: browserToolParameters(definition.id),
    execute: async (_toolCallId, toolParams, signal) =>
      await executeBrowserCapabilityTool({
        toolId: definition.id,
        toolParams,
        runtimeApiBaseUrl: options.runtimeApiBaseUrl,
        workspaceId: options.workspaceId,
        sessionId: options.sessionId,
        inputId: options.inputId,
        space: options.space,
        fetchImpl: options.fetchImpl,
        signal,
      }),
  };
}

export function createHarnessDesktopBrowserToolDefinitions(
  options: HarnessDesktopBrowserToolOptions,
): HarnessDesktopBrowserToolDefinitionLike[] {
  return DESKTOP_BROWSER_TOOL_DEFINITIONS.map((definition) =>
    createHarnessDesktopBrowserToolDefinition(definition, options),
  );
}

export async function resolveHarnessDesktopBrowserToolDefinitions(
  options: {
    runtimeApiBaseUrl?: string | null;
    workspaceId?: string | null;
    sessionId?: string | null;
    inputId?: string | null;
    space?: "agent" | "user" | null;
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
    space: options.space,
    fetchImpl: options.fetchImpl,
  });
}
