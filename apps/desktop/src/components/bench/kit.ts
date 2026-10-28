import {
  type RunRecordView,
  TASK_INFO,
  engineLabel,
  explainReason,
  formatMs,
  formatTps,
  hardwareLabel,
  readingComparison,
  speedResult,
  taskResults,
  topReason,
  wasBusy,
} from "./record";

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function resultsCsv(record: RunRecordView): string {
  const header = ["task", "kind", "status", "passed", "samples", "decode_tps", "ttft_ms", "engine_decode_tps", "vram_bytes", "cpu_offload"];
  const rows = record.results.map((result) =>
    result.kind === "speed"
      ? [result.task, "speed", result.status, "", "", result.metrics.decode_tps, result.metrics.ttft_ms, result.metrics.engine_decode_tps, result.metrics.vram_bytes, result.metrics.cpu_offload]
      : [result.task, "task", result.status, result.passed, result.samples, "", "", "", "", ""],
  );
  return `${[header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

function taskSummary(record: RunRecordView): string {
  return taskResults(record)
    .map((task) => {
      const info = TASK_INFO[task.task];
      const name = info?.short ?? task.task;
      return task.status === "unsupported" ? `${name} n/a` : `${name} ${task.passed}/${task.samples}`;
    })
    .join(" · ");
}

function timestamp(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

function capabilityPost(record: RunRecordView): string {
  const lines = taskResults(record).map((task) => {
    const info = TASK_INFO[task.task];
    const title = info?.title ?? task.task;
    if (task.status === "unsupported") {
      return `${title}: not supported by this Ollama build`;
    }
    const reason = task.passed < task.samples ? topReason(task) : null;
    return `${title}: ${task.passed}/${task.samples}${reason ? ` (${explainReason(reason)})` : ""}`;
  });
  return `Capability, 3 tries each, graded by code:\n${lines.join("\n")}`;
}

/** Ready-to-post copy for a creator; every number comes from the Run Record. */
export function narrationScript(record: RunRecordView, url: string): string {
  const shallow = speedResult(record, "speed@0");
  const deep = speedResult(record, "speed@8k");
  const reading = readingComparison(shallow?.decode_tps);
  const hardware = hardwareLabel(record);
  const busy = wasBusy(record);
  const lines = [
    `# ${record.subject.name} on ${hardware}`,
    "",
  ];
  if (busy !== null) {
    lines.push(`> Other apps used ${busy}% of the CPU during this run, so speed is likely low. Run again on an idle machine before posting.`, "");
  }
  lines.push(
    "## Post",
    "",
    shareText(record),
    url,
    "",
    "## Thread",
    "",
    `1/ ${record.subject.name} (${record.subject.quant}) running locally on ${hardware} with ${engineLabel(record)}: ${formatTps(shallow?.decode_tps)} tokens a second, first token in ${formatMs(shallow?.ttft_ms)}.${reading ? ` That is about ${Math.round(reading.wordsPerSecond)} words a second.` : ""}`,
    "",
    `2/ With 8K tokens already in the context it still does ${formatTps(deep?.decode_tps)} tok/s, and the first token arrives in ${formatMs(deep?.ttft_ms)}.${shallow?.cpu_offload ? " Part of the model ran on the CPU because it did not fit in GPU memory." : ""}`,
    "",
    `3/ ${capabilityPost(record)}`,
    "",
    `4/ Same suite (${record.suite.id}@${record.suite.version}) on any machine, so results compare like for like. Full run record: ${url}`,
  );
  const highlights = record.artifacts.highlights;
  if (highlights.length > 0) {
    lines.push("", "## Voice-over", "");
    for (const h of highlights) {
      const name = TASK_INFO[h.task ?? ""]?.title ?? (h.task === "speed@0" ? "Speed" : h.task === "speed@8k" ? "Speed at 8K" : h.task ?? "");
      const what = h.label === "first_token" ? "starts" : h.label === "error" ? "hits an error" : "done";
      lines.push(`- ${timestamp(h.t)} ${name} ${what}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function shareText(record: RunRecordView): string {
  const shallow = speedResult(record, "speed@0");
  const deep = speedResult(record, "speed@8k");
  return `${record.subject.name} on my ${hardwareLabel(record)}: ${formatTps(shallow?.decode_tps)} tok/s, first token in ${formatMs(shallow?.ttft_ms)}, ${formatTps(deep?.decode_tps)} tok/s with 8K of context. ${taskSummary(record)}. Measured locally with holaOS.`;
}

export function kitFileName(record: RunRecordView): string {
  return `${record.subject.id}-${record.started_at.slice(0, 10)}-holaos-kit.zip`;
}

/** One coding run's task results, for the single sentence a script adds when the model has a local coding run. */
export interface CodingScene {
  tasks: Array<{ task: string; status: string; passed: number; samples: number }>;
}

const CODING_TASK_NAMES: Record<string, { en: string; zh: string }> = {
  "fix-pagination": { en: "the failing test", zh: "修复失败的测试" },
  "parse-duration": { en: "the spec implementation", zh: "按规格实现函数" },
  "csv-export": { en: "the CLI option", zh: "给命令行加选项" },
  "checkout-bug": { en: "the reported bug", zh: "修复用户报告的 bug" },
  "calc-power": { en: "the parser change", zh: "修改解析器" },
};

/** The machine as you'd say it: "Apple M4 Max with 64 GB". */
function spokenHardware(record: RunRecordView, lang: "en" | "zh"): string {
  const [machine, memory] = hardwareLabel(record).split(" · ");
  if (!memory) {
    return machine ?? "";
  }
  return lang === "en" ? `${machine} with ${memory.replace(/ RAM$/, " of memory")}` : `${machine}（${memory.replace(/ RAM$/, " 内存")}）`;
}

function spokenMs(ms: number | undefined, lang: "en" | "zh"): string {
  if (ms === undefined) {
    return lang === "en" ? "an unknown time" : "未知";
  }
  if (ms >= 1000) {
    const seconds = (ms / 1000).toFixed(1);
    return lang === "en" ? `${seconds} seconds` : `${seconds} 秒`;
  }
  return lang === "en" ? `${Math.round(ms)} milliseconds` : `${Math.round(ms)} 毫秒`;
}

function joinList(items: string[], lang: "en" | "zh"): string {
  if (lang === "zh") {
    return items.join("、");
  }
  return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function capabilityLine(record: RunRecordView, lang: "en" | "zh"): string[] {
  const names: Record<string, { en: string; zh: string }> = {
    "code-intervals": { en: "code", zh: "代码" },
    "tool-flight": { en: "tool calling", zh: "工具调用" },
    "needle-8k": { en: "long-context recall", zh: "长文找针" },
  };
  const tasks = taskResults(record);
  const scored = tasks.filter((task) => task.status !== "unsupported");
  const unsupported = tasks.filter((task) => task.status === "unsupported");
  const scores = scored.map((task) => `${names[task.task]?.[lang] ?? task.task} ${task.passed}/${task.samples}`);
  const lines =
    lang === "en"
      ? [`Three tasks, three tries each, graded by code: ${joinList(scores, "en")}.`]
      : [`然后是三道题，每道跑三次，由程序判分：${joinList(scores, "zh")}。`];
  for (const task of unsupported) {
    const name = names[task.task]?.[lang] ?? task.task;
    lines.push(
      lang === "en"
        ? `${name[0]?.toUpperCase()}${name.slice(1)} isn't supported by its Ollama build, so it didn't run. That isn't a fail.`
        : `${name}这一项，这个模型的 Ollama 版本不支持，所以没有跑，这不算失败。`,
    );
  }
  const missed = scored.find((task) => task.passed < task.samples && topReason(task));
  const reason = missed ? topReason(missed) : null;
  if (missed && reason && lang === "en") {
    lines.push(`One miss, on ${names[missed.task]?.en ?? missed.task}: ${explainReason(reason)}.`);
  }
  return lines;
}

function codingLine(coding: CodingScene | null, lang: "en" | "zh"): string | null {
  if (!coding || coding.tasks.every((task) => task.status === "unsupported")) {
    return null;
  }
  const always = coding.tasks
    .filter((task) => task.status === "ok" && task.samples > 0 && task.passed === task.samples)
    .map((task) => CODING_TASK_NAMES[task.task]?.[lang] ?? task.task);
  if (lang === "en") {
    return always.length > 0
      ? `In the coding scenario, five small Python jobs as an agent, it solved ${joinList(always, "en")} every time.`
      : "In the coding scenario, five small Python jobs as an agent, it solved none of the five every time.";
  }
  return always.length > 0
    ? `在 holaOS 的编程场景测试里（五个小型 Python 任务，以 agent 方式完成），它每次都做对了：${joinList(always, "zh")}。`
    : "在 holaOS 的编程场景测试里（五个小型 Python 任务，以 agent 方式完成），五个任务都没能每次做对。";
}

/** A script to read aloud in about 50 seconds, from fixed sentences over the Run Record, so the numbers are the measured ones. */
export function readAloudScript(record: RunRecordView, lang: "en" | "zh", url: string | null, coding: CodingScene | null = null): string {
  const shallow = speedResult(record, "speed@0");
  const deep = speedResult(record, "speed@8k");
  const hardware = hardwareLabel(record);
  const spoken = spokenHardware(record, lang);
  const model = record.subject.name;
  const quant = record.subject.quant;
  const engine = engineLabel(record);
  const suite = `${record.suite.id} ${record.suite.version}`;
  const busy = wasBusy(record);
  const offload = Boolean(shallow?.cpu_offload || deep?.cpu_offload);
  const coded = codingLine(coding, lang);
  if (lang === "en") {
    return [
      `# ${model} on ${hardware}: script`,
      "",
      `_About 50 seconds read aloud. Every number comes from the run record. ${url ? `Run: ${url}` : "Not published yet."}_`,
      "",
      `**Hook.** How fast does ${model} run on my ${spoken}? I ran holaOS's benchmark to find out.`,
      "",
      `**Setup.** ${model} at ${quant}, served by ${engine}. The suite is ${suite}: the same test on every machine.`,
      "",
      `**Speed.** With an empty context: ${formatTps(shallow?.decode_tps)} tokens per second, first token in ${spokenMs(shallow?.ttft_ms, "en")}. With 8,000 tokens in the context: ${formatTps(deep?.decode_tps)} tokens per second.${offload ? " Part of the model ran on the CPU; it didn't fit in GPU memory." : ""}`,
      "",
      `**Capability.** ${capabilityLine(record, "en").join(" ")}${coded ? ` ${coded}` : ""}`,
      "",
      `**Caveat.** ${busy !== null ? `Other apps were using ${busy}% of the CPU during this run, so these speeds are likely low.` : "One run on one machine: yours will vary with your hardware and what else is running."}`,
      "",
      `**More.** ${url ? "The full run and its raw record are linked below." : "The full run is on HolaHub."} How the test works: hub.holaos.ai/methodology.`,
      "",
    ].join("\n");
  }
  return [
    `# ${model} 在 ${hardware} 上的实测：口播稿`,
    "",
    `_朗读约 50 秒。所有数字都来自运行记录。${url ? `运行页：${url}` : "尚未发布。"}_`,
    "",
    `**开场。** ${model} 在我的 ${spoken}${spoken.endsWith("）") ? "" : " "}上能跑多快？我用 holaOS 的测试实测了一遍。`,
    "",
    `**配置。** ${model} 的 ${quant} 版本，用 ${engine} 运行。测试套件是 ${suite}，每台机器跑的都是同一套题。`,
    "",
    `**速度。** 空上下文时，每秒生成 ${formatTps(shallow?.decode_tps)} 个 token，首个 token 用时 ${spokenMs(shallow?.ttft_ms, "zh")}。上下文里先放进 8000 个 token 之后，每秒 ${formatTps(deep?.decode_tps)} 个 token。${offload ? "模型有一部分跑在 CPU 上，因为显存放不下。" : ""}`,
    "",
    `**能力。** ${capabilityLine(record, "zh").join("")}${coded ?? ""}`,
    "",
    `**说明。** ${busy !== null ? `这次运行时，其他程序占用了 ${busy}% 的 CPU，速度可能偏低。` : "这是一台机器上的一次运行，你的结果会因硬件和后台程序而不同。"}`,
    "",
    `**更多。** ${url ? "完整的运行记录见下方链接，" : "完整的运行记录在 HolaHub 上，"}测试方法见 hub.holaos.ai/methodology。`,
    "",
  ].join("\n");
}

/** What each file in the kit is. */
export function kitReadme(record: RunRecordView, files: string[], url: string | null): string {
  const describe: Record<string, string> = {
    "benchmark-card.png": "Share card: decode speed, first token, memory. 2400x1350.",
    "capability-card.png": "Share card: the three tasks, x/3 each. 2400x1350.",
    "recording-16x9.mp4": "The run, cut to the speed moments, with the measured numbers on screen. 1920x1080 for YouTube and X.",
    "recording-9x16.mp4": "The same cut laid out for a phone. 1080x1920 for Shorts, Reels and TikTok.",
    "run-record.json": "The full Run Record: every number, the machine and the settings.",
    "results.csv": "One row per task, for a spreadsheet.",
    "highlights.json": "When each moment happens in the full recording, in seconds.",
    "script.en.md": "A script to read aloud in about 50 seconds, in English.",
    "script.zh.md": "The same script in Chinese.",
    "post.md": "Ready-to-post copy: a post, a thread and voice-over timestamps.",
  };
  const lines = [
    `holaOS creator kit: ${record.subject.name} (${record.subject.quant}) on ${hardwareLabel(record)}`,
    `Suite: ${record.suite.id}@${record.suite.version}`,
    `Run: ${url ?? "not published"}`,
    `Measured: ${record.started_at}`,
    "",
    "Files:",
  ];
  for (const name of files) {
    const known = describe[name] ?? (name.startsWith("recording.") ? "The full, uncut recording of the run window." : "");
    lines.push(`- ${name}${known ? `: ${known}` : ""}`);
  }
  lines.push("", "Every number in this kit is the measured one. How the test works: https://hub.holaos.ai/methodology", "");
  return lines.join("\n");
}
