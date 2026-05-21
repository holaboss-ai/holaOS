// Reference dashboard route — the canonical visual shape for any
// app-builder module that needs a list view. Demonstrates the full
// @holaboss/ui composition pattern: DashboardShell + PageHeader +
// FilterBar + StatPill grid + DataTable, with consistent loading,
// empty, and error states.
//
// Copy this file as the starting point for a new dashboard. Replace
// the Issue type, the columns, the stats, and the fetch hook with
// whatever the actual module needs. The chrome stays.

import { useMemo, useState } from "react";
import { CheckCircle2, Plus, RefreshCw } from "lucide-react";

import {
  Badge,
  Button,
  DashboardShell,
  DataTable,
  ErrorState,
  FilterBar,
  PageHeader,
  Section,
  StatPill,
  type DataTableColumn,
} from "@holaboss/ui";

interface Issue {
  id: number;
  title: string;
  status: "open" | "in_progress" | "closed";
  assignee: string | null;
  created_at: string;
}

// Stand-in for a real TanStack Query / loader. In production this would
// be a useQuery against the app's SQLite via a TanStack Start server
// function — same DB the MCP tools mutate.
function useIssues(search: string): {
  data: Issue[];
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
} {
  return {
    data: [
      { id: 1, title: "Fix login redirect", status: "open", assignee: "alice", created_at: "2026-05-12" },
      { id: 2, title: "Refactor token refresh", status: "in_progress", assignee: "bob", created_at: "2026-05-13" },
      { id: 3, title: "Drop legacy webhook handler", status: "closed", assignee: null, created_at: "2026-05-11" },
    ].filter((row) =>
      search ? row.title.toLowerCase().includes(search.toLowerCase()) : true,
    ),
    isLoading: false,
    error: null,
    refetch: () => {
      /* no-op in the reference */
    },
  };
}

const statusTone: Record<Issue["status"], "default" | "secondary" | "outline"> = {
  open: "default",
  in_progress: "secondary",
  closed: "outline",
};

export default function Dashboard() {
  const [search, setSearch] = useState("");
  const { data: rows, isLoading, error, refetch } = useIssues(search);

  const stats = useMemo(
    () => ({
      total: rows.length,
      open: rows.filter((r) => r.status === "open").length,
      closed: rows.filter((r) => r.status === "closed").length,
    }),
    [rows],
  );

  const columns: DataTableColumn<Issue>[] = [
    {
      id: "title",
      header: "Title",
      cell: (row) => <span className="font-medium">{row.title}</span>,
    },
    {
      id: "status",
      header: "Status",
      width: "120px",
      cell: (row) => <Badge variant={statusTone[row.status]}>{row.status}</Badge>,
    },
    {
      id: "assignee",
      header: "Assignee",
      width: "140px",
      cell: (row) => row.assignee ?? <span className="text-muted-foreground">—</span>,
      hideOnSmall: true,
    },
    {
      id: "created",
      header: "Created",
      width: "120px",
      align: "right",
      cell: (row) => (
        <span className="text-muted-foreground">{row.created_at}</span>
      ),
      hideOnSmall: true,
    },
  ];

  return (
    <DashboardShell
      header={
        <>
          <PageHeader
            title="Issues"
            description="GitHub issues synced into the workspace"
            actions={
              <>
                <Button size="sm" variant="ghost" onClick={refetch}>
                  <RefreshCw />
                  Refresh
                </Button>
                <Button size="sm">
                  <Plus />
                  New issue
                </Button>
              </>
            }
          />
          <FilterBar
            search={search}
            onSearchChange={setSearch}
            searchPlaceholder="Search issues…"
          />
        </>
      }
    >
      <Section title="Overview" description="A snapshot of the current state.">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <StatPill label="Total" value={stats.total} />
          <StatPill label="Open" value={stats.open} tone="positive" />
          <StatPill
            label="Closed"
            value={stats.closed}
            icon={CheckCircle2}
            tone="neutral"
          />
        </div>
      </Section>

      <Section title="Issues">
        {error ? (
          <ErrorState detail={error.message} onRetry={refetch} />
        ) : (
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(r) => String(r.id)}
            isLoading={isLoading}
            emptyTitle="No issues match"
            emptyDescription="Try a different search, or refresh from upstream."
          />
        )}
      </Section>
    </DashboardShell>
  );
}
