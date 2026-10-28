import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Play } from "@/components/ui/icons";
import type { BenchCatalogEntry } from "../../../shared/bench-protocol";
import { errorMessage } from "./format";

/** Opens the one-click benchmark window for a model the app can run on Ollama. */
export function RunBenchmarkButton() {
  const [catalog, setCatalog] = useState<BenchCatalogEntry[]>([]);

  useEffect(() => {
    let cancelled = false;
    void window.electronAPI.bench
      .catalog()
      .then((entries) => {
        if (!cancelled) {
          setCatalog(entries);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  if (catalog.length === 0) {
    return null;
  }

  const open = (subjectId: string) => {
    void window.electronAPI.bench
      .open(subjectId)
      .catch((cause: unknown) => toast.error(errorMessage(cause, "Couldn't open the benchmark.")));
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button className="h-7 gap-1.5" size="sm" type="button" variant="outline" />}
      >
        <Play className="size-3.5" />
        Run benchmark
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60" sideOffset={6}>
        {catalog.map((entry) => (
          <DropdownMenuItem key={entry.id} onClick={() => open(entry.id)}>
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-sm">{entry.name}</span>
              <span className="truncate text-muted-foreground text-xs">
                {[entry.vendor, entry.quant, entry.download_bytes ? `${(entry.download_bytes / 2 ** 30).toFixed(1)} GB` : null]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
