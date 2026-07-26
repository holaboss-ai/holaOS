export interface DurableMemoryArtifactContext {
  sourceKind: "attachment" | "image_url" | "tool_result" | "output_artifact";
  treeId: string;
  title: string;
  provider: string | null;
  accountNamespace: string | null;
  canonicalEntityKey: string | null;
  excerpts: string[];
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function artifactContextEvidenceLines(params: {
  artifactContexts: DurableMemoryArtifactContext[];
  maxExcerptsPerArtifact?: number;
  maxCharsPerExcerpt?: number;
}): string[] {
  const maxExcerptsPerArtifact = Math.max(1, params.maxExcerptsPerArtifact ?? 4);
  const maxCharsPerExcerpt = Math.max(120, params.maxCharsPerExcerpt ?? 1_600);
  const lines: string[] = [];
  for (const context of params.artifactContexts) {
    const sourceParts: string[] = [context.sourceKind];
    if (context.provider) {
      sourceParts.push(context.provider);
    }
    if (context.accountNamespace) {
      sourceParts.push(context.accountNamespace);
    }
    const sourceLabel = sourceParts.join(" ");
    for (const excerpt of context.excerpts.slice(0, maxExcerptsPerArtifact)) {
      const normalizedExcerpt = compactWhitespace(excerpt).slice(0, maxCharsPerExcerpt);
      if (!normalizedExcerpt) {
        continue;
      }
      lines.push(compactWhitespace(`[${sourceLabel}] ${context.title} => ${normalizedExcerpt}`));
    }
  }
  return lines;
}
