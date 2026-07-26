import { useRef, useState, type RefObject } from "react";
import type { Editor } from "@tiptap/core";
import type { Node } from "@tiptap/pm/model";

import { IconGrip, IconPlus } from "../icons";
import { BlockMenu } from "./BlockMenu";

interface DragHandleColumnProps {
  editor: Editor;
  /** Read-only ref to the active block. The parent updates this on every
   * DragHandle node change WITHOUT triggering a React re-render — the
   * latest value is read at click time when we actually need it. This
   * keeps the parent (MarkdownEditor) stable while the mouse moves over
   * text, which prevents the bubble menu's deps-effect from re-firing
   * (and the bubble from flickering). */
  nodeRef: RefObject<{ node: Node | null; pos: number }>;
}

// Notion-style left-margin handle column. Three affordances:
//   - "+" inserts a new empty paragraph after the current block
//   - "::" with quick click → opens block menu (Turn into / Duplicate / Delete)
//   - "::" with mousedown + drag → reorders block (Tiptap plugin handles)
//
// Click vs drag is distinguished by mouse movement: if the user moves the
// pointer beyond a small threshold between mousedown and mouseup, treat as
// drag (do nothing — Tiptap owns it). Otherwise treat as click and open
// the menu.
export function DragHandleColumn({ editor, nodeRef }: DragHandleColumnProps) {
  const [hovered, setHovered] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const gripRef = useRef<HTMLButtonElement | null>(null);
  const downRef = useRef<{ x: number; y: number } | null>(null);

  const onAddClick = () => {
    const { node, pos } = nodeRef.current;
    if (!node) return;
    const insertAt = pos + node.nodeSize;
    editor
      .chain()
      .focus(undefined, { scrollIntoView: false })
      .insertContentAt(insertAt, { type: "paragraph" })
      .setTextSelection(insertAt + 1)
      .run();
  };

  const onGripMouseDown = (e: React.MouseEvent) => {
    // Record mousedown location. We don't preventDefault here because
    // Tiptap's drag-handle plugin needs the native mousedown to start drag.
    downRef.current = { x: e.clientX, y: e.clientY };
  };

  const onGripMouseUp = (e: React.MouseEvent) => {
    const start = downRef.current;
    downRef.current = null;
    if (!start) return;
    const dx = Math.abs(e.clientX - start.x);
    const dy = Math.abs(e.clientY - start.y);
    // 4px threshold — beyond this is a drag, ProseMirror handled it.
    if (dx > 4 || dy > 4) return;
    setMenuOpen((v) => !v);
  };

  return (
    <>
      <div
        className="hb-drag-col"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        data-hovered={hovered || menuOpen || undefined}
      >
        <button
          type="button"
          className="hb-drag-col__btn"
          onMouseDown={(e) => e.preventDefault()}
          onClick={onAddClick}
          aria-label="Add block below"
          title="Add block below"
        >
          <IconPlus className="hb-drag-col__icon" />
        </button>
        <button
          ref={gripRef}
          type="button"
          className="hb-drag-col__btn hb-drag-col__btn--grip"
          onMouseDown={onGripMouseDown}
          onMouseUp={onGripMouseUp}
          aria-label="Open block menu, drag to reorder"
          title="Click for menu • drag to move"
        >
          <IconGrip className="hb-drag-col__icon" />
        </button>
      </div>

      {/* Block menu (Turn into / Duplicate / Delete) reads the latest
          node + pos at open time, also from the ref. */}
      <BlockMenu
        editor={editor}
        nodeRef={nodeRef}
        anchor={gripRef.current}
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
      />
    </>
  );
}
