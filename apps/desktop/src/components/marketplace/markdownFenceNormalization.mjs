const FENCE_LINE_PATTERN = /^(\s{0,3})(`{3,}|~{3,})([^\n]*)$/;
const MARKDOWN_WRAPPER_LANGUAGES = new Set(["md", "markdown", "mdx"]);

function parseFenceLine(line, index) {
  const match = FENCE_LINE_PATTERN.exec(line);
  if (!match) {
    return null;
  }

  const [, indent, fence, info] = match;
  return {
    index,
    indent,
    marker: fence[0],
    markerLength: fence.length,
    info,
    trimmedInfo: info.trim(),
  };
}

export function normalizeWrappedMarkdownFence(markdown) {
  if (typeof markdown !== "string" || markdown.length === 0) {
    return "";
  }

  const lines = markdown.split(/\r?\n/);
  const fences = lines
    .map((line, index) => parseFenceLine(line, index))
    .filter(Boolean);

  if (fences.length < 4) {
    return markdown;
  }

  for (let index = 0; index < fences.length - 3; index += 1) {
    const opening = fences[index];
    if (!MARKDOWN_WRAPPER_LANGUAGES.has(opening.trimmedInfo.toLowerCase())) {
      continue;
    }

    const nextFence = fences[index + 1];
    if (
      !nextFence ||
      nextFence.marker !== opening.marker ||
      nextFence.markerLength < opening.markerLength ||
      nextFence.trimmedInfo.length === 0
    ) {
      continue;
    }

    let fenceDepth = 1;
    let closing = null;
    const nestedFences = [];
    for (const fence of fences.slice(index + 1)) {
      if (fence.marker !== opening.marker || fence.markerLength < opening.markerLength) {
        continue;
      }
      nestedFences.push(fence);
      if (fence.trimmedInfo.length > 0) {
        fenceDepth += 1;
        continue;
      }
      fenceDepth -= 1;
      if (fenceDepth === 0) {
        closing = fence;
        break;
      }
    }

    if (!closing || nestedFences.length < 2) {
      continue;
    }

    const repairedFence = opening.marker.repeat(
      Math.max(opening.markerLength, ...nestedFences.map((fence) => fence.markerLength)) + 1,
    );
    lines[opening.index] = `${opening.indent}${repairedFence}${opening.info}`;
    lines[closing.index] = `${closing.indent}${repairedFence}`;
    return lines.join("\n");
  }

  return markdown;
}
