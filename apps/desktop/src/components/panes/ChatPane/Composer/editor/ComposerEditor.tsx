import { Icon as IconifyIcon } from "@iconify/react";
import { Extension } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import Document from "@tiptap/extension-document";
import HardBreak from "@tiptap/extension-hard-break";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import { UndoRedo } from "@tiptap/extensions";
import { EditorContent, useEditor } from "@tiptap/react";
import Suggestion from "@tiptap/suggestion";
import {
  Fragment,
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { Feather } from "@/components/ui/icons";
import { getCapabilityIcon } from "@/lib/capabilityGlyph";
import type {
  ChatComposerMentionItem,
  ChatComposerSlashCommandOption,
} from "../../types";
import { CapabilityMention } from "./CapabilityMentionNode";
import {
  CAPABILITY_MENTION_NAME,
  buildComposerDoc,
  type ComposerValue,
  extractComposerValue,
  SKILL_MENTION_NAME,
} from "./composerValue";
import { SkillMention } from "./SkillMentionNode";

export interface ComposerEditorHandle {
  focus: () => void;
  isEmpty: () => boolean;
  getValue: () => ComposerValue;
  setContent: (value: ComposerValue) => void;
  insertSkill: (skillId: string, title: string) => void;
  insertCapability: (capabilityId: string, title: string) => void;
  removeSkill: (skillId: string) => void;
  clear: () => void;
}

interface ComposerEditorProps {
  disabled: boolean;
  placeholder: string;
  slashCommands: ChatComposerSlashCommandOption[];
  mentionItems: ChatComposerMentionItem[];
  onChange: (value: ComposerValue) => void;
  onSubmit: (value: ComposerValue) => void;
  onRecallLatest: () => boolean;
  onCancelDraft: () => boolean;
  onPasteFiles: (event: ClipboardEvent) => boolean;
  /** Content to seed the editor with on (re)mount, mirroring the parent's
   *  source-of-truth composer value. The editor is otherwise created empty and
   *  filled only imperatively via `setContent`, which is lost if the editor
   *  remounts after that call (e.g. an async host-driven session switch swaps in
   *  the empty-state composer) or if `setContent` fired while it was still null. */
  initialValue?: ComposerValue;
}

type MenuItem =
  | { kind: "slash"; option: ChatComposerSlashCommandOption }
  | { kind: "mention"; item: ChatComposerMentionItem };

interface MenuState {
  items: MenuItem[];
  rect: { left: number; top: number } | null;
  selected: number;
  pick: (item: MenuItem) => void;
}

function hasSkill(value: ComposerValue, skillId: string) {
  return value.skillIds.includes(skillId);
}

function hasCapability(value: ComposerValue, capabilityId: string) {
  return value.capabilityIds.includes(capabilityId);
}

export const ComposerEditor = forwardRef<
  ComposerEditorHandle,
  ComposerEditorProps
>(function ComposerEditor(props, ref) {
  const propsRef = useRef(props);
  propsRef.current = props;
  const [menu, setMenu] = useState<MenuState | null>(null);
  const menuRef = useRef<MenuState | null>(null);
  menuRef.current = menu;

  const emitChange = useMemo(
    () =>
      (json: unknown) => {
        propsRef.current.onChange(
          extractComposerValue(json as Parameters<typeof extractComposerValue>[0]),
        );
      },
    [],
  );

  const suggestionFor = useMemo(
    () =>
      (kind: "slash" | "mention", char: string) => ({
        char,
        // Distinct key per suggestion plugin — both @tiptap/suggestion plugins
        // otherwise share the default "suggestion$" key, which crashes
        // ProseMirror with "Adding different instances of a keyed plugin".
        pluginKey: new PluginKey(`composerSuggestion-${kind}`),
        startOfLine: false,
        allowSpaces: false,
        items: ({ query }: { query: string }): MenuItem[] => {
          const q = query.trim().toLowerCase();
          if (kind === "slash") {
            const all = propsRef.current.slashCommands;
            const filtered = q
              ? all.filter(
                  (c) =>
                    c.command.toLowerCase().includes(q) ||
                    c.searchText.includes(q),
                )
              : all;
            return filtered.map((option) => ({ kind: "slash", option }));
          }
          const all = propsRef.current.mentionItems;
          const filtered = q
            ? all.filter((item) =>
                [item.handle, ...(item.keywords ?? [])]
                  .join(" ")
                  .toLowerCase()
                  .includes(q),
              )
            : all;
          return filtered.map((item) => ({ kind: "mention", item }));
        },
        render: () => {
          let selected = 0;
          let current: {
            items: MenuItem[];
            command: (item: MenuItem) => void;
            clientRect: (() => DOMRect | null) | null | undefined;
          } | null = null;

          const publish = () => {
            if (!current) {
              setMenu(null);
              return;
            }
            const rect = current.clientRect?.();
            setMenu({
              items: current.items,
              selected,
              rect: rect ? { left: rect.left, top: rect.top } : null,
              pick: (item) => current?.command(item),
            });
          };

          return {
            onStart: (p: {
              items: MenuItem[];
              command: (item: MenuItem) => void;
              clientRect?: (() => DOMRect | null) | null;
            }) => {
              selected = 0;
              current = {
                items: p.items,
                command: p.command,
                clientRect: p.clientRect,
              };
              publish();
            },
            onUpdate: (p: {
              items: MenuItem[];
              command: (item: MenuItem) => void;
              clientRect?: (() => DOMRect | null) | null;
            }) => {
              current = {
                items: p.items,
                command: p.command,
                clientRect: p.clientRect,
              };
              if (selected >= p.items.length) {
                selected = 0;
              }
              publish();
            },
            onKeyDown: (p: { event: KeyboardEvent }) => {
              if (!current || current.items.length === 0) {
                if (p.event.key === "Escape") {
                  current = null;
                  setMenu(null);
                  return true;
                }
                return false;
              }
              const count = current.items.length;
              if (p.event.key === "ArrowDown") {
                selected = (selected + 1) % count;
                publish();
                return true;
              }
              if (p.event.key === "ArrowUp") {
                selected = (selected - 1 + count) % count;
                publish();
                return true;
              }
              if (p.event.key === "Enter" || p.event.key === "Tab") {
                const item = current.items[Math.min(selected, count - 1)];
                if (item) {
                  current.command(item);
                }
                return true;
              }
              if (p.event.key === "Escape") {
                current = null;
                setMenu(null);
                return true;
              }
              return false;
            },
            onExit: () => {
              current = null;
              setMenu(null);
            },
          };
        },
        command: ({
          editor: ed,
          range,
          props: item,
        }: {
          editor: import("@tiptap/core").Editor;
          range: { from: number; to: number };
          props: MenuItem;
        }) => {
          if (item.kind === "slash") {
            const value = extractComposerValue(
              ed.getJSON() as Parameters<typeof extractComposerValue>[0],
            );
            const chain = ed.chain().focus().deleteRange(range);
            if (item.option.kind === "capability") {
              if (hasCapability(value, item.option.capabilityId)) {
                chain.run();
                return;
              }
              chain
                .insertCapabilityMention({
                  capabilityId: item.option.capabilityId,
                  title: item.option.label,
                })
                .run();
              return;
            }
            if (hasSkill(value, item.option.skillId)) {
              chain.run();
              return;
            }
            chain
              .insertSkillMention({
                skillId: item.option.skillId,
                title: item.option.label,
              })
              .run();
            return;
          }
          ed.chain()
            .focus()
            .deleteRange(range)
            .insertContent(`@${item.item.handle} `)
            .run();
        },
      }),
    [],
  );

  // Seed the editor once, at mount, from the parent's current composer value.
  // Re-seeding from the source-of-truth input on every (re)mount is always
  // correct and is what keeps a host prefill from being dropped when the editor
  // instance is swapped out from under the imperative `setContent`.
  const initialContentRef = useRef<ReturnType<typeof buildComposerDoc> | null>(
    null,
  );
  if (initialContentRef.current === null) {
    const seed = props.initialValue ?? {
      text: "",
      skillIds: [],
      capabilityIds: [],
    };
    const titleForSeed = (skillId: string) =>
      props.slashCommands.find(
        (c) => c.kind === "skill" && c.skillId === skillId,
      )?.label ?? skillId;
    initialContentRef.current = buildComposerDoc(seed, titleForSeed);
  }

  const editor = useEditor({
    editable: !props.disabled,
    content: initialContentRef.current,
    extensions: [
      Document,
      Paragraph,
      Text,
      HardBreak,
      UndoRedo,
      SkillMention,
      CapabilityMention,
      Extension.create({
        name: "composerSuggestions",
        addProseMirrorPlugins() {
          return [
            Suggestion({ editor: this.editor, ...suggestionFor("slash", "/") }),
            Suggestion({
              editor: this.editor,
              ...suggestionFor("mention", "@"),
            }),
          ];
        },
      }),
    ],
    editorProps: {
      attributes: {
        class:
          "composer-input block min-h-10 w-full bg-transparent text-[14px] leading-relaxed text-foreground outline-none",
      },
      handlePaste: (_view, event) => propsRef.current.onPasteFiles(event),
      handleKeyDown: (view, event) => {
        if (menuRef.current) {
          return false;
        }
        const native = event as KeyboardEvent & {
          isComposing?: boolean;
          keyCode?: number;
        };
        if (native.isComposing === true || native.keyCode === 229) {
          return false;
        }
        if (
          event.key.toLowerCase() === "c" &&
          event.ctrlKey &&
          !event.metaKey &&
          !event.altKey &&
          !event.shiftKey &&
          propsRef.current.onCancelDraft()
        ) {
          event.preventDefault();
          return true;
        }
        if (
          event.key === "ArrowUp" &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.altKey &&
          !event.shiftKey
        ) {
          const { empty, $from } = view.state.selection;
          const atStart = empty && $from.pos <= 1;
          if (
            atStart &&
            view.state.doc.textContent.length === 0 &&
            propsRef.current.onRecallLatest()
          ) {
            event.preventDefault();
            return true;
          }
        }
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          propsRef.current.onSubmit(
            extractComposerValue(
              view.state.doc.toJSON() as Parameters<
                typeof extractComposerValue
              >[0],
            ),
          );
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor: ed }) => {
      emitChange(ed.getJSON());
    },
  });

  useEffect(() => {
    editor?.setEditable(!props.disabled);
  }, [editor, props.disabled]);

  useImperativeHandle(
    ref,
    (): ComposerEditorHandle => ({
      focus: () => editor?.commands.focus("end"),
      isEmpty: () => editor?.isEmpty ?? true,
      getValue: () =>
        editor
          ? extractComposerValue(
              editor.getJSON() as Parameters<typeof extractComposerValue>[0],
            )
          : { text: "", skillIds: [], capabilityIds: [] },
      setContent: (value) => {
        if (!editor) {
          return;
        }
        const titleFor = (skillId: string) =>
          propsRef.current.slashCommands.find(
            (c) => c.kind === "skill" && c.skillId === skillId,
          )?.label ?? skillId;
        editor.commands.setContent(buildComposerDoc(value, titleFor));
        editor.commands.focus("end");
      },
      insertSkill: (skillId, title) => {
        if (!editor) {
          return;
        }
        const value = extractComposerValue(
          editor.getJSON() as Parameters<typeof extractComposerValue>[0],
        );
        if (hasSkill(value, skillId)) {
          return;
        }
        editor.chain().focus().insertSkillMention({ skillId, title }).run();
      },
      insertCapability: (capabilityId, title) => {
        if (!editor) {
          return;
        }
        const value = extractComposerValue(
          editor.getJSON() as Parameters<typeof extractComposerValue>[0],
        );
        if (hasCapability(value, capabilityId)) {
          return;
        }
        editor
          .chain()
          .focus()
          .insertCapabilityMention({ capabilityId, title })
          .run();
      },
      removeSkill: (skillId) => {
        if (!editor) {
          return;
        }
        const { state } = editor;
        let removed = false;
        state.doc.descendants((node, pos) => {
          if (
            !removed &&
            node.type.name === SKILL_MENTION_NAME &&
            node.attrs.skillId === skillId
          ) {
            editor
              .chain()
              .focus()
              .deleteRange({ from: pos, to: pos + node.nodeSize })
              .run();
            removed = true;
            return false;
          }
          return true;
        });
      },
      clear: () => editor?.commands.clearContent(true),
    }),
    [editor],
  );

  const showPlaceholder = (editor?.isEmpty ?? true) && !menu;

  return (
    <div className="relative">
      {showPlaceholder ? (
        <span className="pointer-events-none absolute left-0 top-0 text-[14px] leading-relaxed text-foreground/35">
          {props.placeholder}
        </span>
      ) : null}
      <EditorContent
        editor={editor}
        className="chat-scrollbar-thin max-h-55 overflow-y-auto"
      />
      {menu && menu.items.length > 0 && menu.rect
        ? createPortal(
            <div
              className="fixed z-50 max-w-md"
              style={{
                left: menu.rect.left,
                bottom: Math.max(0, window.innerHeight - menu.rect.top + 8),
              }}
            >
              <div className="overflow-hidden rounded-lg bg-popover shadow-md">
                <div className="chat-scrollbar-thin max-h-[280px] w-72 overflow-y-auto p-1">
                  {(() => {
                    let prevGroup: string | null = null;
                    return menu.items.map((item, index) => {
                      const key =
                        item.kind === "slash" ? item.option.key : item.item.id;
                      const label =
                        item.kind === "slash"
                          ? item.option.label
                          : item.item.label;
                      const group =
                        item.kind === "slash" &&
                        item.option.kind === "capability"
                          ? "Combos"
                          : item.kind === "slash"
                            ? "Skills"
                            : null;
                      const showHeader = group !== null && group !== prevGroup;
                      prevGroup = group;
                      const glyph =
                        item.kind === "slash" &&
                        item.option.kind === "capability" ? (
                          <IconifyIcon
                            className="size-3.5 shrink-0 text-muted-foreground"
                            icon={getCapabilityIcon("")}
                          />
                        ) : item.kind === "slash" ? (
                          <Feather className="size-3.5 shrink-0 text-muted-foreground" />
                        ) : null;
                      return (
                        <Fragment key={key}>
                          {showHeader ? (
                            <div className="px-2 pt-2 pb-1 font-medium text-[11px] text-muted-foreground">
                              {group}
                            </div>
                          ) : null}
                          <button
                            type="button"
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => menu.pick(item)}
                            className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors ${
                              index === menu.selected
                                ? "bg-fg-8 text-foreground"
                                : "hover:bg-fg-4"
                            }`}
                          >
                            {glyph}
                            <span className="min-w-0 flex-1 truncate">
                              {label}
                            </span>
                          </button>
                        </Fragment>
                      );
                    });
                  })()}
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
});
