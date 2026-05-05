---
name: browser-qa
description: Use when validating or debugging a workflow in the embedded browser and you need a reproducible, evidence-first loop.
---

# Browser QA

Use this skill when the task is browser validation, repro, regression checking, or investigation in the workspace-embedded browser.

## Goals
- reproduce the issue with the fewest browser calls possible
- separate product failure from wait or locator failure
- capture only the evidence needed to explain the result

## Repro Loop
1. State the exact starting page, tab, and account state you are testing.
2. Use the cheapest path that can reproduce the behavior.
3. After each page-changing step, use explicit waits rather than repeated broad state reads.
4. If a step fails, determine whether it is:
   - wrong target
   - stale target
   - missing wait
   - auth or session state
   - true product behavior
5. Capture evidence only after the failure is stable and reproducible.

## Tool Discipline
- Prefer `browser_act` with `wait_for` over separate click then wait loops.
- Use `browser_find` when the target is known but compact state did not include it.
- Use `browser_get_state detail=compact` for orientation and `detail=standard` only when compact state is insufficient.
- If the page should expose the fact directly, inspect targeted custom-element attributes, `data-*` attributes, `href`s, or hydration data with a narrow read-only `browser_evaluate` before treating the fact as unavailable.
- Use `browser_get_console`, `browser_get_errors`, and `browser_list_requests` only after the cheaper orientation/action path failed or the issue is clearly runtime/network-related.
- Use `browser_get_request` only for one suspect request after `browser_list_requests` narrowed the field.
- Use `browser_storage_get` and `browser_cookies_get` to inspect auth or state flags before rerunning a long login flow.
- Use `browser_storage_set` and `browser_cookies_set` only for controlled state repair, not as a default shortcut.

## Evidence Rules
- Capture screenshots only for visual ambiguity, layout issues, or user-visible confirmation.
- Read page text only when the task depends on the content itself.
- Treat page-local DOM evidence as primary evidence when the target page appears to render the needed fact; use third-party proxies or alternate sites only as fallback evidence.
- When a download is involved, prefer `download_started` and `download_completed` waits plus `browser_list_downloads`.
- Preserve the exact failing condition in the final report: target, wait, URL, and observed result.

## Final Reporting
- Report whether the behavior reproduced.
- Report the smallest reliable repro path.
- Report whether the failure appears to be locator, timing, session state, or product behavior.
- Include only the minimum evidence needed to justify the conclusion.
