export function getPageImagePath(slugs: string[]) {
  const segments = [...slugs, 'image.webp'];

  return `/docs/og/${segments.join('/')}`;
}
