import type { BenchRun, BenchRunSummary, BenchSubject } from "@holaboss/remote-api/contract";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  ArrowUpRight,
  Check,
  Download,
  ExternalLink,
  FolderOpen,
  Globe,
  Loader2,
  Play,
  RotateCw,
  Square,
  TriangleAlert,
  Upload,
  X,
} from "@/components/ui/icons";
import { holabossLogoUrl } from "@/lib/assetPaths";
import { remoteApi } from "@/lib/remoteApiClient";
import { cn } from "@/lib/utils";
import type { BenchPublishResult, BenchWindowContext } from "../../../shared/bench-protocol";
import { cardAssets } from "./cardAssets";
import { benchmarkCardHtml, capabilityCardHtml } from "./cards";
import { type CodingScene, kitFileName, kitReadme, narrationScript, readAloudScript, resultsCsv, shareText } from "./kit";
import {
  type RunRecordView,
  TASK_INFO,
  formatGb,
  formatTps,
  machineSummary,
  readingComparison,
  resultUrl,
  speedResult,
  taskResults,
  busyText,
  wasBusy,
} from "./record";
import { type BenchRecording, startBenchRecording } from "./recording";
import { type BenchProgress, type BenchStep, CODING_SUITE, stepsFromRecord, useBenchRun } from "./useBenchRun";

const BENCH_THEME = "holaos-light";
const FINAL_FRAME_MS = 1500;

interface FinishedRun {
  record: RunRecordView;
  url: string;
  cards: Array<{ name: string; file: string; dataUrl: string }>;
  recordingFile: string | null;
  runDir: string;
  /** Loaded from disk rather than just run in this window. */
  past: boolean;
}

const CARD_NAMES = ["benchmark-card", "capability-card"] as const;

async function renderCards(record: RunRecordView, runDir: string, url: string) {
  const assets = await cardAssets(url);
  const cards = [];
  for (const name of CARD_NAMES) {
    const html = name === "benchmark-card" ? benchmarkCardHtml(record, assets) : capabilityCardHtml(record, assets);
    cards.push({ name, ...(await window.electronAPI.bench.renderCard(runDir, name, html)) });
  }
  return cards;
}

function runTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function subjectFrom(context: BenchWindowContext | null): BenchSubject | null {
  return (context?.subject as BenchSubject | null | undefined) ?? null;
}

/** "Downloads 22.3 GB the first time · Needs 32 GB of memory or more", from the optional hints in a model's config. */
function sizeHint(context: BenchWindowContext | null): string | null {
  const subject = context?.subject ?? {};
  const download = typeof subject.download_bytes === "number" ? subject.download_bytes : null;
  const memory = typeof subject.min_memory_gb === "number" ? subject.min_memory_gb : null;
  const parts = [
    download ? `Downloads ${formatGb(download)} the first time` : null,
    memory && memory > 8 ? `Needs ${memory} GB of memory or more` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : null;
}

function Label({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={cn("font-mono text-[11px] text-muted-foreground uppercase tracking-[0.09em]", className)}>{children}</span>;
}

function Dots({ passed, samples }: { passed: number; samples: number }) {
  return (
    <span className="inline-flex gap-1">
      {Array.from({ length: samples }, (_, index) => (
        <span
          className={cn("size-2 rounded-full", index < passed ? "bg-success" : "ring-[1.5px] ring-foreground/20 ring-inset")}
          key={index}
        />
      ))}
    </span>
  );
}

function StepRow({ step, current }: { step: BenchStep; current: boolean }) {
  const value =
    step.kind === "speed" && step.decodeTps !== undefined ? (
      <span className="tabular-nums">
        {formatTps(step.decodeTps)}
        <span className="ml-0.5 text-muted-foreground text-xs">tok/s</span>
      </span>
    ) : step.kind === "task" && step.status === "unsupported" ? (
      <span className="text-muted-foreground text-xs">Not supported</span>
    ) : step.kind === "task" && step.samples !== undefined ? (
      <span className="flex items-center gap-2 tabular-nums">
        <Dots passed={step.passed ?? 0} samples={step.samples} />
        {step.passed ?? 0}/{step.samples}
      </span>
    ) : step.kind === "task" && step.tried ? (
      <span className="text-muted-foreground text-xs tabular-nums">
        {step.passed ?? 0} of {step.tried} passed
      </span>
    ) : null;
  return (
    <li
      className={cn(
        "flex h-10 items-center gap-3 rounded-lg px-3 transition-colors",
        current && "bg-fg-2 ring-1 ring-border",
      )}
    >
      <span className="flex size-4 items-center justify-center">
        {step.state === "running" ? (
          <Loader2 className="size-3.5 animate-spin text-primary" />
        ) : step.state === "done" ? (
          <Check className="size-3.5 text-success" />
        ) : (
          <span className="size-1.5 rounded-full bg-foreground/20" />
        )}
      </span>
      <span className={cn("flex-1 truncate text-sm", step.state === "pending" ? "text-muted-foreground" : "text-foreground")}>
        {step.label}
      </span>
      <span className="font-medium text-foreground text-sm">{value}</span>
    </li>
  );
}

function Sparkline({ values }: { values: number[] }) {
  const width = 340;
  const height = 56;
  if (values.length < 2) {
    return <div style={{ height }} />;
  }
  const max = Math.max(...values) * 1.15;
  const step = width / (values.length - 1);
  const points = values.map((value, index) => [index * step, height - (value / max) * height] as const);
  const line = points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  return (
    <svg aria-hidden="true" className="overflow-visible" height={height} viewBox={`0 0 ${width} ${height}`} width={width}>
      <defs>
        <linearGradient id="bench-rate-fill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="var(--color-primary)" stopOpacity="0.14" />
          <stop offset="100%" stopColor="var(--color-primary)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon fill="url(#bench-rate-fill)" points={`0,${height} ${line} ${width},${height}`} />
      <polyline fill="none" points={line} stroke="var(--color-primary)" strokeLinejoin="round" strokeWidth="2" />
    </svg>
  );
}

function HeroNumber({ value, label, sub }: { value: string; label: string; sub?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-1">
      <Label>{label}</Label>
      <span className="flex items-baseline gap-2">
        <span className="font-bold text-[104px] text-foreground leading-[0.9] tracking-[-0.05em]">{value}</span>
        <span className="font-semibold text-2xl text-primary tracking-tight">tok/s</span>
      </span>
      {sub ? <span className="mt-1 text-center text-muted-foreground text-sm">{sub}</span> : null}
    </div>
  );
}

function PullBar({ pull }: { pull: NonNullable<BenchProgress["pull"]> }) {
  const pct = pull.total ? Math.min(100, ((pull.completed ?? 0) / pull.total) * 100) : 0;
  return (
    <div className="flex w-full flex-col items-center gap-3">
      <Label>Downloading the model</Label>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-foreground/[0.06]">
        <div className="h-full rounded-full bg-primary transition-[width] duration-300" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-muted-foreground text-xs tabular-nums">
        {pull.total ? `${formatGb(pull.completed ?? 0)} of ${formatGb(pull.total)}` : pull.status}
      </span>
    </div>
  );
}

function CenterLive({ run, progress }: { run: BenchRun; progress: BenchProgress }) {
  const step = progress.steps.find((entry) => entry.id === progress.currentStep);
  if (run.phase === "pulling" && progress.pull) {
    return <PullBar pull={progress.pull} />;
  }
  if (run.phase !== "running" || !step) {
    const label = run.phase === "starting" ? "Starting Ollama" : run.phase === "finishing" ? "Writing results" : "Checking your machine";
    return (
      <div className="flex items-center gap-2 text-muted-foreground text-sm">
        <Loader2 className="size-4 animate-spin" />
        {label}
      </div>
    );
  }
  if (run.suite === CODING_SUITE && step.kind === "task") {
    return <CodingLive progress={progress} step={step} />;
  }
  const isTask = step.kind === "task";
  return (
    <div className="flex min-h-0 w-full flex-1 flex-col items-center gap-4">
      {isTask ? (
        <div className="flex flex-col items-center gap-2">
          <Label>{TASK_INFO[step.id]?.title ?? step.label}</Label>
          <span className="max-w-[300px] text-center text-muted-foreground text-sm">{TASK_INFO[step.id]?.what}</span>
          <span className="mt-1 flex items-center gap-2 text-muted-foreground text-sm">
            <Loader2 className="size-3.5 animate-spin text-primary" />
            Grading, 3 tries
          </span>
        </div>
      ) : progress.liveTps === null ? (
        <div className="flex h-[150px] flex-col items-center justify-center gap-2">
          <Label>{step.label}</Label>
          <span className="flex items-center gap-2 text-muted-foreground text-sm">
            <Loader2 className="size-3.5 animate-spin text-primary" />
            Reading the prompt
          </span>
        </div>
      ) : (
        <>
          <HeroNumber label={step.label} value={progress.liveTps.toFixed(0)} />
          <Sparkline values={progress.rateHistory} />
        </>
      )}
      <div className="relative min-h-0 w-full flex-1 overflow-hidden rounded-xl bg-card ring-1 ring-border">
        <pre className="absolute inset-x-0 bottom-0 whitespace-pre-wrap break-words p-3 font-mono text-[11px] text-muted-foreground leading-4">
          {progress.stream}
        </pre>
        <div className="pointer-events-none absolute inset-x-0 top-0 h-10 bg-gradient-to-b from-card to-transparent" />
      </div>
    </div>
  );
}

const CODING_TASK_INFO: Record<string, { title: string; what: string }> = {
  "fix-pagination": { title: "Fix a failing test", what: "Runs the tests, finds an off-by-one bug and fixes it" },
  "parse-duration": { title: "Implement from a spec", what: "Writes a parser from its docstring, error cases included" },
  "csv-export": { title: "Add a CLI option", what: "Adds CSV output across files and keeps the default table unchanged" },
  "checkout-bug": { title: "Fix a reported bug", what: "Traces a support ticket to two causes in two different files" },
  "calc-power": { title: "Change a parser", what: "Adds ** to an expression parser with Python's precedence rules" },
};

const IS_MAC = /Mac/.test(navigator.userAgent);

function CodingLive({ step, progress }: { step: BenchStep; progress: BenchProgress }) {
  const info = CODING_TASK_INFO[step.id];
  return (
    <div className="flex min-h-0 w-full flex-1 flex-col items-center gap-4">
      <div className="flex flex-col items-center gap-2">
        <Label>{info?.title ?? step.label}</Label>
        <span className="max-w-[300px] text-center text-muted-foreground text-sm">{info?.what}</span>
        <span className="mt-1 flex items-center gap-2 text-muted-foreground text-sm tabular-nums">
          <Loader2 className="size-3.5 animate-spin text-primary" />
          {progress.attempt ? `Try ${progress.attempt.sample + 1} of 3 · turn ${Math.max(progress.attempt.turn, 1)}` : "Starting"}
        </span>
      </div>
      <ul className="flex w-full flex-col gap-0.5 rounded-xl bg-card p-3 font-mono text-[11px] leading-4 ring-1 ring-border">
        {progress.activity.length > 0 ? (
          progress.activity.map((line, index) => (
            <li className={cn("truncate", line.startsWith("  →") ? "text-foreground" : "text-muted-foreground")} key={`${index}-${line}`}>
              {line}
            </li>
          ))
        ) : (
          <li className="text-muted-foreground">Reading the task</li>
        )}
      </ul>
      <div className="relative min-h-0 w-full flex-1 overflow-hidden rounded-xl bg-card ring-1 ring-border">
        <pre className="absolute inset-x-0 bottom-0 whitespace-pre-wrap break-words p-3 font-mono text-[11px] text-muted-foreground leading-4">
          {progress.stream}
        </pre>
        <div className="pointer-events-none absolute inset-x-0 top-0 h-10 bg-gradient-to-b from-card to-transparent" />
      </div>
    </div>
  );
}

function CodingSummary({ record }: { record: RunRecordView }) {
  const tasks = taskResults(record);
  if (tasks.every((task) => task.status === "unsupported")) {
    return <p className="max-w-[300px] text-center text-muted-foreground text-sm">Ollama reports no tool calling for this model, so the coding scenario could not run. That is not a fail.</p>;
  }
  return (
    <ul className="flex w-full max-w-[320px] flex-col gap-1">
      {tasks.map((task) => (
        <li className="flex items-center justify-between gap-3 rounded-lg px-3 py-1.5 text-sm" key={task.task}>
          <span className="truncate">{CODING_TASK_INFO[task.task]?.title ?? task.task}</span>
          <span className="flex items-center gap-2 font-medium tabular-nums">
            <Dots passed={task.passed} samples={task.samples} />
            {task.passed}/{task.samples}
          </span>
        </li>
      ))}
    </ul>
  );
}

function SuitePicker({ suite, onChange }: { suite: string; onChange: (suite: string) => void }) {
  const options = [
    { id: "suite-standard@1.0", label: "Speed and capability", enabled: true },
    { id: CODING_SUITE, label: "Coding scenario", enabled: IS_MAC },
  ];
  return (
    <div className="flex flex-col items-center gap-1.5">
      <div className="flex rounded-lg bg-card p-0.5 ring-1 ring-border">
        {options.map((option) => (
          <button
            aria-pressed={suite === option.id}
            className={cn(
              "rounded-md px-3 py-1 text-xs transition-colors disabled:opacity-50",
              suite === option.id ? "bg-foreground text-background" : "text-muted-foreground hover:bg-accent",
            )}
            disabled={!option.enabled}
            key={option.id}
            onClick={() => onChange(option.id)}
            type="button"
          >
            {option.label}
          </button>
        ))}
      </div>
      {IS_MAC ? null : <span className="text-muted-foreground text-xs">The coding scenario runs on macOS only for now; it needs a sandbox we haven't shipped for Windows yet.</span>}
    </div>
  );
}

function RunError({ run, onRetry, onUnloadAndRun }: { run: BenchRun; onRetry: () => void; onUnloadAndRun: () => void }) {
  const error = run.error;
  const models = Array.isArray(error?.details?.models)
    ? (error?.details?.models as Array<{ name?: string }>).map((model) => model.name).filter(Boolean)
    : [];
  const downloadUrl = typeof error?.details?.download_url === "string" ? error.details.download_url : null;
  return (
    <div className="flex w-full flex-col items-center gap-4 text-center">
      <TriangleAlert className="size-6 text-warning" />
      <p className="text-foreground text-sm">{error?.message ?? "The benchmark stopped."}</p>
      {models.length > 0 ? <p className="font-mono text-muted-foreground text-xs">{models.join(", ")}</p> : null}
      <div className="flex gap-2">
        {error?.code === "ollama_missing" && downloadUrl ? (
          <Button onClick={() => void window.electronAPI.ui.openExternalUrl(downloadUrl)} size="sm" type="button">
            <ExternalLink className="size-3.5" />
            Download Ollama
          </Button>
        ) : null}
        {error?.code === "user_models_loaded" ? (
          <Button onClick={onUnloadAndRun} size="sm" type="button">
            <Play className="size-3.5" />
            Unload them and run
          </Button>
        ) : (
          <Button onClick={onRetry} size="sm" type="button" variant="outline">
            <RotateCw className="size-3.5" />
            Try again
          </Button>
        )}
      </div>
    </div>
  );
}

/** The subject's newest local coding run, for the one sentence a speed kit's script adds about it. */
async function latestCodingScene(subjectId: string): Promise<CodingScene | null> {
  try {
    const { runs } = await remoteApi.bench.list({ subject_id: subjectId });
    const coding = runs.find((entry) => entry.suite === CODING_SUITE);
    if (!coding) {
      return null;
    }
    const { record } = await remoteApi.bench.record({ run_id: coding.run_id });
    return { tasks: taskResults(record as unknown as RunRecordView) };
  } catch {
    return null;
  }
}

const PUBLISH_REFUSED: Record<Extract<BenchPublishResult, { ok: false }>["reason"], string> = {
  signed_out: "Sign in to holaOS in the main window to publish.",
  not_configured: "Publishing isn't set up in this build.",
};

function FinishedPanel({ finished, runDir, onRunAgain }: { finished: FinishedRun; runDir: string; onRunAgain: () => void }) {
  const coding = finished.record.suite.id === "suite-coding";
  const [busy, setBusy] = useState<"kit" | "share" | "publish" | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [publishedUrl, setPublishedUrl] = useState<string | null>(null);
  const machineBusy = wasBusy(finished.record);
  // The card's QR code and the post both link to the run's page, so it has to exist first.
  const ensurePublished = async (): Promise<string | null> => {
    if (publishedUrl) {
      return publishedUrl;
    }
    const result = await window.electronAPI.bench.publish(runDir);
    if (!result.ok) {
      setNote(PUBLISH_REFUSED[result.reason]);
      return null;
    }
    setPublishedUrl(result.url);
    return result.url;
  };
  const publish = async () => {
    setBusy("publish");
    setNote(null);
    try {
      if (await ensurePublished()) {
        setNote("Published. Anyone with the link can see this run.");
      }
    } catch (error) {
      setNote(error instanceof Error ? error.message : "Could not publish.");
    } finally {
      setBusy(null);
    }
  };
  const exportKit = async () => {
    setBusy("kit");
    setNote(null);
    try {
      const { record } = finished;
      const coding = await latestCodingScene(record.subject.id);
      const files: Array<{ name: string; path?: string; text?: string }> = [
        ...finished.cards.map((card) => ({ name: `${card.name}.png`, path: card.file })),
        ...(finished.recordingFile
          ? [{ name: finished.recordingFile.split(/[\\/]/).pop() ?? "recording.mp4", path: finished.recordingFile }]
          : []),
        { name: "run-record.json", text: `${JSON.stringify(record, null, 2)}\n` },
        { name: "results.csv", text: resultsCsv(record) },
        { name: "highlights.json", text: `${JSON.stringify(record.artifacts.highlights, null, 2)}\n` },
        { name: "script.en.md", text: readAloudScript(record, "en", publishedUrl, coding) },
        { name: "script.zh.md", text: readAloudScript(record, "zh", publishedUrl, coding) },
        { name: "post.md", text: narrationScript(record, finished.url) },
      ];
      files.push({ name: "README.txt", text: kitReadme(record, files.map((file) => file.name), publishedUrl) });
      const { path } = await window.electronAPI.bench.exportKit(runDir, kitFileName(record), files);
      setNote(path ? `Saved ${path.split(/[\\/]/).pop()}` : null);
    } catch (error) {
      setNote(error instanceof Error ? error.message : "Could not export the kit.");
    } finally {
      setBusy(null);
    }
  };
  const share = async () => {
    const card = finished.cards[0];
    if (!card) {
      return;
    }
    setBusy("share");
    setNote(null);
    try {
      const url = await ensurePublished();
      if (!url) {
        return;
      }
      await window.electronAPI.bench.share(runDir, card.file, shareText(finished.record), url);
      setNote("Card copied. Paste it into your post.");
    } catch (error) {
      setNote(error instanceof Error ? error.message : "Could not share.");
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="flex w-full flex-col gap-3">
      {machineBusy !== null ? (
        <div className="flex items-start gap-2 rounded-xl bg-warning/10 p-3 text-xs ring-1 ring-warning/30">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />
          <div className="flex flex-col gap-2">
            <span className="text-foreground">
              {busyText(machineBusy)}, so these numbers are likely low. Close them and run again before you share.
            </span>
            <Button className="self-start" onClick={onRunAgain} size="xs" type="button" variant="outline">
              <RotateCw className="size-3" />
              Run again
            </Button>
          </div>
        </div>
      ) : null}
      {finished.cards.map((card) => (
        <img alt={card.name} className="w-full rounded-lg ring-1 ring-border" key={card.name} src={card.dataUrl} />
      ))}
      <div className="flex flex-wrap gap-2">
        {publishedUrl ? (
          <Button onClick={() => void window.electronAPI.ui.openExternalUrl(publishedUrl)} size="sm" type="button">
            <ArrowUpRight className="size-3.5" />
            View on HolaHub
          </Button>
        ) : (
          <Button disabled={busy !== null} onClick={() => void publish()} size="sm" type="button">
            {busy === "publish" ? <Loader2 className="size-3.5 animate-spin" /> : <Globe className="size-3.5" />}
            Publish to HolaHub
          </Button>
        )}
        {coding ? null : (
          <>
            <Button disabled={busy !== null} onClick={() => void exportKit()} size="sm" type="button" variant="outline">
              {busy === "kit" ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
              Export creator kit
            </Button>
            <Button disabled={busy !== null} onClick={() => void share()} size="sm" type="button" variant="outline">
              {busy === "share" ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
              Share on X
            </Button>
          </>
        )}
        <Button onClick={() => void window.electronAPI.bench.showInFolder(runDir)} size="sm" type="button" variant="ghost">
          <FolderOpen className="size-3.5" />
          Show in Finder
        </Button>
      </div>
      {note ? <p className="text-muted-foreground text-xs">{note}</p> : null}
    </div>
  );
}

export function BenchApp() {
  const [context, setContext] = useState<BenchWindowContext | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [suiteChoice, setSuiteChoice] = useState<string | null>(null);
  const suite = suiteChoice ?? context?.suite ?? "suite-standard@1.0";
  const isCoding = suite === CODING_SUITE;
  const { run, progress, startError, start, cancel } = useBenchRun(suite);
  const recording = useRef<BenchRecording | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const runStatus = useRef<string | null>(null);
  runStatus.current = run?.status ?? null;
  const finalizedRun = useRef<string | null>(null);
  const [recordingError, setRecordingError] = useState<string | null>(null);
  const [finished, setFinished] = useState<FinishedRun | null>(null);
  const [finishing, setFinishing] = useState<string | null>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = BENCH_THEME;
    document.title = "holaOS Bench";
    void window.electronAPI.bench.getContext().then((initial) => {
      setContext(initial);
      setLoaded(true);
    });
    return window.electronAPI.bench.onContext(setContext);
  }, []);

  useEffect(() => {
    if (run?.status !== "running" || recording.current) {
      return;
    }
    setFinished(null);
    setRecordingError(null);
    void startBenchRecording()
      .then((started) => {
        if (runStatus.current !== "running") {
          void started.stop();
          return;
        }
        recording.current = started;
        setIsRecording(true);
      })
      .catch((error: unknown) => {
        setRecordingError(error instanceof Error ? error.message : "Recording is not available.");
      });
  }, [run?.status]);

  const finalize = useCallback(
    async (done: BenchRun) => {
      const active = recording.current;
      recording.current = null;
      setIsRecording(false);
      if (done.status !== "done") {
        await active?.stop().catch(() => undefined);
        return;
      }
      const url = resultUrl(context?.result_base_url ?? "", done.run_id);
      let recordingFile: string | null = null;
      try {
        if (active) {
          setFinishing("Saving the recording");
          await new Promise((resolve) => setTimeout(resolve, FINAL_FRAME_MS));
          const { bytes, extension } = await active.stop();
          recordingFile = (await window.electronAPI.bench.saveRecording(done.run_dir, bytes, extension)).file;
        }
        const { record } = await remoteApi.bench.record({ run_id: done.run_id });
        const view = record as unknown as RunRecordView;
        const coding = view.suite.id === "suite-coding";
        if (!coding) {
          setFinishing("Making the cards");
        }
        const cards = coding ? [] : await renderCards(view, done.run_dir, url);
        const offset = active && progress.runStartedAt ? Math.max(0, (active.startedAt - progress.runStartedAt) / 1000) : 0;
        const { record: final } = await remoteApi.bench.setArtifacts({
          run_id: done.run_id,
          recording: recordingFile ? { file: recordingFile, scored_run: true } : null,
          cards: cards.map((card) => card.file),
          recording_offset_s: offset,
        });
        setFinished({ record: final as unknown as RunRecordView, url, cards, recordingFile, runDir: done.run_dir, past: false });
      } catch (error) {
        setRecordingError(error instanceof Error ? error.message : "Could not finish the results.");
      } finally {
        setFinishing(null);
      }
    },
    [context?.result_base_url, progress.runStartedAt],
  );

  const showPastRun = useCallback(
    async (summary: BenchRunSummary) => {
      setFinishing("Loading the last run");
      try {
        const { record } = await remoteApi.bench.record({ run_id: summary.run_id });
        const view = record as unknown as RunRecordView;
        const url = resultUrl(context?.result_base_url ?? "", summary.run_id);
        // Cards are derived from the record, so an older run shows in the current design.
        const cards = view.suite.id === "suite-coding" ? [] : await renderCards(view, summary.run_dir, url);
        const recording = view.artifacts.recording;
        setFinished({
          record: view,
          url,
          cards,
          recordingFile: recording ? `${summary.run_dir}/${recording.file}` : null,
          runDir: summary.run_dir,
          past: true,
        });
      } catch {
        // nothing to show; the start screen stays
      } finally {
        setFinishing(null);
      }
    },
    [context?.result_base_url],
  );

  const subjectId = subjectFrom(context)?.id ?? null;
  const showRunId = context?.show_run_id ?? null;
  const shownRun = finished?.record.run_id ?? null;
  useEffect(() => {
    if (!loaded || !subjectId || runStatus.current === "running") {
      return;
    }
    let cancelled = false;
    void remoteApi.bench
      .list({ subject_id: subjectId })
      .then(({ runs }) => {
        const target = showRunId
          ? runs.find((entry) => entry.run_id === showRunId)
          : runs.find((entry) => entry.suite === suite);
        if (!cancelled && target && target.run_id !== shownRun) {
          void showPastRun(target);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [loaded, subjectId, showRunId, shownRun, showPastRun, suite]);

  useEffect(() => {
    if (run && run.status !== "running" && finalizedRun.current !== run.run_id) {
      finalizedRun.current = run.run_id;
      void finalize(run);
    }
  }, [run, finalize]);

  const subject = subjectFrom(context);
  const isRunning = run?.status === "running";
  const record = finished?.record ?? null;
  const showingFinished = Boolean(finished) && !isRunning;
  const steps = showingFinished && finished ? stepsFromRecord(finished.record, suite) : progress.steps;
  const machineInfo = showingFinished && finished ? finished.record.runtime.hardware : progress.machine;
  const machine = machineInfo ? machineSummary(machineInfo) : null;
  const engineVersion = showingFinished && finished ? finished.record.runtime.provider.version : progress.engineVersion;
  const finalSpeed = record ? speedResult(record, "speed@0")?.decode_tps : undefined;
  const reading = readingComparison(finalSpeed);
  const busy = record ? wasBusy(record) : null;

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
      <header className="flex h-[52px] shrink-0 items-center gap-2.5 border-border border-b px-5">
        <img alt="" className="size-5" src={holabossLogoUrl} />
        <span className="font-semibold text-[15px] tracking-tight">holaOS</span>
        <span className="text-[15px] text-muted-foreground">Bench</span>
        <span className="ml-2 font-mono text-muted-foreground text-xs">{suite}</span>
        <div className="flex-1" />
        {isRunning && isRecording ? (
          <span className="flex items-center gap-1.5 rounded-full bg-destructive/10 px-2.5 py-1 font-mono text-[11px] text-destructive tracking-[0.08em]">
            <span className="size-1.5 animate-pulse rounded-full bg-destructive" />
            REC
          </span>
        ) : null}
        {isRunning ? (
          <Button onClick={() => void cancel()} size="xs" type="button" variant="ghost">
            <Square className="size-3" />
            Stop
          </Button>
        ) : null}
      </header>

      <main className="grid min-h-0 flex-1 grid-cols-[1fr_405px_1fr]">
        <section className="flex min-h-0 flex-col gap-2 border-border border-r p-4">
          <Label className="px-3 py-1">Suite</Label>
          <ul className="flex flex-col gap-0.5">
            {steps.map((step) => (
              <StepRow current={step.id === progress.currentStep && isRunning} key={step.id} step={step} />
            ))}
          </ul>
          <div className="mt-auto flex flex-col gap-3 px-3">
            {isRunning && progress.cpuBusyPct !== null ? (
              <p className="flex items-start gap-2 rounded-lg bg-warning/10 p-2.5 text-foreground text-xs ring-1 ring-warning/30">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />
                Other programs are using {progress.cpuBusyPct}% of the CPU.{" "}
                {run?.suite === CODING_SUITE
                  ? "Tries will take longer; pass rates don't depend on speed."
                  : "Numbers will likely be low."}
              </p>
            ) : null}
            {machine ? (
              <div className="flex flex-col gap-1">
                <Label>This machine</Label>
                <span className="font-medium text-sm">{machine}</span>
                {engineVersion ? <span className="text-muted-foreground text-xs">Ollama {engineVersion}</span> : null}
              </div>
            ) : null}
          </div>
        </section>

        <section className="flex min-h-0 flex-col items-center gap-5 px-6 py-6">
          {!loaded ? (
            <Loader2 className="mt-24 size-5 animate-spin text-muted-foreground" />
          ) : context?.error || !subject ? (
            <div className="mt-24 flex flex-col items-center gap-3 text-center">
              <X className="size-6 text-muted-foreground" />
              <p className="text-sm">{context?.error ?? "Choose a model from Evaluations → Run benchmark."}</p>
            </div>
          ) : (
            <>
              <div className="flex flex-col items-center gap-2 text-center">
                <h1 className="font-semibold text-[34px] leading-none tracking-[-0.03em]">{subject.name}</h1>
                <div className="flex gap-1.5">
                  {[subject.vendor, subject.quant, "Ollama"].filter(Boolean).map((tag) => (
                    <span className="rounded-full bg-card px-2 py-0.5 font-mono text-[11px] text-muted-foreground ring-1 ring-border" key={tag}>
                      {tag}
                    </span>
                  ))}
                </div>
              </div>
              {!isRunning && subject.suites?.includes(CODING_SUITE) ? (
                <SuitePicker
                  onChange={(next) => {
                    setSuiteChoice(next);
                    setFinished(null);
                  }}
                  suite={suite}
                />
              ) : null}
              {run && isRunning ? (
                <CenterLive progress={progress} run={run} />
              ) : run?.status === "failed" && !finished ? (
                <RunError onRetry={() => void start(subject)} onUnloadAndRun={() => void start(subject, true)} run={run} />
              ) : finishing ? (
                <div className="mt-10 flex items-center gap-2 text-muted-foreground text-sm">
                  <Loader2 className="size-4 animate-spin" />
                  {finishing}
                </div>
              ) : record ? (
                <div className="mt-10 flex flex-col items-center gap-6">
                  {finished?.past ? (
                    <span className="rounded-full bg-card px-2.5 py-1 text-muted-foreground text-xs ring-1 ring-border">
                      Last run · {runTime(record.started_at)}
                    </span>
                  ) : null}
                  {record.suite.id === "suite-coding" ? (
                    <CodingSummary record={record} />
                  ) : (
                    <HeroNumber
                      label="Decode speed"
                      sub={
                        busy !== null
                          ? busyText(busy)
                          : reading
                            ? `≈ ${Math.round(reading.wordsPerSecond)} words a second, ${Math.round(reading.timesReading)}× faster than you read`
                            : undefined
                      }
                      value={formatTps(finalSpeed)}
                    />
                  )}
                  <Button onClick={() => void start(subject)} size="sm" type="button" variant="ghost">
                    <RotateCw className="size-3.5" />
                    Run again
                  </Button>
                </div>
              ) : (
                <div className="mt-14 flex flex-col items-center gap-3">
                  <Button onClick={() => void start(subject)} size="lg" type="button">
                    <Play className="size-4" />
                    Run on this machine
                  </Button>
                  <span className="max-w-[300px] text-center text-muted-foreground text-xs leading-5">
                    {isCoding
                      ? "About 15–25 minutes, depending on the model. The model's code runs in a sandbox with no network. This window is recorded while it runs."
                      : "About 3 minutes once the model is downloaded. This window is recorded while it runs."}
                  </span>
                  {sizeHint(context) ? (
                    <span className="max-w-[300px] text-center font-medium text-muted-foreground text-xs leading-5">{sizeHint(context)}</span>
                  ) : null}
                  {startError ? <span className="text-destructive text-xs">{startError}</span> : null}
                </div>
              )}
              {recordingError ? <p className="text-muted-foreground text-xs">{recordingError}</p> : null}
            </>
          )}
        </section>

        <section className="flex min-h-0 flex-col gap-4 overflow-y-auto border-border border-l p-4">
          {finished && !isRunning ? (
            <FinishedPanel finished={finished} key={finished.record.run_id} onRunAgain={() => subject && void start(subject)} runDir={finished.runDir} />
          ) : (
            <div className="flex flex-col gap-4 px-1">
              <Label>What this measures</Label>
              {isCoding ? (
                <>
                  <span className="text-muted-foreground text-xs leading-5">
                    Five small Python coding jobs. The model works as an agent with holaOS's file tools and a tool that runs the visible tests. Hidden tests decide each try.
                  </span>
                  {Object.values(CODING_TASK_INFO).map((info) => (
                    <div className="flex flex-col gap-1" key={info.title}>
                      <span className="font-medium text-sm">{info.title}</span>
                      <span className="text-muted-foreground text-xs leading-5">{info.what}. Three tries.</span>
                    </div>
                  ))}
                </>
              ) : (
                <>
                  <div className="flex flex-col gap-1">
                    <span className="font-medium text-sm">Speed</span>
                    <span className="text-muted-foreground text-xs leading-5">
                      Tokens per second and time to first token, with an empty context and with 8K tokens of context.
                    </span>
                  </div>
                  {Object.values(TASK_INFO).map((info) => (
                    <div className="flex flex-col gap-1" key={info.title}>
                      <span className="font-medium text-sm">{info.title}</span>
                      <span className="text-muted-foreground text-xs leading-5">{info.what}. Three tries, graded by code.</span>
                    </div>
                  ))}
                </>
              )}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
