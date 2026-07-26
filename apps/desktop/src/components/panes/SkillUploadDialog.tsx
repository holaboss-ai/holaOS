import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { useSetAtom } from "jotai";
import { type DragEvent, useEffect, useRef, useState } from "react";
import { overlayOpenCountAtom } from "@/components/layout/shell/overlay-presence";
import { FolderPlus, Loader2, X } from "@/components/ui/icons";
import {
  type ParsedSkillFile,
  parseSkillMarkdown,
} from "@/lib/skillFileImport";
import { cn } from "@/lib/utils";

const ACCEPT = ".md,.markdown,text/markdown";

/**
 * "Upload skill" — the self-serve half of New skill, for a SKILL.md the user
 * already wrote. The file is read here and installed through the same
 * `skills.install` contract the marketplace uses, so an uploaded skill
 * materializes into the workspace exactly like an installed one.
 */
export function SkillUploadDialog({
  open,
  onOpenChange,
  onUpload,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Resolves once the skill is installed; rejects to keep the dialog open. */
  onUpload: (skill: ParsedSkillFile) => Promise<void>;
}) {
  const setOverlayCount = useSetAtom(overlayOpenCountAtom);
  useEffect(() => {
    if (!open) return;
    setOverlayCount((c) => c + 1);
    return () => {
      setOverlayCount((c) => Math.max(0, c - 1));
    };
  }, [open, setOverlayCount]);

  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) {
      setDragging(false);
      setBusy(false);
      setError("");
    }
  }, [open]);

  const accept = async (file: File | undefined) => {
    if (!file || busy) return;
    setError("");
    if (!/\.(md|markdown)$/i.test(file.name)) {
      setError("Upload a .md file — archives aren't supported yet.");
      return;
    }
    const parsed = parseSkillMarkdown(await file.text(), file.name);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setBusy(true);
    try {
      await onUpload(parsed.skill);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't install that skill.");
    } finally {
      setBusy(false);
    }
  };

  const onDrop = (event: DragEvent<HTMLButtonElement>) => {
    event.preventDefault();
    setDragging(false);
    void accept(event.dataTransfer.files[0]);
  };

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-[90] bg-foreground/20 backdrop-blur-sm ease-emphasized data-open:duration-snappy data-open:animate-in data-open:fade-in-0 data-closed:duration-tap data-closed:animate-out data-closed:fade-out-0" />
        <DialogPrimitive.Popup className="fixed top-[18%] left-1/2 z-[100] w-[440px] -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-popover shadow-2xl outline-none ease-emphasized data-open:duration-snappy data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:duration-tap data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95">
          <div className="relative flex flex-col px-6 pt-6 pb-6">
            <DialogPrimitive.Close
              aria-label="Close"
              className="absolute top-3 right-3 grid size-7 place-items-center rounded-md text-foreground/50 transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
            >
              <X className="size-3.5" />
            </DialogPrimitive.Close>

            <DialogPrimitive.Title className="font-semibold text-base text-foreground">
              Upload skill
            </DialogPrimitive.Title>

            <input
              accept={ACCEPT}
              className="hidden"
              onChange={(event) => {
                void accept(event.target.files?.[0]);
                event.target.value = "";
              }}
              ref={inputRef}
              type="file"
            />

            <button
              className={cn(
                "mt-5 flex w-full flex-col items-center justify-center gap-2.5 rounded-xl border border-dashed py-9 transition-colors",
                dragging
                  ? "border-primary bg-primary/[0.06]"
                  : "border-border hover:bg-foreground/[0.03]",
                busy && "pointer-events-none opacity-60",
              )}
              onClick={() => inputRef.current?.click()}
              onDragLeave={() => setDragging(false)}
              onDragOver={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDrop={onDrop}
              type="button"
            >
              {busy ? (
                <Loader2 className="size-6 animate-spin text-muted-foreground" />
              ) : (
                <FolderPlus className="size-6 text-muted-foreground" />
              )}
              <span className="font-medium text-foreground text-sm">
                {busy ? "Installing…" : "Drag and drop or click to upload"}
              </span>
            </button>

            <p className="mt-5 font-medium text-foreground text-xs">
              File requirements
            </p>
            <ul className="mt-1.5 flex list-disc flex-col gap-1 pl-4 text-muted-foreground text-xs">
              <li>A .md file whose YAML frontmatter sets a name and description</li>
              <li>The body is the instruction your agent follows</li>
            </ul>

            {error ? (
              <p className="mt-4 text-destructive text-xs">{error}</p>
            ) : null}
          </div>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
