import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";

import {
  IconChevronDown,
  IconCopy,
  IconTrash,
} from "../icons";
import { TURN_INTO_OPTIONS } from "./blockTypes";

export interface BlockMenuProps {
  editor: Editor;
  /** Read-only ref to the active block. Resolved at click time so the
   * menu doesn't need to re-render every time the drag handle moves. */
  nodeRef: RefObject<{ node: PMNode | null; pos: number }>;
  /** Anchor element — menu pops below this. Usually the grip button. */
  anchor: HTMLElement | null;
  /** Whether the menu is open. Parent controls. */
  open: boolean;
  /** Called when the menu wants to close. */
  onClose: () => void;
}

// Menu shown when the user clicks the drag handle "grip" on a block.
// Notion-style actions: Turn into → submenu, Duplicate, Delete.
//
// Rendered into document.body via portal so popover overflow / z-index
// behaves cleanly. Position is computed against the anchor element's rect.
export function BlockMenu({
  editor,
  nodeRef,
  anchor,
  open,
  onClose,
}: BlockMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const [turnIntoOpen, setTurnIntoOpen] = useState(false);

  // Position the menu under the anchor.
  useLayoutEffect(() => {
    if (!open || !anchor) return;
    const rect = anchor.getBoundingClientRect();
    setMenuPos({ top: rect.bottom + 6, left: rect.left });
  }, [open, anchor]);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (e: MouseEvent) => {
      const target = e.target;
      if (!(target instanceof Node)) return;
      if (menuRef.current?.contains(target)) return;
      if (anchor?.contains(target)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, anchor, onClose]);

  // Reset submenu state whenever the menu reopens.
  useEffect(() => {
    if (!open) setTurnIntoOpen(false);
  }, [open]);

  if (!open) return null;

  const close = () => {
    onClose();
    setTurnIntoOpen(false);
  };

  const onDuplicate = () => {
    const { node, pos } = nodeRef.current;
    if (!node) return;
    const insertAt = pos + node.nodeSize;
    editor
      .chain()
      .focus(undefined, { scrollIntoView: false })
      .insertContentAt(insertAt, node.toJSON())
      .run();
    close();
  };

  const onDelete = () => {
    const { node, pos } = nodeRef.current;
    if (!node) return;
    editor
      .chain()
      .focus(undefined, { scrollIntoView: false })
      .deleteRange({ from: pos, to: pos + node.nodeSize })
      .run();
    close();
  };

  return createPortal(
    <div
      ref={menuRef}
      className="hb-block-menu"
      style={{ top: menuPos.top, left: menuPos.left }}
      role="menu"
    >
      {/* Turn-into row with submenu */}
      <div className="hb-block-menu__turn">
        <button
          type="button"
          className="hb-block-menu__item"
          onMouseEnter={() => setTurnIntoOpen(true)}
          onClick={() => setTurnIntoOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={turnIntoOpen}
        >
          <span className="hb-block-menu__item-label">Turn into</span>
          <IconChevronDown className="hb-block-menu__chevron" />
        </button>
        {turnIntoOpen ? (
          <div role="menu" className="hb-block-menu__submenu">
            {TURN_INTO_OPTIONS.map((opt) => {
              const Icon = opt.icon;
              const active = opt.isActive(editor);
              return (
                <button
                  key={opt.id}
                  type="button"
                  role="menuitem"
                  data-active={active || undefined}
                  className="hb-block-menu__subitem"
                  onClick={() => {
                    // Anchor the change to the block the drag handle was
                    // pointing at — not whatever the editor's current
                    // selection happens to be (which may be elsewhere).
                    const { node, pos } = nodeRef.current;
                    if (!node) return;
                    editor.commands.setTextSelection(pos + 1);
                    opt.apply(editor);
                    close();
                  }}
                >
                  <Icon className="hb-block-menu__subicon" />
                  <span>{opt.label}</span>
                </button>
              );
            })}
          </div>
        ) : null}
      </div>

      <div className="hb-block-menu__divider" role="separator" />

      <button
        type="button"
        className="hb-block-menu__item"
        onMouseEnter={() => setTurnIntoOpen(false)}
        onClick={onDuplicate}
      >
        <IconCopy className="hb-block-menu__item-icon" aria-hidden />
        <span className="hb-block-menu__item-label">Duplicate</span>
        <span className="hb-block-menu__shortcut">⌘D</span>
      </button>

      <button
        type="button"
        className="hb-block-menu__item hb-block-menu__item--danger"
        onMouseEnter={() => setTurnIntoOpen(false)}
        onClick={onDelete}
      >
        <IconTrash className="hb-block-menu__item-icon" aria-hidden />
        <span className="hb-block-menu__item-label">Delete</span>
        <span className="hb-block-menu__shortcut">Del</span>
      </button>
    </div>,
    document.body,
  );
}
