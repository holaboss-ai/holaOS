import { redirectDocument } from 'react-router';

// `/docs` is owned by the frontend worker, not this one. At the HTTP
// layer CF routing already steers `/docs` to the frontend. But once a
// user is inside this worker's SPA (e.g. on `/docs/getting-started`),
// React Router intercepts popstate / <Link> navigation to `/docs` and
// would client-side-render the catch-all 404 because no route matches.
//
// Register a bare `/docs` route whose loader returns `redirectDocument`
// so the client breaks out of the SPA with a full document reload, at
// which point CF routes the request to the frontend landing.
export function loader() {
  return redirectDocument('/docs');
}

export default function DocsEscape() {
  return null;
}
