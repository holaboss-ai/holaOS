export const browserHomeUrl = "workspace://google";

export interface QuickLink {
  id: string;
  title: string;
  subtitle: string;
}

export const quickLinks: QuickLink[] = [
  { id: "1", title: "Workspace Docs", subtitle: "Specs and notes" },
  { id: "2", title: "Agent Console", subtitle: "Tasks and logs" },
  { id: "3", title: "Research Radar", subtitle: "Saved sources" },
  { id: "4", title: "Deploy Board", subtitle: "Release status" }
];
