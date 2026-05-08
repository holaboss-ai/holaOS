// Markdown serialisation lives inside the live Tiptap editor:
//   - parse:     editor.commands.setContent(markdown)  (with Markdown extension)
//   - serialize: editor.storage.markdown.getMarkdown()
//
// We keep this file as a stub for future standalone helpers (e.g. server-side
// rendering, agent-authored markdown without a live editor instance). When we
// need them we'll instantiate a headless editor and pump markdown through it.
//
// Intentionally not exporting anything yet — keeps the package surface
// honest to what's implemented.

export {};
