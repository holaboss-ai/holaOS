import {
  type RunRecordView,
  type TaskResult,
  TASK_INFO,
  engineLabel,
  explainReason,
  formatGb,
  formatMs,
  formatTps,
  hardwareLabel,
  readingComparison,
  speedResult,
  taskResults,
  topReason,
  busyText,
  wasBusy,
} from "./record";

/** Everything a card needs besides the record; cards are rendered offscreen at 1200×675 CSS px, 2× pixels. */
export interface CardAssets {
  url: string;
  /** @font-face rules for "Card Sans" and "Card Mono"; empty falls back to system fonts. */
  fontCss: string;
  /** Inline SVG of a QR code for `url`; empty hides it. */
  qrSvg: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const LOGO_SVG = `<svg viewBox="10 10 130 131" width="26" height="26" aria-hidden="true"><path fill="#FF6421" d="M114.818 123.908L104.46 113.55C103.486 112.665 102.07 112.488 101.007 113.196C94.279 117.446 86.0459 120.721 75.334 120.721C50.4575 120.721 29.2107 100.979 29.2107 75.1289C29.2107 54.7674 44.4376 35.4682 65.6844 29.9795C67.1894 29.6253 68.2517 28.4745 68.2517 26.5268V12.7164C68.2517 10.9458 66.8352 9.70645 65.0647 10.0606C33.8141 15.1952 10 41.4882 10 75.1289C10 108.77 34.8765 140.729 75.2454 140.729C88.5247 140.729 100.565 137.276 114.375 128.246C115.791 127.272 116.146 125.147 114.818 123.908Z"/><path fill="#FF6421" d="M84.3639 29.8909C95.8726 31.9271 115.172 41.6652 120.483 65.1252C120.926 66.8958 122.165 67.9581 123.936 67.9581H137.215C139.163 67.9581 140.225 66.4532 139.96 64.5055C136.33 41.134 116.677 14.664 85.0721 10.0606C83.3015 9.79497 81.4424 10.7688 81.4424 12.8049V26.5268C81.4424 28.4745 82.5048 29.5368 84.3639 29.8909Z"/><path fill="#FF6421" d="M137.215 81.4145H124.29C122.608 81.4145 121.192 82.2112 120.749 84.0703C119.687 89.2935 117.651 94.2511 113.932 99.9169C113.136 101.333 113.224 102.927 114.375 104.078L124.998 114.613C126.149 115.675 128.097 115.675 129.159 114.347C134.382 107.53 138.632 97.7037 139.871 84.8671C139.96 83.0965 138.897 81.4145 137.215 81.4145Z"/></svg>`;

const CHIP_SVG = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2.5"/><rect x="9.5" y="9.5" width="5" height="5" rx="1"/><path d="M9 2.5v3M15 2.5v3M9 18.5v3M15 18.5v3M2.5 9h3M2.5 15h3M18.5 9h3M18.5 15h3"/></svg>`;

const BASE_CSS = `
  :root {
    --ink: #1c1815; --ink-80: rgba(28,24,21,.8); --ink-60: rgba(28,24,21,.6); --ink-45: rgba(28,24,21,.45);
    --ink-20: rgba(28,24,21,.2); --hair: rgba(28,24,21,.09); --paper: #fbfbfa; --panel: #ffffff;
    --orange: #ff6421; --green: #3f9f6e; --green-soft: #e3f2ea; --amber-ink: #9a5a12; --amber-soft: #fdf1e2;
    --sans: "Card Sans", "Inter", -apple-system, "Segoe UI", sans-serif;
    --mono: "Card Mono", "SF Mono", Menlo, monospace;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { width: 1200px; height: 675px; overflow: hidden; }
  body {
    position: relative; font-family: var(--sans); color: var(--ink); background: var(--paper);
    font-optical-sizing: auto; font-feature-settings: "cv11", "ss03"; -webkit-font-smoothing: antialiased;
    padding: 44px 56px 36px; display: flex; flex-direction: column;
  }
  body::before {
    content: ""; position: absolute; inset: 0; pointer-events: none;
    background-image: radial-gradient(var(--ink-20) 0.9px, transparent 0.9px); background-size: 22px 22px;
    -webkit-mask-image: radial-gradient(120% 90% at 100% 0%, #000 0%, transparent 62%); opacity: .55;
  }
  body > * { position: relative; }
  .top { display: flex; align-items: center; justify-content: space-between; }
  .brand { display: flex; align-items: center; gap: 10px; font-size: 19px; font-weight: 620; letter-spacing: -0.01em; }
  .brand .product { color: var(--ink-45); font-weight: 520; }
  .suite { font-family: var(--mono); font-size: 14px; font-weight: 500; color: var(--ink-45); }
  .label { font-family: var(--mono); font-size: 12.5px; font-weight: 500; letter-spacing: .09em; text-transform: uppercase; color: var(--ink-45); }
  .model { font-size: var(--model-size, 54px); font-weight: 650; letter-spacing: -0.035em; line-height: 1.02; overflow-wrap: anywhere; }
  .meta { margin-top: 12px; display: flex; gap: 8px; flex-wrap: wrap; }
  .tag { font-family: var(--mono); font-size: 14px; font-weight: 500; color: var(--ink-60); padding: 5px 10px;
    border-radius: 999px; background: var(--panel); box-shadow: 0 0 0 1px var(--hair), 0 1px 2px rgba(28,24,21,.04); }
  .panel { background: var(--panel); border-radius: 18px;
    box-shadow: 0 0 0 1px var(--hair), 0 1px 2px rgba(28,24,21,.04), 0 10px 30px -12px rgba(28,24,21,.12); }
  .footer { margin-top: auto; display: flex; align-items: center; justify-content: space-between; gap: 24px;
    padding-top: 18px; border-top: 1px solid var(--hair); }
  .machine { display: flex; align-items: center; gap: 10px; font-size: 17px; font-weight: 560; color: var(--ink-80); }
  .machine svg { color: var(--ink-45); }
  .machine .engine { color: var(--ink-45); font-weight: 500; }
  .verify { display: flex; align-items: center; gap: 14px; text-align: right; }
  .verify .host { font-family: var(--mono); font-size: 13px; color: var(--ink-60); }
  .verify .hint { font-size: 13px; color: var(--ink-45); margin-top: 3px; }
  .qr { width: 56px; height: 56px; padding: 5px; border-radius: 10px; background: var(--panel); box-shadow: 0 0 0 1px var(--hair); }
  .qr svg { width: 100%; height: 100%; display: block; }
  .num { font-variant-numeric: tabular-nums; }
  .dots { display: inline-flex; gap: 6px; }
  .dot { width: 14px; height: 14px; border-radius: 999px; box-shadow: inset 0 0 0 1.75px var(--ink-20); }
  .dot.on { background: var(--green); box-shadow: none; }
  .busy { display: inline-flex; align-items: center; gap: 8px; padding: 6px 12px; border-radius: 999px;
    background: var(--amber-soft); color: var(--amber-ink); font-size: 14px; font-weight: 560; }
`;

function shell(title: string, assets: CardAssets, css: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${assets.fontCss}${BASE_CSS}${css}</style></head><body>${body}</body></html>`;
}

function header(record: RunRecordView, label: string): string {
  return `<div class="top">
    <div class="brand">${LOGO_SVG}<span>holaOS</span><span class="product">${escapeHtml(label)}</span></div>
    <div class="suite">${escapeHtml(`${record.suite.id}@${record.suite.version}`)}</div>
  </div>`;
}

export function modelFontSize(name: string, max: number): number {
  return Math.max(34, Math.min(max, Math.round((max * 12) / Math.max(name.length, 1))));
}

function modelBlock(record: RunRecordView, maxSize: number): string {
  const tags = [record.subject.vendor, record.subject.quant, engineLabel(record)].filter(Boolean) as string[];
  return `<div class="model" style="--model-size: ${modelFontSize(record.subject.name, maxSize)}px">${escapeHtml(record.subject.name)}</div>
  <div class="meta">${tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}</div>`;
}

function footer(record: RunRecordView, assets: CardAssets): string {
  const host = (() => {
    try {
      return new URL(assets.url).host;
    } catch {
      return "";
    }
  })();
  const verify = assets.qrSvg
    ? `<div class="verify"><div><div class="host">${escapeHtml(host)}</div><div class="hint">Scan for the full run record</div></div><div class="qr">${assets.qrSvg}</div></div>`
    : `<div class="verify"><div class="host">${escapeHtml(assets.url.replace(/^https?:\/\//, ""))}</div></div>`;
  return `<div class="footer">
    <div class="machine">${CHIP_SVG}<span>${escapeHtml(hardwareLabel(record))}</span><span class="engine">· ${escapeHtml(record.started_at.slice(0, 10))}</span></div>
    ${verify}
  </div>`;
}

function dots(task: TaskResult): string {
  return `<span class="dots">${Array.from({ length: task.samples }, (_, i) => `<span class="dot${i < task.passed ? " on" : ""}"></span>`).join("")}</span>`;
}

function taskScore(task: TaskResult): string {
  if (task.status === "unsupported") {
    return `<span class="na">Not supported on Ollama</span>`;
  }
  if (task.status === "error") {
    return `<span class="na">Did not run</span>`;
  }
  return `${dots(task)}<span class="score num">${task.passed}/${task.samples}</span>`;
}

function busyNote(record: RunRecordView): string {
  const busy = wasBusy(record);
  return busy === null ? "" : `<span class="busy">${busyText(busy)}</span>`;
}

export function benchmarkCardHtml(record: RunRecordView, assets: CardAssets): string {
  const shallow = speedResult(record, "speed@0");
  const deep = speedResult(record, "speed@8k");
  const offload = Boolean(shallow?.cpu_offload || deep?.cpu_offload);
  const reading = readingComparison(shallow?.decode_tps);
  const css = `
    .main { margin-top: 30px; flex: 1; display: grid; grid-template-columns: 1fr 380px; gap: 44px; min-height: 0; padding-bottom: 26px; }
    .left { display: flex; flex-direction: column; min-width: 0; }
    .hero { margin-top: auto; }
    .hero .value { display: flex; align-items: baseline; gap: 14px; margin-top: 8px; }
    .hero .big { font-size: 188px; font-weight: 700; letter-spacing: -0.055em; line-height: .8; }
    .hero .unit { font-size: 36px; font-weight: 600; color: var(--orange); letter-spacing: -0.02em; }
    .hero .sub { margin-top: 18px; font-size: 19px; color: var(--ink-60); min-height: 31px; display: flex; align-items: center; }
    .hero .sub b { color: var(--ink); font-weight: 620; }
    .side { display: flex; flex-direction: column; padding: 14px 24px 8px; }
    .group { flex: 1; display: flex; flex-direction: column; }
    .group + .group { border-top: 1px solid var(--hair); margin: 0 -24px; padding: 14px 24px 0; }
    .side .section { padding-bottom: 2px; }
    .row { flex: 1; display: flex; align-items: center; justify-content: space-between; gap: 12px; border-top: 1px solid var(--hair); }
    .section + .row { border-top: 0; }
    .row .k { font-size: 15.5px; color: var(--ink-60); }
    .row .v { font-size: 22px; font-weight: 640; letter-spacing: -0.015em; white-space: nowrap; }
    .row .v small { font-size: 14px; font-weight: 560; color: var(--ink-45); margin-left: 4px; }
    .row .warn { font-size: 12.5px; font-weight: 600; color: var(--amber-ink); background: var(--amber-soft); padding: 3px 8px; border-radius: 999px; margin-left: 8px; vertical-align: 3px; }
    .row .result { display: flex; align-items: center; gap: 10px; }
    .row .score { font-size: 20px; font-weight: 660; min-width: 34px; text-align: right; }
    .row .na { font-size: 13.5px; color: var(--ink-45); }
  `;
  const caps = taskResults(record)
    .map((task) => {
      const info = TASK_INFO[task.task] ?? { short: task.task, title: task.task, what: "" };
      return `<div class="row"><span class="k">${escapeHtml(info.title)}</span><span class="result">${taskScore(task)}</span></div>`;
    })
    .join("");
  const sub = busyNote(record) ||
    (reading ? `<span>≈ <b>${Math.round(reading.wordsPerSecond)} words a second</b>, ${Math.round(reading.timesReading)}× faster than you read</span>` : "");
  const body = `${header(record, "Bench")}
  <div class="main">
    <div class="left">
      ${modelBlock(record, 56)}
      <div class="hero">
        <div class="label">Decode speed</div>
        <div class="value"><span class="big">${escapeHtml(formatTps(shallow?.decode_tps))}</span><span class="unit">tok/s</span></div>
        <div class="sub">${sub}</div>
      </div>
    </div>
    <div class="side panel">
      <div class="group">
        <div class="section label">Speed</div>
        <div class="row"><span class="k">First token</span><span class="v num">${escapeHtml(formatMs(shallow?.ttft_ms))}</span></div>
        <div class="row"><span class="k">With 8K of context</span><span class="v num">${escapeHtml(formatTps(deep?.decode_tps))}<small>tok/s</small></span></div>
        <div class="row"><span class="k">Memory</span><span class="v num">${escapeHtml(formatGb(shallow?.vram_bytes))}${offload ? '<span class="warn">Partly on CPU</span>' : "<small>on GPU</small>"}</span></div>
      </div>
      <div class="group">
        <div class="section label">Capability · 3 tries each</div>
        ${caps}
      </div>
    </div>
  </div>
  ${footer(record, assets)}`;
  return shell(`${record.subject.name} benchmark`, assets, css, body);
}

export function capabilityCardHtml(record: RunRecordView, assets: CardAssets): string {
  const css = `
    .intro { margin-top: 18px; min-height: 34px; display: flex; align-items: center; justify-content: space-between; }
    .rows { margin: 10px 0 20px; padding: 0 26px; }
    .task { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 24px; padding: 15px 0; border-top: 1px solid var(--hair); }
    .task:first-child { border-top: 0; }
    .task .title { font-size: 22px; font-weight: 650; letter-spacing: -0.015em; }
    .task .what { margin-top: 3px; font-size: 15px; color: var(--ink-60); }
    .task .why { margin-top: 8px; display: inline-block; font-family: var(--mono); font-size: 13px; color: var(--ink-80);
      background: #f4f3f1; padding: 5px 10px; border-radius: 8px; box-shadow: inset 0 0 0 1px var(--hair); }
    .task .result { display: flex; align-items: center; gap: 14px; }
    .task .score { font-size: 30px; font-weight: 680; letter-spacing: -0.02em; min-width: 52px; text-align: right; }
    .task .na { font-size: 15px; font-weight: 560; color: var(--ink-45); }
    .dot { width: 16px; height: 16px; }
  `;
  const rows = taskResults(record)
    .map((task) => {
      const info = TASK_INFO[task.task] ?? { title: task.task, short: task.task, what: "" };
      const reason = task.status === "ok" && task.passed < task.samples ? topReason(task) : null;
      const why = reason ? `<div class="why">${escapeHtml(explainReason(reason))}</div>` : "";
      return `<div class="task"><div><div class="title">${escapeHtml(info.title)}</div><div class="what">${escapeHtml(info.what)}</div>${why}</div><div class="result">${taskScore(task)}</div></div>`;
    })
    .join("");
  const busy = busyNote(record);
  const body = `${header(record, "Capability check")}
  <div style="margin-top: 22px">${modelBlock(record, 42)}</div>
  <div class="intro"><span class="label">3 tries each · graded by code, not by a model</span>${busy}</div>
  <div class="rows panel">${rows}</div>
  ${footer(record, assets)}`;
  return shell(`${record.subject.name} capability check`, assets, css, body);
}
