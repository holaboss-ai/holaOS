import type { Editor } from "@tiptap/core";
import type { ComponentType, SVGProps } from "react";

import {
  IconHeading1,
  IconHeading2,
  IconHeading3,
  IconList,
  IconListChecks,
  IconListOrdered,
  IconQuote,
  IconText,
} from "../icons";

export type IconComponent = ComponentType<SVGProps<SVGSVGElement>>;

export interface TurnIntoOption {
  id: string;
  label: string;
  icon: IconComponent;
  isActive: (e: Editor) => boolean;
  apply: (e: Editor) => void;
}

// Shared catalogue of "turn into" block-type conversions, used by both the
// bubble toolbar (selection-driven) and the block menu (drag-handle click).
export const TURN_INTO_OPTIONS: TurnIntoOption[] = [
  {
    id: "paragraph",
    label: "Text",
    icon: IconText,
    isActive: (e) =>
      e.isActive("paragraph") &&
      !e.isActive("heading") &&
      !e.isActive("bulletList") &&
      !e.isActive("orderedList") &&
      !e.isActive("taskList") &&
      !e.isActive("blockquote") &&
      !e.isActive("codeBlock"),
    apply: (e) => e.chain().focus(undefined, { scrollIntoView: false }).setNode("paragraph").run(),
  },
  {
    id: "h1",
    label: "Heading 1",
    icon: IconHeading1,
    isActive: (e) => e.isActive("heading", { level: 1 }),
    apply: (e) => e.chain().focus(undefined, { scrollIntoView: false }).setNode("heading", { level: 1 }).run(),
  },
  {
    id: "h2",
    label: "Heading 2",
    icon: IconHeading2,
    isActive: (e) => e.isActive("heading", { level: 2 }),
    apply: (e) => e.chain().focus(undefined, { scrollIntoView: false }).setNode("heading", { level: 2 }).run(),
  },
  {
    id: "h3",
    label: "Heading 3",
    icon: IconHeading3,
    isActive: (e) => e.isActive("heading", { level: 3 }),
    apply: (e) => e.chain().focus(undefined, { scrollIntoView: false }).setNode("heading", { level: 3 }).run(),
  },
  {
    id: "bullet-list",
    label: "Bulleted list",
    icon: IconList,
    isActive: (e) => e.isActive("bulletList"),
    apply: (e) => e.chain().focus(undefined, { scrollIntoView: false }).toggleBulletList().run(),
  },
  {
    id: "ordered-list",
    label: "Numbered list",
    icon: IconListOrdered,
    isActive: (e) => e.isActive("orderedList"),
    apply: (e) => e.chain().focus(undefined, { scrollIntoView: false }).toggleOrderedList().run(),
  },
  {
    id: "task-list",
    label: "To-do list",
    icon: IconListChecks,
    isActive: (e) => e.isActive("taskList"),
    apply: (e) => e.chain().focus(undefined, { scrollIntoView: false }).toggleTaskList().run(),
  },
  {
    id: "quote",
    label: "Quote",
    icon: IconQuote,
    isActive: (e) => e.isActive("blockquote"),
    apply: (e) => e.chain().focus(undefined, { scrollIntoView: false }).toggleBlockquote().run(),
  },
];

export const currentTurnIntoLabel = (editor: Editor): string => {
  const match = TURN_INTO_OPTIONS.find((o) => o.isActive(editor));
  return match?.label ?? "Text";
};
