# @holaboss/editor

Tiptap-based block editor for holaOS.

**v0 status**: Markdown editor only. Plugged into desktop's `.md` / `.mdx` /
`.markdown` file editing surface as the replacement for the previous plain
`<textarea>`. Future versions add Notion-style blocks (slash menu, drag handle,
embedded databases) per the design doc:

- `holaOS/docs/plans/2026-05-06-pages-and-databases-design.md`

## Usage

```tsx
import "@holaboss/editor/styles.css";
import { MarkdownEditor } from "@holaboss/editor";

function MyPane({ value, onChange }) {
  return (
    <MarkdownEditor
      value={value}
      onChange={onChange}
      placeholder="Start typing…"
    />
  );
}
```

`value` is the markdown source (string). `onChange` fires after each
transaction with the updated markdown.

## Imperative API

```tsx
const ref = useRef<MarkdownEditorRef>(null);
// ref.current.getMarkdown()
// ref.current.setMarkdown(md)
// ref.current.focus()
// ref.current.editor   // raw Tiptap editor
```

## Stack

- `@tiptap/core` v3 + `@tiptap/react`
- `@tiptap/starter-kit` (paragraph, headings, lists, code, blockquote, hr,
  hard break, history)
- `@tiptap/extension-link`
- `@tiptap/extension-placeholder`
- `tiptap-markdown` for markdown ↔ document round-trip

## Build

```bash
npm install
npm run build       # produces dist/{index.js,index.cjs,index.d.ts,styles.css}
npm run typecheck
```

## Adding a new `@tiptap/*` extension

This package has `legacy-peer-deps=true` (in `.npmrc`) to keep `react` /
`react-dom` out of `node_modules` and prevent duplicate React instances in
Vite consumers. **Side effect**: npm will not auto-install ANY peer
dependencies, including internal `@tiptap/*` peers.

When adding a new `@tiptap/*` package:

1. Run `npm view @tiptap/<new-pkg> peerDependencies` to see its peers.
2. Add every `@tiptap/*` peer to this package's `dependencies` explicitly,
   pinned to the same version range as the rest of the family (`^3.x`).
3. Do NOT add `react` / `react-dom` — those stay out, satisfied by the
   consumer.
4. Re-run `npm install`, then `npm run typecheck` and `npm run build`.

Symptom of a missing internal peer: Vite errors with
`Failed to resolve import "@tiptap/extension-foo"` from the bundled
extension package. The fix is to add the missing peer to dependencies.

## Future scope

- Slash menu (Phase 1)
- Drag handle, block-level menu (Phase 1)
- Custom blocks: callout, toggle, columns (Phase 1)
- `database_inline`, `database_linked`, `kpi`, `chart`, `sql_table` (Phase 2+)
- Yjs collab via `y-prosemirror` (Phase 7)

Do not add new features here without first updating the design doc.
