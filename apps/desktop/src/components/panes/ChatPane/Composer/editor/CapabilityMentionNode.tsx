import { Icon as IconifyIcon } from "@iconify/react";
import { mergeAttributes, Node } from "@tiptap/core";
import {
  type NodeViewProps,
  NodeViewWrapper,
  ReactNodeViewRenderer,
} from "@tiptap/react";

import { EntityChip } from "@/components/ui/entity-chip";
import { getCapabilityIcon } from "@/lib/capabilityGlyph";
import { CAPABILITY_MENTION_NAME } from "./composerValue";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    capabilityMention: {
      insertCapabilityMention: (attrs: {
        capabilityId: string;
        title: string;
      }) => ReturnType;
    };
  }
}

function CapabilityMentionChip({ node }: NodeViewProps) {
  const capabilityId = String(node.attrs.capabilityId ?? "");
  const title = String(node.attrs.title ?? "") || capabilityId;
  return (
    <NodeViewWrapper as="span" className="mr-1 inline-flex align-middle">
      <EntityChip
        size="sm"
        variant="ghost"
        className="text-muted-foreground"
        icon={
          <IconifyIcon
            className="size-3 text-muted-foreground"
            icon={getCapabilityIcon("")}
          />
        }
        label={title}
        contentEditable={false}
      />
    </NodeViewWrapper>
  );
}

export const CapabilityMention = Node.create({
  name: CAPABILITY_MENTION_NAME,
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      capabilityId: { default: "" },
      title: { default: "" },
    };
  },

  parseHTML() {
    return [{ tag: `span[data-capability-mention]` }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-capability-mention": "",
        "data-capability-id": HTMLAttributes.capabilityId ?? "",
      }),
    ];
  },

  renderText({ node }) {
    return `/${node.attrs.capabilityId}`;
  },

  addNodeView() {
    return ReactNodeViewRenderer(CapabilityMentionChip);
  },

  addCommands() {
    return {
      insertCapabilityMention:
        (attrs) =>
        ({ chain }) =>
          chain()
            .insertContent({ type: CAPABILITY_MENTION_NAME, attrs })
            .insertContent(" ")
            .run(),
    };
  },
});
