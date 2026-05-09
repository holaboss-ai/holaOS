import { Extension, type Range } from "@tiptap/core";
import { ReactRenderer } from "@tiptap/react";
import Suggestion, {
  type SuggestionOptions,
  type SuggestionProps,
  type SuggestionKeyDownProps,
} from "@tiptap/suggestion";
import tippy, { type Instance as TippyInstance } from "tippy.js";

import {
  defaultSlashItems,
  filterSlashItems,
  SlashMenuList,
  type SlashItem,
  type SlashMenuListHandle,
} from "./SlashMenuList";

interface SlashCommandOptions {
  suggestion: Omit<SuggestionOptions<SlashItem>, "editor">;
}

// Slash-command extension. Triggers on `/`, opens a tippy popup with the
// SlashMenuList component, hands keyboard control to the list, and runs the
// chosen item's command on the editor.
export const SlashCommand = Extension.create<SlashCommandOptions>({
  name: "slashCommand",

  addOptions() {
    return {
      suggestion: {
        char: "/",
        startOfLine: false,
        // Allow `/` mid-word so the menu still triggers if the user is in the
        // middle of editing a paragraph; can revisit if it gets noisy.
        allowSpaces: false,
        // Don't fire inside code blocks: `/` is a real character there
        // (e.g. closing tags, comments, division), and inserting block-level
        // commands inside a code block makes no sense.
        allow: ({ state }) => {
          const $from = state.selection.$from;
          for (let depth = $from.depth; depth >= 0; depth -= 1) {
            if ($from.node(depth).type.name === "codeBlock") return false;
          }
          return true;
        },
        items: ({ query }: { query: string }) =>
          filterSlashItems(defaultSlashItems(), query).slice(0, 10),
        command: ({ editor, range, props }) => {
          (props as SlashItem).command({ editor, range });
        },
        render: () => {
          let component: ReactRenderer<SlashMenuListHandle> | null = null;
          let popup: TippyInstance[] | null = null;

          return {
            onStart(props: SuggestionProps<SlashItem>) {
              component = new ReactRenderer(SlashMenuList, {
                props: {
                  items: props.items,
                  command: (item: SlashItem) => props.command(item),
                  editor: props.editor,
                  range: props.range,
                },
                editor: props.editor,
              });

              if (!props.clientRect) return;

              popup = tippy("body", {
                getReferenceClientRect: () => {
                  const rect = props.clientRect?.();
                  return rect ?? new DOMRect();
                },
                appendTo: () => document.body,
                content: component.element,
                showOnCreate: true,
                interactive: true,
                trigger: "manual",
                placement: "bottom-start",
                maxWidth: "none",
                offset: [0, 6],
                animation: false,
                theme: "hb-slash",
              });
            },

            onUpdate(props: SuggestionProps<SlashItem>) {
              component?.updateProps({
                items: props.items,
                command: (item: SlashItem) => props.command(item),
                editor: props.editor,
                range: props.range,
              });

              if (!props.clientRect || !popup) return;
              popup[0]?.setProps({
                getReferenceClientRect: () => {
                  const rect = props.clientRect?.();
                  return rect ?? new DOMRect();
                },
              });
            },

            onKeyDown(props: SuggestionKeyDownProps) {
              if (props.event.key === "Escape") {
                popup?.[0]?.hide();
                return true;
              }
              return component?.ref?.onKeyDown(props.event) ?? false;
            },

            onExit() {
              popup?.[0]?.destroy();
              component?.destroy();
              popup = null;
              component = null;
            },
          };
        },
      },
    };
  },

  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        ...this.options.suggestion,
      }),
    ];
  },
});

export type { SlashItem, Range };
