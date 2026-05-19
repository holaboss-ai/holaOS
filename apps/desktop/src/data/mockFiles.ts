export type ExplorerSection = "Today" | "This Week" | "This Year";

export interface FileRow {
  id: string;
  section: ExplorerSection;
  name: string;
  modified: string;
  size: string;
  type: "folder" | "file";
  expanded?: boolean;
}

export const explorerSections: ExplorerSection[] = ["Today", "This Week", "This Year"];

export const fileRows: FileRow[] = [
  {
    id: "folder-client-strategy",
    section: "Today",
    name: "Client Strategy Hub",
    modified: "11:42 AM",
    size: "-",
    type: "folder",
    expanded: true
  },
  {
    id: "file-q3-growth",
    section: "Today",
    name: "Q3_growth_blueprint.md",
    modified: "10:12 AM",
    size: "124 KB",
    type: "file"
  },
  {
    id: "file-neon-prototype",
    section: "Today",
    name: "neon_workspace_prototype.fig",
    modified: "09:36 AM",
    size: "8.9 MB",
    type: "file"
  },
  {
    id: "folder-research-vault",
    section: "This Week",
    name: "Research Vault",
    modified: "Mon",
    size: "-",
    type: "folder"
  },
  {
    id: "file-market-map",
    section: "This Week",
    name: "market_signal_map.xlsx",
    modified: "Sun",
    size: "1.4 MB",
    type: "file"
  },
  {
    id: "file-automation-notes",
    section: "This Week",
    name: "automation_notes_v2.txt",
    modified: "Sat",
    size: "64 KB",
    type: "file"
  },
  {
    id: "folder-archive-2026",
    section: "This Year",
    name: "Archive 2026",
    modified: "Jan 18",
    size: "-",
    type: "folder"
  },
  {
    id: "file-investor-onepager",
    section: "This Year",
    name: "investor_onepager.pptx",
    modified: "Jan 09",
    size: "3.2 MB",
    type: "file"
  },
  {
    id: "file-api-playbook",
    section: "This Year",
    name: "api_integration_playbook.pdf",
    modified: "Jan 03",
    size: "2.1 MB",
    type: "file"
  }
];
