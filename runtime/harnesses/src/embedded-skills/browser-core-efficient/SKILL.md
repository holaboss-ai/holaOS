---
name: browser-core-efficient
description: Use when working in the embedded browser and you want the cheapest reliable interaction loop.
---

# Browser Core Efficient

Use this skill when operating the workspace-embedded browser and efficiency matters.

## Goals
- reduce browser tool round trips
- reduce large state snapshots
- reduce unnecessary screenshots and page text reads
- prefer reliable one-call actions over browse-then-browse-again loops

## Default Loop
1. If the target is already known, use `browser_act` directly with locator signals.
2. If the target is semantically known but the page is large, use `browser_find`.
3. Use `browser_get_state` only for orientation or when the target is still unclear.
4. After page-changing actions, use `wait_for` on the action itself when possible.
5. Re-read state only if the action result is ambiguous.

## Tool Selection
- Prefer `browser_act` over index-based tools when text, label, role, selector, or ref can identify the target.
- Prefer `browser_find` before `browser_get_state` when you know what you want but not where it is.
- Use `browser_click` and `browser_type` only when you already have a stable index from a fresh state snapshot.
- Use `browser_select_tab` and `browser_close_tab` instead of spending extra calls re-orienting around tabs.
- Use `browser_wait` for explicit stabilization, especially for URL changes, DOM changes, and download completion.

## State Discipline
- Default to `browser_get_state` with compact detail.
- Do not request page text unless the task is primarily about reading content.
- Do not request screenshots unless DOM-first signals are insufficient.
- When a fact may live in custom-element attributes, `data-*` attributes, `href`s, or hydration data rather than visible text, inspect that targeted page-local DOM source before concluding the fact is unavailable.
- If a page change likely invalidated earlier refs or indexes, treat them as stale and re-locate the target.

## Wait Discipline
- Prefer action-local `wait_for` over a separate follow-up wait call.
- Use `interactive` or `domcontentloaded` after lightweight transitions.
- Use full load completion only when the page truly needs it.
- Use `download_started` and `download_completed` for browser-triggered downloads instead of manual polling through state reads.

## Escalation Rules
- Escalate to `browser_get_state detail=standard` only when compact state is insufficient.
- Escalate to `include_page_text=true` only when the page content itself is the task output.
- Escalate to `browser_evaluate` for narrow read-only extraction when the required fact is likely present in page-local attributes or hydration data but not exposed cleanly through visible text.
- Escalate to screenshots for visual ambiguity, layout validation, canvas/chart/PDF content, or explicit user-visible confirmation.
- Escalate to debug or observability tools only after the cheaper path fails.
