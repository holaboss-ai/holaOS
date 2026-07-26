import defaultMdxComponents from 'fumadocs-ui/mdx';
import type { MDXComponents } from 'mdx/types';
import { DiagramFileTree } from "./DiagramFileTree";
import { DiagramSystemOverview } from "./DiagramSystemOverview";
import { DiagramWorkspaceTree } from "./DiagramWorkspaceTree";
import { DocCard, DocCards } from "./DocCards";
import { DocDefinition } from "./DocDefinition";

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    DiagramFileTree,
    DiagramSystemOverview,
    DiagramWorkspaceTree,
    DocCard,
    DocCards,
    DocDefinition,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
