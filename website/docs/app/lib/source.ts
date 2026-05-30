import { loader } from 'fumadocs-core/source';
import { lucideIconsPlugin } from 'fumadocs-core/source/plugins/lucide-icons';
import { docs } from 'collections/server';
import { docsContentRoute, docsRoute } from './shared';

export const source = loader({
  source: docs.toFumadocsSource(),
  baseUrl: docsRoute,
  plugins: [lucideIconsPlugin()],
});

type SourcePage = NonNullable<ReturnType<typeof source.getPage>>;
type SourcePageWithText = SourcePage & {
  data: SourcePage["data"] & {
    getText(type: "raw" | "processed"): Promise<string>;
  };
};

export function getPageMarkdownUrl(page: SourcePage) {
  const segments = [...page.slugs, 'content.md'];

  return {
    segments,
    url: `${docsContentRoute}/${segments.join('/')}`,
  };
}

export async function getLLMText(page: SourcePage) {
  // The generated loader type currently drops fumadocs-mdx's runtime
  // getText() helper even though includeProcessedMarkdown is enabled.
  const processed = await (page as SourcePageWithText).data.getText('processed');

  return `# ${page.data.title} (${page.url})

${processed}`;
}
