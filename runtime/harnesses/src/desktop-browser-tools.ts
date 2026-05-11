export const DESKTOP_BROWSER_TOOL_IDS = [
  "browser_navigate",
  "browser_open_tab",
  "browser_select_tab",
  "browser_close_tab",
  "browser_get_state",
  "browser_find",
  "browser_act",
  "browser_wait",
  "browser_evaluate",
  "browser_debug",
  "browser_click",
  "browser_context_click",
  "browser_type",
  "browser_press",
  "browser_scroll",
  "browser_back",
  "browser_forward",
  "browser_reload",
  "browser_screenshot",
  "browser_list_tabs",
  "browser_list_downloads",
  "browser_get_console",
  "browser_get_errors",
  "browser_list_requests",
  "browser_get_request",
  "browser_storage_get",
  "browser_storage_set",
  "browser_cookies_get",
  "browser_cookies_set",
] as const;

export type DesktopBrowserToolId = (typeof DESKTOP_BROWSER_TOOL_IDS)[number];

export interface DesktopBrowserToolDefinition {
  id: DesktopBrowserToolId;
  description: string;
  policy: "inspect" | "mutate";
  session_scope: "all_sessions" | "subagent_only";
  input_schema: Record<string, unknown>;
}

export const DESKTOP_BROWSER_TOOL_DEFINITIONS: DesktopBrowserToolDefinition[] = [
  {
    id: "browser_navigate",
    description:
      "Navigate the desktop browser to a URL for direct inspection or interaction on a specific live site when search results are not enough.",
    policy: "mutate",
    session_scope: "subagent_only",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["url"],
      properties: {
        url: { type: "string", minLength: 1 },
      },
    },
  },
  {
    id: "browser_open_tab",
    description:
      "Open a URL in a new desktop browser tab so you can inspect or compare specific live pages without losing the current page state.",
    policy: "mutate",
    session_scope: "subagent_only",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["url"],
      properties: {
        url: { type: "string", minLength: 1 },
        background: { type: "boolean" },
      },
    },
  },
  {
    id: "browser_select_tab",
    description:
      "Switch the active desktop browser tab using a tab id from browser_list_tabs so subsequent browser tools operate on the intended tab.",
    policy: "mutate",
    session_scope: "subagent_only",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["tab_id"],
      properties: {
        tab_id: { type: "string", minLength: 1 },
      },
    },
  },
  {
    id: "browser_close_tab",
    description:
      "Close a desktop browser tab using a tab id from browser_list_tabs and return the updated tab state.",
    policy: "mutate",
    session_scope: "subagent_only",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["tab_id"],
      properties: {
        tab_id: { type: "string", minLength: 1 },
      },
    },
  },
  {
    id: "browser_get_state",
    description:
      "Read the current desktop browser page, visible interactive elements, visible media such as images, and optional screenshot artifact. Prefer this as the DOM-first browser inspection tool for actions and structured extraction. By default it returns a compact state snapshot; use detail=standard when you need a broader page inventory, use mode/scope/max_nodes to narrow large pages, set include_page_text=true only when you need the current page text, and set include_screenshot=true when visual appearance, layout, prominence, overlays, canvas/chart/PDF content, or user-visible confirmation matters, or when DOM signals are ambiguous or unreliable. Every state snapshot carries a stable revision. Use since_revision with changed_only=true to avoid paying for a full snapshot when nothing changed. Screenshots are returned as artifact handles when workspace storage is available, not inline base64.",
    policy: "inspect",
    session_scope: "subagent_only",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        mode: { type: "string", enum: ["state", "text", "structured", "visual"] },
        detail: { type: "string", enum: ["compact", "standard"] },
        scope: {
          type: "string",
          enum: ["main", "viewport", "focused", "dialog", "active_dialog", "modal"],
        },
        max_nodes: { type: "integer", minimum: 1 },
        since_revision: { type: "string", minLength: 1 },
        changed_only: { type: "boolean" },
        include_page_text: { type: "boolean" },
        include_screenshot: { type: "boolean" },
      },
    },
  },
  {
    id: "browser_find",
    description:
      "Find visible browser elements across the page by text, accessible label, placeholder, role, CSS selector, XPath, or a combination of those signals. Use this when browser_get_state is truncated, when a visible control is missing from the compact snapshot, or before acting on ambiguous page UI. Search is independent of browser_get_state max_nodes and returns stable refs plus bounding boxes for follow-up browser_act calls.",
    policy: "inspect",
    session_scope: "subagent_only",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        text: { type: "string" },
        label: { type: "string" },
        placeholder: { type: "string" },
        role: { type: "string" },
        selector: { type: "string" },
        xpath: { type: "string" },
        exact: { type: "boolean" },
        include_hidden: { type: "boolean" },
        scope: {
          type: "string",
          enum: ["main", "viewport", "focused", "dialog", "active_dialog", "modal"],
        },
        max_results: { type: "integer", minimum: 1, maximum: 100 },
      },
    },
  },
  {
    id: "browser_act",
    description:
      "Perform a general browser action on a ref returned by browser_find, a CSS/XPath selector, or a locator described by text/label/placeholder/role. Supports click, double_click, hover, focus, fill, type, press, select, check, uncheck, and scroll_into_view. Pointer and text actions use real browser input when available so rich editors can update their internal state. Prefer this over brittle index-based clicks when the target may be outside browser_get_state or represented by nested generic DOM nodes. Use wait_for and post_state to stabilize page-changing actions without a separate browser_wait call.",
    policy: "mutate",
    session_scope: "subagent_only",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: {
        action: {
          type: "string",
          enum: ["click", "double_click", "hover", "focus", "fill", "type", "press", "select", "check", "uncheck", "scroll_into_view"],
        },
        ref: { type: "string" },
        text: { type: "string" },
        label: { type: "string" },
        placeholder: { type: "string" },
        role: { type: "string" },
        selector: { type: "string" },
        xpath: { type: "string" },
        exact: { type: "boolean" },
        scope: {
          type: "string",
          enum: ["main", "viewport", "focused", "dialog", "active_dialog", "modal"],
        },
        value: { type: "string" },
        key: { type: "string" },
        clear: { type: "boolean" },
        submit: { type: "boolean" },
        wait_for: {
          anyOf: [
            {
              type: "string",
              enum: [
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
              ],
            },
            {
              type: "object",
              additionalProperties: false,
              properties: {
                condition: {
                  type: "string",
                  enum: [
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
                  ],
                },
                load_state: {
                  type: "string",
                  enum: ["interactive", "domcontentloaded", "complete", "load"],
                },
                expression: { type: "string" },
                url: { type: "string" },
                filename: { type: "string" },
                text: { type: "string" },
                label: { type: "string" },
                placeholder: { type: "string" },
                role: { type: "string" },
                selector: { type: "string" },
                xpath: { type: "string" },
                exact: { type: "boolean" },
                scope: {
                  type: "string",
                  enum: ["main", "viewport", "focused", "dialog", "active_dialog", "modal"],
                },
              },
            },
          ],
        },
        wait_timeout_ms: { type: "integer", minimum: 100, maximum: 30000 },
        post_state: { type: "string", enum: ["none", "page", "state"] },
      },
    },
  },
  {
    id: "browser_wait",
    description:
      "Wait for browser state to settle: page load or load_state, URL match, visible/hidden element, text presence, DOM mutation/change, a JavaScript predicate, or browser download lifecycle changes. Use after navigation, clicks, form submits, menu opens, SPA transitions, and download-triggering actions before inspecting or acting again.",
    policy: "inspect",
    session_scope: "subagent_only",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        condition: {
          type: "string",
          enum: [
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
          ],
        },
        load_state: {
          type: "string",
          enum: ["interactive", "domcontentloaded", "complete", "load"],
        },
        expression: { type: "string" },
        url: { type: "string" },
        filename: { type: "string" },
        text: { type: "string" },
        label: { type: "string" },
        placeholder: { type: "string" },
        role: { type: "string" },
        selector: { type: "string" },
        xpath: { type: "string" },
        exact: { type: "boolean" },
        scope: {
          type: "string",
          enum: ["main", "viewport", "focused", "dialog", "active_dialog", "modal"],
        },
        timeout_ms: { type: "integer", minimum: 100, maximum: 30000 },
      },
    },
  },
  {
    id: "browser_evaluate",
    description:
      "Evaluate JavaScript in the active browser page and return the structured result. Use for general inspection or controlled page automation when built-in browser actions are insufficient. Prefer read-only expressions by default; set allow_mutation=true only when intentionally changing page state.",
    policy: "mutate",
    session_scope: "subagent_only",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["expression"],
      properties: {
        expression: { type: "string", minLength: 1 },
        allow_mutation: { type: "boolean" },
        timeout_ms: { type: "integer", minimum: 100, maximum: 30000 },
      },
    },
  },
  {
    id: "browser_debug",
    description:
      "Return compact browser diagnostics for clickability and page-state problems: current page, ready state, active element, dialogs, iframes, viewport, scroll, and elementFromPoint hit-test data. Use when an element is visible but not found, clicks do nothing, overlays block interaction, or a page appears stuck.",
    policy: "inspect",
    session_scope: "subagent_only",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        x: { type: "number" },
        y: { type: "number" },
        include_dom_sample: { type: "boolean" },
      },
    },
  },
  {
    id: "browser_click",
    description:
      "Click an interactive element from browser_get_state by index to follow links, apply filters, reveal hidden data, paginate, or continue a live browser workflow. Use wait_for and post_state to stabilize page-changing clicks without a separate browser_wait call.",
    policy: "mutate",
    session_scope: "subagent_only",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["index"],
      properties: {
        index: { type: "integer", minimum: 1 },
        wait_for: {
          anyOf: [
            {
              type: "string",
              enum: [
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
              ],
            },
            {
              type: "object",
              additionalProperties: false,
              properties: {
                condition: {
                  type: "string",
                  enum: [
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
                  ],
                },
                load_state: {
                  type: "string",
                  enum: ["interactive", "domcontentloaded", "complete", "load"],
                },
                expression: { type: "string" },
                url: { type: "string" },
                filename: { type: "string" },
                text: { type: "string" },
                label: { type: "string" },
                placeholder: { type: "string" },
                role: { type: "string" },
                selector: { type: "string" },
                xpath: { type: "string" },
                exact: { type: "boolean" },
                scope: {
                  type: "string",
                  enum: ["main", "viewport", "focused", "dialog", "active_dialog", "modal"],
                },
              },
            },
          ],
        },
        wait_timeout_ms: { type: "integer", minimum: 100, maximum: 30000 },
        post_state: { type: "string", enum: ["none", "page", "state"] },
      },
    },
  },
  {
    id: "browser_context_click",
    description:
      "Open the native browser context menu on an interactive element or visible media item from browser_get_state by index. Use target=`media` for images and other visible media content.",
    policy: "mutate",
    session_scope: "subagent_only",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["index"],
      properties: {
        index: { type: "integer", minimum: 1 },
        target: { type: "string", enum: ["element", "media"] },
      },
    },
  },
  {
    id: "browser_type",
    description:
      "Type text into an interactive element from browser_get_state by index to search, filter, fill inputs, or continue a live browser workflow. Use wait_for and post_state when typing triggers page updates or submit flows.",
    policy: "mutate",
    session_scope: "subagent_only",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["index", "text"],
      properties: {
        index: { type: "integer", minimum: 1 },
        text: { type: "string" },
        clear: { type: "boolean" },
        submit: { type: "boolean" },
        wait_for: {
          anyOf: [
            {
              type: "string",
              enum: [
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
              ],
            },
            {
              type: "object",
              additionalProperties: false,
              properties: {
                condition: {
                  type: "string",
                  enum: [
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
                  ],
                },
                load_state: {
                  type: "string",
                  enum: ["interactive", "domcontentloaded", "complete", "load"],
                },
                expression: { type: "string" },
                url: { type: "string" },
                filename: { type: "string" },
                text: { type: "string" },
                label: { type: "string" },
                placeholder: { type: "string" },
                role: { type: "string" },
                selector: { type: "string" },
                xpath: { type: "string" },
                exact: { type: "boolean" },
                scope: {
                  type: "string",
                  enum: ["main", "viewport", "focused", "dialog", "active_dialog", "modal"],
                },
              },
            },
          ],
        },
        wait_timeout_ms: { type: "integer", minimum: 100, maximum: 30000 },
        post_state: { type: "string", enum: ["none", "page", "state"] },
      },
    },
  },
  {
    id: "browser_press",
    description:
      "Send a keyboard key to the currently focused element to submit forms, confirm dialogs, or continue keyboard-driven browser interaction.",
    policy: "mutate",
    session_scope: "subagent_only",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["key"],
      properties: {
        key: { type: "string", minLength: 1 },
      },
    },
  },
  {
    id: "browser_scroll",
    description:
      "Scroll the current page vertically to load, inspect, or reach additional live content that is not yet visible.",
    policy: "mutate",
    session_scope: "subagent_only",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        direction: { type: "string", enum: ["up", "down"] },
        amount: { type: "integer", minimum: 1 },
        delta_y: { type: "integer" },
      },
    },
  },
  {
    id: "browser_back",
    description: "Go back in the active browser tab history while preserving the live browser session state.",
    policy: "mutate",
    session_scope: "subagent_only",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  {
    id: "browser_forward",
    description: "Go forward in the active browser tab history while preserving the live browser session state.",
    policy: "mutate",
    session_scope: "subagent_only",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  {
    id: "browser_reload",
    description: "Reload the active browser tab to refresh live page state before re-checking exact details.",
    policy: "mutate",
    session_scope: "subagent_only",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  {
    id: "browser_screenshot",
    description:
      "Capture a screenshot artifact of the active browser tab when visual verification or interpretation is needed. Do not use it by default for routine navigation or straightforward structured extraction when DOM and text state already suffice. Screenshots are returned as artifact handles when workspace storage is available, not inline base64.",
    policy: "inspect",
    session_scope: "subagent_only",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        format: { type: "string", enum: ["png", "jpeg"] },
        quality: { type: "integer", minimum: 0, maximum: 100 },
      },
    },
  },
  {
    id: "browser_list_tabs",
    description: "List open browser tabs and the active tab id so you can manage multi-tab browser workflows.",
    policy: "inspect",
    session_scope: "subagent_only",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  {
    id: "browser_list_downloads",
    description:
      "List recent browser downloads and their status so you can confirm a download completed before using the file in the workspace.",
    policy: "inspect",
    session_scope: "subagent_only",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  {
    id: "browser_get_console",
    description:
      "Read a compact recent slice of browser console output for the active tab. Use this when a page appears broken, a UI action silently fails, or you need recent warnings/errors without opening a full browser trace.",
    policy: "inspect",
    session_scope: "subagent_only",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 100 },
        level: {
          type: "string",
          enum: ["debug", "info", "warning", "error"],
        },
      },
    },
  },
  {
    id: "browser_get_errors",
    description:
      "Read recent page, runtime, or network failures for the active browser tab. Use this to quickly distinguish product failures from locator or wait issues.",
    policy: "inspect",
    session_scope: "subagent_only",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 100 },
        source: {
          type: "string",
          enum: ["page", "runtime", "network"],
        },
      },
    },
  },
  {
    id: "browser_list_requests",
    description:
      "List a small recent window of browser requests for the active tab, with compact status and timing fields. Use this to identify failed API calls or redirects without capturing a full network trace.",
    policy: "inspect",
    session_scope: "subagent_only",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 100 },
        resource_type: { type: "string", minLength: 1 },
        failures_only: { type: "boolean" },
      },
    },
  },
  {
    id: "browser_get_request",
    description:
      "Read detailed metadata for one recent browser request from browser_list_requests, including headers, status, timing, and body metadata when available.",
    policy: "inspect",
    session_scope: "subagent_only",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["request_id"],
      properties: {
        request_id: { type: "string", minLength: 1 },
      },
    },
  },
  {
    id: "browser_storage_get",
    description:
      "Read localStorage or sessionStorage entries from the active browser page without taking a full DOM snapshot. Use targeted keys or a prefix to keep the result small.",
    policy: "inspect",
    session_scope: "subagent_only",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        storage: { type: "string", enum: ["local", "session"] },
        key: { type: "string", minLength: 1 },
        keys: {
          type: "array",
          items: { type: "string", minLength: 1 },
          minItems: 1,
          maxItems: 50,
        },
        prefix: { type: "string", minLength: 1 },
        max_entries: { type: "integer", minimum: 1, maximum: 100 },
      },
    },
  },
  {
    id: "browser_storage_set",
    description:
      "Set or remove a localStorage or sessionStorage entry in the active browser page without using a broad page evaluation.",
    policy: "mutate",
    session_scope: "subagent_only",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["key"],
      properties: {
        storage: { type: "string", enum: ["local", "session"] },
        key: { type: "string", minLength: 1 },
        value: { type: "string" },
        delete: { type: "boolean" },
      },
    },
  },
  {
    id: "browser_cookies_get",
    description:
      "Read cookies for the current browser session, scoped to the active page URL by default. Prefer targeted names or domains to keep the result compact.",
    policy: "inspect",
    session_scope: "subagent_only",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        url: { type: "string", minLength: 1 },
        name: { type: "string", minLength: 1 },
        names: {
          type: "array",
          items: { type: "string", minLength: 1 },
          minItems: 1,
          maxItems: 50,
        },
        domain: { type: "string", minLength: 1 },
        max_results: { type: "integer", minimum: 1, maximum: 100 },
      },
    },
  },
  {
    id: "browser_cookies_set",
    description:
      "Set a cookie in the current browser session. Use this for lightweight auth or session-state repair when a full browser login loop is unnecessary.",
    policy: "mutate",
    session_scope: "subagent_only",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["name", "value"],
      properties: {
        url: { type: "string", minLength: 1 },
        name: { type: "string", minLength: 1 },
        value: { type: "string" },
        domain: { type: "string", minLength: 1 },
        path: { type: "string", minLength: 1 },
        secure: { type: "boolean" },
        http_only: { type: "boolean" },
        same_site: {
          type: "string",
          enum: ["unspecified", "no_restriction", "lax", "strict"],
        },
        expiration_date: { type: "number" },
      },
    },
  },
];
