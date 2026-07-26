import type { ReactNode } from "react";
import { Link } from "react-router";

export function DocCards({ children }: { children: ReactNode }) {
  return <div className="hb-doc-cards">{children}</div>;
}

export function DocCard({
  children,
  description,
  eyebrow,
  href,
  title,
}: {
  children?: ReactNode;
  description?: string;
  eyebrow?: string;
  href?: string;
  title: string;
}) {
  const content = (
    <>
      {eyebrow ? <div className="hb-doc-card__eyebrow">{eyebrow}</div> : null}
      <div className="hb-doc-card__title">{title}</div>
      {description ? (
        <div className="hb-doc-card__description">{description}</div>
      ) : null}
      {children ? <div className="hb-doc-card__description">{children}</div> : null}
    </>
  );

  if (href) {
    return (
      <Link className="hb-doc-card" to={href}>
        {content}
      </Link>
    );
  }

  return <div className="hb-doc-card">{content}</div>;
}
