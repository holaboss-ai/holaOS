# Composer inline skill mentions (Tiptap)

**Date:** 2026-06-28
**Repo:** holaOS (`apps/desktop`)
**Status:** Approved design — ready for implementation plan

## Problem

The chat composer references skills as `EntityChip` pills in a row **above** the
`<textarea>`. The desired look is an **inline chip** — an icon + the skill name
rendered on the same line, before the typed text, inside the input:

```
▣ Plugin Creator Help me create a plugin│
```

A plain `<textarea>` can only render uniform plain text, so inline styled chips
are impossible without changing the input substrate. We will replace the
composer textarea with a lean Tiptap editor that supports an inline, atomic
skill-mention node.

## Scope

- **In:** skill references become inline chips inside the input, inserted via a
  `/` typeahead menu or the existing wand button.
- **Out (unchanged this round):**
  - Integrations (`@slug`) stay as above-the-input chips.
  - The send/wire format is unchanged — skills are still collected and prepended
    as `/skillId` lines by the existing `serializeQuotedPrompt`. Chip position in
    the text is **visual only**; skills remain whole-message modifiers.
  - Sent-message rendering (UserTurn) is unchanged.

## Approach (chosen: A)

A dedicated, **lean** Tiptap editor component isolates all editor complexity and
keeps ChatPane's existing `{ input, quotedSkillIds }` contract, so the send,
serialization, and queued-input logic stay largely untouched.

Rejected:
- **B** — editor as sole state source (rip `input`/`quotedSkillIds`/caret out of
  ChatPane): cleaner long-term but high blast radius.
- **C** — reuse `@holaboss/editor` document editor: too heavy/opinionated
  (starter-kit, tables, collaboration) for a chat input.

## Architecture & files

New `apps/desktop/src/components/panes/ChatPane/Composer/editor/`:

- **`SkillMention.ts`** — custom Tiptap inline **atom** node `skillMention`,
  attrs `{ skillId: string, title: string }`. NodeView renders the mockup chip
  (box icon + blue label) via the existing `EntityChip` plus a box icon from
  `@/components/ui/icons`. Non-editable, `selectable`, deletable. No inline X
  (delete via Backspace / select-then-delete). Plain-text serialization of the
  node is `/skillId` (so copy-out stays meaningful).
- **`skillSuggestion.ts`** — `@tiptap/suggestion` config: trigger char `/` at
  line start or after whitespace; items from the existing
  `filteredSkillCommands` data; renders a typeahead popover reusing the current
  skill-picker list styling; `command` inserts a `skillMention` node and removes
  the typed `/query`.
- **`ComposerEditor.tsx`** — wraps `useEditor` with the minimal extension set:
  Document, Paragraph, Text, History, HardBreak, Placeholder, `SkillMention`,
  and the `/` Suggestion. Exposes an imperative handle and an
  `onChange({ text, skillIds })` callback.

Changed:

- **`Composer/index.tsx`** — replace the `<textarea>` block with
  `<ComposerEditor>`. Keep the toolbar, wand popover, attachment dropdown, and
  the above-input **integrations** chip row. Remove the **skills** portion of the
  above-input chip row (skills are now inline).
- **`ChatPane/index.tsx`** — replace `textareaRef`/caret usage with the editor
  handle; route the wand selection and `addQuotedSkill` through
  `handle.insertSkill`; derive `input` and `quotedSkillIds` from the editor's
  `onChange`.
- **`apps/desktop/package.json`** — add lean Tiptap deps already present in the
  monorepo lockfile via `@holaboss/editor`: `@tiptap/react`, `@tiptap/core`,
  `@tiptap/pm`, `@tiptap/suggestion`, `@tiptap/extension-placeholder`.

## Data model & conversion

- **Source of truth:** the editor doc (a single paragraph containing text and
  inline `skillMention` atoms).
- **Derive on every update:**
  - `text` = document text content, with mention nodes contributing the empty
    string (the body stays clean).
  - `skillIds` = the `skillId` of each `skillMention` node in document order,
    de-duplicated.
- **Parent mapping:** `text → input` state, `skillIds → quotedSkillIds` state.
  The send path (`serializeQuotedPrompt`) is unchanged, so the wire format is
  identical.
- **Restore** (queued-input edit / draft): `handle.setContent({ text, skillIds })`
  rebuilds the doc (skill chips first, then the body text), caret placed at end.

## Imperative handle (replaces textareaRef)

`ComposerEditorHandle`:
- `focus()`
- `isEmpty()`
- `getValue(): { text: string; skillIds: string[] }`
- `setContent(value: { text: string; skillIds: string[] }): void`
- `insertSkill(skillId: string, title: string): void` — insert at caret (or end);
  inserting an already-present skill is a no-op (preserves current toggle semantics
  — re-selecting in the wand removes it instead).
- `removeSkill(skillId: string): void`
- `clear(): void`

## `/` menu & wand

- **`/` typeahead:** opens at line start or after whitespace; reuses
  `filteredSkillCommands` filtering and the current picker list UI; ↑/↓ navigate,
  Enter selects, Esc closes. Selecting inserts the chip at the caret and consumes
  the `/query`.
- **Wand button:** keeps the existing popover; selecting calls
  `handle.insertSkill`; re-selecting an already-quoted skill removes its node(s),
  matching today's toggle behavior. Hidden when `showAccessoryControls === false`.

## Preserved behaviors (migration risk checklist)

- Enter to send / Shift+Enter newline / Esc.
- IME composition.
- Paste: images/files route to the existing attachment logic; plain text inserts
  as text.
- Autosize between `min-h` and `max-h` with overflow scroll.
- `disabled` + placeholder; `disabledReason`.
- `showAccessoryControls === false` hides the wand.
- Queued-input restore: content restored; **exact caret index is not** (see
  tradeoffs).
- Sent-message display unchanged (still via `serializeQuotedPrompt` + UserTurn's
  `EntityChip`).

## Accepted tradeoffs / degradations

- **Exact caret restore** for queued-input editing is dropped — Tiptap positions
  don't map cleanly to the old character index. Degraded to: content restored,
  caret at end. (User accepted.)
- Copying an inline chip to plain text yields `/skillId`.

## Testing

- **Unit:**
  - doc → `{ text, skillIds }` derivation: order preserved, de-duped, empty body
    when only chips present.
  - `skillMention` insert / delete (Backspace removes a chip).
  - `/` suggestion filtering matches `filteredSkillCommands`.
  - Round-trip parity: editor output fed to `serializeQuotedPrompt` produces the
    same wire string as today for equivalent input.
- **Real-run (desktop, rebuild + restart):**
  - Type `/`, pick a skill → inline blue chip appears; type text; send → agent
    receives the identical wire format.
  - Backspace deletes a chip.
  - Wand insertion works and toggles off.
  - Queued-input edit restores content.

## Out of scope / follow-ups

- Integrations inline (could unify `@` chips later).
- Exact caret restore (would need a position-mapping layer).
