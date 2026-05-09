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
  IconText,
} from "../icons";

type IconComponent = ComponentType<SVGProps<SVGSVGElement>>;

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
  command: (ctx: { editor: Editor; range: Range }) => void;
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

    // Keep the active item visible inside the scroll container.
    useLayoutEffect(() => {
      const el = itemRefs.current[activeIndex];
      el?.scrollIntoView({ block: "nearest" });
    }, [activeIndex]);

    const select = (index: number) => {
      const item = items[index];
      if (!item) return;
      command(item);
    };

    useImperativeHandle(
      ref,
      (): SlashMenuListHandle => ({
        onKeyDown: (event) => {
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
          if (event.key === "Enter" || event.key === "Tab") {
            event.preventDefault();
            select(activeIndex);
            return true;
          }
          return false;
        },
      }),
      [activeIndex, items],
    );

    if (items.length === 0) {
      return (
        <div ref={containerRef} className="hb-slash hb-slash--empty">
          <div className="hb-slash__empty-title">No matches</div>
          <div className="hb-slash__empty-hint">Try a different word.</div>
        </div>
      );
    }

    let runningIndex = 0;
    return (
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
                  onMouseEnter={() => setActiveIndex(index)}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    select(index);
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
    );
  },
);

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
