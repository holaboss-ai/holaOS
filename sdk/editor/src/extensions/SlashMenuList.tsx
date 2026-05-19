import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Editor, Range } from "@tiptap/core";
import type { ComponentType, SVGProps } from "react";

import {
  IconCodeBlock,
  IconDivider,
  IconHeading1,
  IconHeading2,
  IconHeading3,
  IconList,
  IconListChecks,
  IconListOrdered,
  IconQuote,
  IconTable,
  IconText,
} from "../icons";

type IconComponent = ComponentType<SVGProps<SVGSVGElement>>;

export interface SlashItemCommandCtx {
  editor: Editor;
  range: Range;
  /** Populated when the item has a `picker` and the user committed via it. */
  picker?: { rows: number; cols: number };
}

export type SlashItemPicker = {
  kind: "grid";
  maxRows: number;
  maxCols: number;
  initialRows: number;
  initialCols: number;
};

export interface SlashItem {
  /** Stable id, used as React key. */
  id: string;
  /** Section the item belongs to. Items with the same `section` are grouped. */
  section: string;
  /** Title shown to the user. */
  title: string;
  /** Optional second line. */
  subtitle?: string;
  /** Search-only synonyms (lowercase). */
  keywords?: string[];
  /** Visual icon, drawn at the left of the item. */
  icon: IconComponent;
  /** Optional keyboard shortcut hint shown at the right. */
  shortcut?: string;
  /** Action invoked when this item is selected. */
  command: (ctx: SlashItemCommandCtx) => void;
  /** Optional grid picker shown beside the menu when this item is active. */
  picker?: SlashItemPicker;
}

export interface SlashMenuListProps {
  items: SlashItem[];
  command: (item: SlashItem) => void;
  /** Provided by Tiptap's Suggestion plugin so we can call commands directly. */
  editor: Editor;
  /** The matched range for the slash query — passed through if the command needs it. */
  range: Range;
}

export interface SlashMenuListHandle {
  onKeyDown: (event: KeyboardEvent) => boolean;
}

// Keyboard-driven list, rendered inside a tippy popup. Notion-style:
// section headers, icons, two-line items, keyboard hints, mouse hover sync.
export const SlashMenuList = forwardRef<SlashMenuListHandle, SlashMenuListProps>(
  function SlashMenuList({ items, command }, ref) {
    const [activeIndex, setActiveIndex] = useState(0);
    const [pickerMode, setPickerMode] = useState(false);
    const [pickerDims, setPickerDims] = useState({ rows: 0, cols: 0 });
    const containerRef = useRef<HTMLDivElement>(null);
    const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

    // Group items by section while keeping their original order.
    const groups = useMemo(() => {
      const out: Array<{ section: string; items: SlashItem[] }> = [];
      for (const it of items) {
        const last = out[out.length - 1];
        if (last && last.section === it.section) last.items.push(it);
        else out.push({ section: it.section, items: [it] });
      }
      return out;
    }, [items]);

    // Reset selection when the candidate list changes (user kept typing).
    useEffect(() => {
      setActiveIndex(0);
    }, [items]);

    const activeItem = items[activeIndex];
    const activePicker = activeItem?.picker ?? null;

    useEffect(() => {
      setPickerMode(false);
      if (activePicker) {
        setPickerDims({
          rows: activePicker.initialRows,
          cols: activePicker.initialCols,
        });
      }
    }, [
      activeIndex,
      activePicker?.kind,
      activePicker?.initialRows,
      activePicker?.initialCols,
    ]);

    // Keep the active item visible inside the scroll container.
    useLayoutEffect(() => {
      const el = itemRefs.current[activeIndex];
      el?.scrollIntoView({ block: "nearest" });
    }, [activeIndex]);

    const commit = (index: number, picker?: { rows: number; cols: number }) => {
      const item = items[index];
      if (!item) return;
      if (item.picker && picker && picker.rows > 0 && picker.cols > 0) {
        const wrapped: SlashItem = {
          ...item,
          command: (ctx) => item.command({ ...ctx, picker }),
        };
        command(wrapped);
      } else {
        command(item);
      }
    };

    useImperativeHandle(
      ref,
      (): SlashMenuListHandle => ({
        onKeyDown: (event) => {
          if (event.key === "Escape" && pickerMode) {
            event.preventDefault();
            setPickerMode(false);
            return true;
          }
          if (pickerMode && activePicker) {
            if (event.key === "ArrowUp") {
              event.preventDefault();
              setPickerDims((d) => ({ ...d, rows: Math.max(1, d.rows - 1) }));
              return true;
            }
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setPickerDims((d) => ({
                ...d,
                rows: Math.min(activePicker.maxRows, d.rows + 1),
              }));
              return true;
            }
            if (event.key === "ArrowLeft") {
              event.preventDefault();
              if (pickerDims.cols <= 1) {
                setPickerMode(false);
              } else {
                setPickerDims((d) => ({ ...d, cols: d.cols - 1 }));
              }
              return true;
            }
            if (event.key === "ArrowRight") {
              event.preventDefault();
              setPickerDims((d) => ({
                ...d,
                cols: Math.min(activePicker.maxCols, d.cols + 1),
              }));
              return true;
            }
            if (event.key === "Enter" || event.key === "Tab") {
              event.preventDefault();
              commit(activeIndex, pickerDims);
              return true;
            }
            return false;
          }
          if (event.key === "ArrowUp") {
            event.preventDefault();
            setActiveIndex((i) => (i + items.length - 1) % Math.max(items.length, 1));
            return true;
          }
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setActiveIndex((i) => (i + 1) % Math.max(items.length, 1));
            return true;
          }
          if (event.key === "ArrowRight" && activePicker) {
            event.preventDefault();
            if (pickerDims.rows === 0 || pickerDims.cols === 0) {
              setPickerDims({
                rows: activePicker.initialRows,
                cols: activePicker.initialCols,
              });
            }
            setPickerMode(true);
            return true;
          }
          if (event.key === "Enter" || event.key === "Tab") {
            event.preventDefault();
            commit(activeIndex);
            return true;
          }
          return false;
        },
      }),
      [activeIndex, activePicker, items, pickerDims, pickerMode],
    );

    if (items.length === 0) {
      return (
        <div className="hb-slash-shell">
          <div ref={containerRef} className="hb-slash hb-slash--empty">
            <div className="hb-slash__empty-title">No matches</div>
            <div className="hb-slash__empty-hint">Try a different word.</div>
          </div>
        </div>
      );
    }

    let runningIndex = 0;
    return (
      <div className="hb-slash-shell">
        <div ref={containerRef} className="hb-slash" role="listbox">
          {groups.map((group) => (
            <div key={group.section} className="hb-slash__group">
              <div className="hb-slash__section">{group.section}</div>
              {group.items.map((item) => {
                const index = runningIndex++;
                const Icon = item.icon;
                const active = index === activeIndex;
                return (
                  <button
                    key={item.id}
                    ref={(el) => {
                      itemRefs.current[index] = el;
                    }}
                    type="button"
                    role="option"
                    aria-selected={active}
                    data-active={active || undefined}
                    className="hb-slash__item"
                    onMouseEnter={() => {
                      setActiveIndex(index);
                      setPickerMode(false);
                    }}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      commit(index);
                    }}
                  >
                    <span className="hb-slash__icon-wrap" aria-hidden="true">
                      <Icon className="hb-slash__icon" />
                    </span>
                    <span className="hb-slash__body">
                      <span className="hb-slash__title">{item.title}</span>
                      {item.subtitle ? (
                        <span className="hb-slash__subtitle">{item.subtitle}</span>
                      ) : null}
                    </span>
                    {item.shortcut ? (
                      <span className="hb-slash__shortcut">{item.shortcut}</span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        {activePicker ? (
          <GridPicker
            maxRows={activePicker.maxRows}
            maxCols={activePicker.maxCols}
            rows={pickerDims.rows}
            cols={pickerDims.cols}
            onHover={(rows, cols) => setPickerDims({ rows, cols })}
            onCommit={(rows, cols) => commit(activeIndex, { rows, cols })}
          />
        ) : null}
      </div>
    );
  },
);

interface GridPickerProps {
  maxRows: number;
  maxCols: number;
  rows: number;
  cols: number;
  onHover: (rows: number, cols: number) => void;
  onCommit: (rows: number, cols: number) => void;
}

function GridPicker({
  maxRows,
  maxCols,
  rows,
  cols,
  onHover,
  onCommit,
}: GridPickerProps) {
  const cells = useMemo(() => {
    const out: Array<{ row: number; col: number }> = [];
    for (let r = 1; r <= maxRows; r += 1) {
      for (let c = 1; c <= maxCols; c += 1) {
        out.push({ row: r, col: c });
      }
    }
    return out;
  }, [maxRows, maxCols]);

  return (
    <div className="hb-slash-picker" role="group" aria-label="Table size">
      <div className="hb-slash-picker__label">
        {rows > 0 && cols > 0 ? `${cols} × ${rows}` : "Choose size"}
      </div>
      <div
        className="hb-slash-picker__grid"
        style={{ gridTemplateColumns: `repeat(${maxCols}, 1fr)` }}
        onMouseLeave={() => onHover(0, 0)}
      >
        {cells.map(({ row, col }) => {
          const selected = row <= rows && col <= cols;
          return (
            <button
              key={`${row}-${col}`}
              type="button"
              className="hb-slash-picker__cell"
              data-selected={selected || undefined}
              aria-label={`${col} columns by ${row} rows`}
              onMouseEnter={() => onHover(row, col)}
              onMouseDown={(event) => {
                event.preventDefault();
                onCommit(row, col);
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

// Default command catalogue. Order matters — items appear in this order
// within their section. Sections render in the order their first item
// appears here.
export function defaultSlashItems(): SlashItem[] {
  return [
    {
      id: "paragraph",
      section: "Basic blocks",
      title: "Text",
      subtitle: "Plain paragraph",
      keywords: ["text", "paragraph", "p"],
      icon: IconText,
      command: ({ editor, range }) =>
        editor.chain().focus(undefined, { scrollIntoView: false }).deleteRange(range).setNode("paragraph").run(),
    },
    {
      id: "heading-1",
      section: "Basic blocks",
      title: "Heading 1",
      subtitle: "Large section heading",
      keywords: ["h1", "title", "#"],
      icon: IconHeading1,
      shortcut: "#",
      command: ({ editor, range }) =>
        editor.chain().focus(undefined, { scrollIntoView: false }).deleteRange(range).setNode("heading", { level: 1 }).run(),
    },
    {
      id: "heading-2",
      section: "Basic blocks",
      title: "Heading 2",
      subtitle: "Medium section heading",
      keywords: ["h2", "##"],
      icon: IconHeading2,
      shortcut: "##",
      command: ({ editor, range }) =>
        editor.chain().focus(undefined, { scrollIntoView: false }).deleteRange(range).setNode("heading", { level: 2 }).run(),
    },
    {
      id: "heading-3",
      section: "Basic blocks",
      title: "Heading 3",
      subtitle: "Small section heading",
      keywords: ["h3", "###"],
      icon: IconHeading3,
      shortcut: "###",
      command: ({ editor, range }) =>
        editor.chain().focus(undefined, { scrollIntoView: false }).deleteRange(range).setNode("heading", { level: 3 }).run(),
    },
    {
      id: "bulleted-list",
      section: "Lists",
      title: "Bulleted list",
      subtitle: "Simple bulleted list",
      keywords: ["ul", "list", "unordered"],
      icon: IconList,
      shortcut: "-",
      command: ({ editor, range }) =>
        editor.chain().focus(undefined, { scrollIntoView: false }).deleteRange(range).toggleBulletList().run(),
    },
    {
      id: "numbered-list",
      section: "Lists",
      title: "Numbered list",
      subtitle: "Ordered list",
      keywords: ["ol", "ordered", "1."],
      icon: IconListOrdered,
      shortcut: "1.",
      command: ({ editor, range }) =>
        editor.chain().focus(undefined, { scrollIntoView: false }).deleteRange(range).toggleOrderedList().run(),
    },
    {
      id: "todo-list",
      section: "Lists",
      title: "To-do list",
      subtitle: "Track tasks with checkboxes",
      keywords: ["task", "checkbox", "todo", "[]"],
      icon: IconListChecks,
      shortcut: "[ ]",
      command: ({ editor, range }) =>
        editor.chain().focus(undefined, { scrollIntoView: false }).deleteRange(range).toggleTaskList().run(),
    },
    {
      id: "quote",
      section: "Other",
      title: "Quote",
      subtitle: "Capture a quotation",
      keywords: ["blockquote", ">"],
      icon: IconQuote,
      shortcut: ">",
      command: ({ editor, range }) =>
        editor.chain().focus(undefined, { scrollIntoView: false }).deleteRange(range).setNode("paragraph").toggleBlockquote().run(),
    },
    {
      id: "code-block",
      section: "Other",
      title: "Code block",
      subtitle: "Fenced code with syntax",
      keywords: ["code", "```", "snippet"],
      icon: IconCodeBlock,
      shortcut: "```",
      command: ({ editor, range }) =>
        editor.chain().focus(undefined, { scrollIntoView: false }).deleteRange(range).toggleCodeBlock().run(),
    },
    {
      id: "table",
      section: "Other",
      title: "Table",
      subtitle: "Pick a grid size, columns resize after",
      keywords: ["table", "grid", "rows", "cols"],
      icon: IconTable,
      picker: {
        kind: "grid",
        maxRows: 8,
        maxCols: 10,
        initialRows: 3,
        initialCols: 3,
      },
      command: ({ editor, range, picker }) => {
        const rows = picker?.rows ?? 3;
        const cols = picker?.cols ?? 3;
        editor
          .chain()
          .focus(undefined, { scrollIntoView: false })
          .deleteRange(range)
          .insertTable({ rows, cols, withHeaderRow: true })
          .run();
      },
    },
    {
      id: "divider",
      section: "Other",
      title: "Divider",
      subtitle: "Horizontal rule",
      keywords: ["hr", "rule", "line", "---"],
      icon: IconDivider,
      shortcut: "---",
      command: ({ editor, range }) =>
        editor.chain().focus(undefined, { scrollIntoView: false }).deleteRange(range).setHorizontalRule().run(),
    },
  ];
}

// Filters by title + keywords, case-insensitive. Empty query returns the full
// catalogue so the menu shows up immediately on `/`.
export function filterSlashItems(items: SlashItem[], query: string): SlashItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((item) => {
    if (item.title.toLowerCase().includes(q)) return true;
    if (item.keywords?.some((k) => k.toLowerCase().includes(q))) return true;
    return false;
  });
}
