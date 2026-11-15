import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { FileText, Loader2, Upload } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { remoteApiQuery } from "@/lib/remoteApiQuery";
import { useEvaluationTargets } from "./data";
import { errorMessage, targetDetail, targetKey, toEvalTarget } from "./format";
import { Field } from "./NewEvaluationDialog";
import { useOpenEvaluation } from "./useOpenEvaluation";

const MAX_REPORT_BYTES = 20_000_000;

export function ReproduceDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <DialogPrimitive.Root onOpenChange={onOpenChange} open={open}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-[90] bg-foreground/20 backdrop-blur-sm ease-emphasized data-open:duration-snappy data-open:animate-in data-open:fade-in-0 data-closed:duration-tap data-closed:animate-out data-closed:fade-out-0" />
        <DialogPrimitive.Popup className="fixed top-[14%] left-1/2 z-[100] w-[480px] max-w-[calc(100vw-2rem)] -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-popover shadow-2xl outline-none ease-emphasized data-open:duration-snappy data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:duration-tap data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95">
          {open ? <ReproduceForm onClose={() => onOpenChange(false)} /> : null}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function ReproduceForm({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const openEvaluation = useOpenEvaluation();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const targetsQuery = useEvaluationTargets();
  const targets = targetsQuery.data?.targets ?? [];
  const [file, setFile] = useState<File | null>(null);
  const [targetId, setTargetId] = useState<string | null>(null);
  const [sourceUrl, setSourceUrl] = useState("");
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!targetId && targets.length > 0) {
      setTargetId(targetKey(targets[0]));
    }
  }, [targetId, targets]);

  const importMutation = useMutation(
    remoteApiQuery.evals.importReproduction.mutationOptions({
      onSuccess: async (created) => {
        await queryClient.invalidateQueries({
          queryKey: remoteApiQuery.evals.list.key(),
        });
        onClose();
        openEvaluation(created);
      },
      onError: (cause) => {
        setError(errorMessage(cause, "Couldn't import this report."));
      },
    }),
  );

  const selectedTarget =
    targets.find((target) => targetKey(target) === targetId) ?? null;
  const trimmedSourceUrl = sourceUrl.trim();
  const sourceUrlValid = !trimmedSourceUrl || isHttpUrl(trimmedSourceUrl);
  const busy = reading || importMutation.isPending;
  const canImport =
    Boolean(file) && Boolean(selectedTarget) && sourceUrlValid && !busy;

  const submit = async () => {
    if (!(file && selectedTarget) || !canImport) {
      return;
    }
    setError(null);
    if (file.size > MAX_REPORT_BYTES) {
      setError("This file is larger than 20 MB.");
      return;
    }
    setReading(true);
    let reportHtml = "";
    try {
      reportHtml = await file.text();
    } catch (cause) {
      setError(errorMessage(cause, "Couldn't read the file."));
      return;
    } finally {
      setReading(false);
    }
    if (!reportHtml.trim()) {
      setError("The file is empty.");
      return;
    }
    importMutation.mutate({
      reportHtml,
      target: toEvalTarget(selectedTarget),
      sourceUrl: trimmedSourceUrl || null,
    });
  };

  return (
    <div className="flex max-h-[80vh] flex-col gap-4 overflow-y-auto p-5">
      <div className="space-y-1">
        <DialogPrimitive.Title className="font-medium text-base text-foreground">
          Reproduce from a report
        </DialogPrimitive.Title>
        <p className="text-muted-foreground text-xs">
          Open a report.html published from holaOS. Its test plan is copied
          into a new evaluation that runs on a model on this machine, so you
          can compare your numbers with theirs.
        </p>
      </div>

      <Field label="Report file">
        <input
          accept=".html,.htm,text/html"
          className="hidden"
          onChange={(event) => {
            setFile(event.target.files?.[0] ?? null);
            setError(null);
            event.target.value = "";
          }}
          ref={fileInputRef}
          type="file"
        />
        <button
          className="flex items-center gap-2.5 rounded-lg border border-border border-dashed px-3 py-2.5 text-left transition-colors hover:bg-fg-2"
          onClick={() => fileInputRef.current?.click()}
          type="button"
        >
          {file ? (
            <FileText className="size-4 shrink-0 text-muted-foreground" />
          ) : (
            <Upload className="size-4 shrink-0 text-muted-foreground" />
          )}
          <span className="min-w-0 flex-1 truncate text-sm">
            {file ? (
              <span className="text-foreground">{file.name}</span>
            ) : (
              <span className="text-muted-foreground">Choose report.html…</span>
            )}
          </span>
          {file ? (
            <span className="shrink-0 text-muted-foreground text-xs">
              Change
            </span>
          ) : null}
        </button>
      </Field>

      <Field label="Run it on">
        {targetsQuery.isPending ? (
          <p className="flex items-center gap-2 text-muted-foreground text-sm">
            <Loader2 className="size-3.5 animate-spin" />
            Looking for local model servers…
          </p>
        ) : targets.length === 0 ? (
          <p className="rounded-lg border border-border bg-fg-2 px-3 py-2 text-[13px] text-muted-foreground leading-5">
            No local model is running. holaOS finds llama.cpp, Ollama, LM
            Studio and vLLM servers on this machine automatically. Start one,
            then open this again.
          </p>
        ) : (
          <Select
            items={targets.map((target) => ({
              value: targetKey(target),
              label: target.model_id,
            }))}
            onValueChange={(value) =>
              setTargetId(typeof value === "string" ? value : null)
            }
            value={targetId}
          >
            <SelectTrigger className="h-8 w-full bg-transparent text-sm">
              <SelectValue placeholder="Pick a model" />
            </SelectTrigger>
            <SelectContent align="start" className="min-w-55">
              {targets.map((target) => (
                <SelectItem key={targetKey(target)} value={targetKey(target)}>
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">{target.model_id}</span>
                    <span className="truncate text-muted-foreground text-xs">
                      {targetDetail(target)}
                    </span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </Field>

      <Field
        hint="Where you found the report, if it was posted online."
        label="Original post (optional)"
      >
        <Input
          aria-invalid={!sourceUrlValid}
          className="h-8 text-sm"
          onChange={(event) => setSourceUrl(event.target.value)}
          placeholder="https://"
          value={sourceUrl}
        />
      </Field>

      {error ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-1.5 text-[11px] text-destructive">
          {error}
        </div>
      ) : null}

      <div className="flex items-center justify-end gap-2 pt-1">
        <Button
          disabled={busy}
          onClick={onClose}
          size="sm"
          type="button"
          variant="ghost"
        >
          Cancel
        </Button>
        <Button
          disabled={!canImport}
          onClick={() => void submit()}
          size="sm"
          type="button"
        >
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
          Import
        </Button>
      </div>
    </div>
  );
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}
