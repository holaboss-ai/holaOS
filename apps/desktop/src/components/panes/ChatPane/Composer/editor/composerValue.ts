export const SKILL_MENTION_NAME = "skillMention";
export const CAPABILITY_MENTION_NAME = "capabilityMention";

export interface ComposerValue {
  text: string;
  skillIds: string[];
  capabilityIds: string[];
}

export interface ProseMirrorNode {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: ProseMirrorNode[];
}

function collect(
  node: ProseMirrorNode,
  out: {
    parts: string[];
    skillIds: string[];
    capabilityIds: string[];
    seen: Set<string>;
    seenCapabilities: Set<string>;
  },
) {
  if (node.type === "text") {
    out.parts.push(node.text ?? "");
    return;
  }
  if (node.type === "hardBreak") {
    out.parts.push("\n");
    return;
  }
  if (node.type === SKILL_MENTION_NAME) {
    const skillId = String(node.attrs?.skillId ?? "").trim();
    if (skillId && !out.seen.has(skillId)) {
      out.seen.add(skillId);
      out.skillIds.push(skillId);
    }
    return;
  }
  if (node.type === CAPABILITY_MENTION_NAME) {
    const capabilityId = String(node.attrs?.capabilityId ?? "").trim();
    if (capabilityId && !out.seenCapabilities.has(capabilityId)) {
      out.seenCapabilities.add(capabilityId);
      out.capabilityIds.push(capabilityId);
    }
    return;
  }
  if (node.type === "paragraph") {
    for (const child of node.content ?? []) {
      collect(child, out);
    }
    out.parts.push("\n");
    return;
  }
  for (const child of node.content ?? []) {
    collect(child, out);
  }
}

/** Derive the composer's `{ text, skillIds, capabilityIds }` from a Tiptap doc
 *  JSON. Skill/capability mentions contribute no text; their ids are collected
 *  in document order and de-duplicated. Paragraphs join with newlines. */
export function extractComposerValue(doc: ProseMirrorNode): ComposerValue {
  const out = {
    parts: [] as string[],
    skillIds: [] as string[],
    capabilityIds: [] as string[],
    seen: new Set<string>(),
    seenCapabilities: new Set<string>(),
  };
  collect(doc, out);
  return {
    text: out.parts.join("").replace(/\n+$/u, ""),
    skillIds: out.skillIds,
    capabilityIds: out.capabilityIds,
  };
}

/** Build a single-paragraph Tiptap doc JSON from a
 *  `{ text, skillIds, capabilityIds }` value: capability chips, then skill
 *  chips, then the body text (newlines as hard breaks). */
export function buildComposerDoc(
  value: ComposerValue,
  titleFor: (skillId: string) => string,
): ProseMirrorNode {
  const content: ProseMirrorNode[] = [];
  for (const capabilityId of value.capabilityIds ?? []) {
    content.push({
      type: CAPABILITY_MENTION_NAME,
      attrs: { capabilityId, title: capabilityId },
    });
  }
  for (const skillId of value.skillIds) {
    content.push({
      type: SKILL_MENTION_NAME,
      attrs: { skillId, title: titleFor(skillId) },
    });
  }
  const text = value.text ?? "";
  if (text) {
    const segments = text.split("\n");
    segments.forEach((segment, index) => {
      if (index > 0) {
        content.push({ type: "hardBreak" });
      }
      if (segment) {
        content.push({ type: "text", text: segment });
      }
    });
  }
  return { type: "doc", content: [{ type: "paragraph", content }] };
}
