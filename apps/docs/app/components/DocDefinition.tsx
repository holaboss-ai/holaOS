import type { ReactNode } from "react";

function slugifyTerm(term: string) {
  return term
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function DocDefinition({
  children,
  meta,
  term,
}: {
  children: ReactNode;
  meta?: string;
  term: string;
}) {
  return (
    <div className="hb-doc-definition" id={slugifyTerm(term)}>
      <div className="hb-doc-definition__term">
        <span>{term}</span>
        {meta ? <span className="hb-doc-definition__meta">{meta}</span> : null}
      </div>
      <div className="hb-doc-definition__body">{children}</div>
    </div>
  );
}
