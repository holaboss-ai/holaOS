import { useAtomValue } from "jotai";

import { projectViewAtom } from "@/components/layout/shell/state/ui";

import { ProjectLanding } from "./ProjectLanding";
import { ProjectsIndex } from "./ProjectsIndex";

/**
 * Routes between the Projects index (Scene 2) and a single project's
 * landing page (Scene 3) based on `projectViewAtom`. Renders nothing when
 * the atom is null — ChatPanel uses that signal to fall back to its
 * normal chat/artifacts/sessions content.
 */
export function ProjectsOverlay({
  workspaceId,
}: {
  workspaceId: string | null;
}) {
  const view = useAtomValue(projectViewAtom);
  if (!view) return null;
  if (view.mode === "index") {
    return <ProjectsIndex workspaceId={workspaceId} />;
  }
  return (
    <ProjectLanding workspaceId={workspaceId} projectId={view.projectId} />
  );
}
