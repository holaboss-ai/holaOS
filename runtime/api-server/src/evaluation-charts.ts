import { spawnSync } from "node:child_process";
import fs from "node:fs";

import { escapeHtml } from "./evaluation-markdown.js";

const SURFACE = "#fcfcfb";
const INK = "#0b0b0b";
const INK2 = "#52514e";
const MUTED = "#8a8984";
const GRID = "#e6e5e0";
const SERIES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100"];
const MAX_GROUPED_SERIES = SERIES.length;
const FONT = "Helvetica, Arial, PingFang SC, sans-serif";

export interface BarGroup {
  label: string;
  values: Array<number | null>;
}

export interface BarChartSpec {
  title: string;
  subtitle: string;
  unit: string;
  footnote: string;
  series: string[];
  groups: BarGroup[];
  vmax?: number;
  valueSuffix?: string;
}

export function niceTicks(vmax: number, count = 4): number[] {
  const safeMax = vmax > 0 ? vmax : 1;
  const raw = safeMax / count;
  const magnitude = raw >= 1 ? 10 ** (String(Math.floor(raw)).length - 1) : 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((candidate) => candidate >= raw) ?? raw;
  const ticks: number[] = [];
  for (let index = 0; index <= Math.ceil(safeMax / step); index += 1) {
    ticks.push(Number((step * index).toPrecision(6)));
  }
  return ticks;
}

function formatValue(value: number, suffix: string): string {
  return `${Math.round(value * 10) / 10}${suffix}`;
}

function flattenIfCrowded(spec: BarChartSpec): BarChartSpec {
  if (spec.series.length <= MAX_GROUPED_SERIES) {
    return spec;
  }
  const groups: BarGroup[] = [];
  for (const group of spec.groups) {
    spec.series.forEach((name, index) => {
      const value = group.values[index];
      if (value != null) {
        groups.push({ label: `${name} · ${group.label}`, values: [value] });
      }
    });
  }
  return { ...spec, series: [""], groups };
}

export function groupedBarSvg(input: BarChartSpec): string {
  const spec = flattenIfCrowded(input);
  const seriesCount = Math.max(1, spec.series.length);
  const grouped = seriesCount > 1;
  const barHeight = grouped ? 24 : 36;
  const barGap = 2;
  const groupPadding = grouped ? 22 : 28;
  const groupHeight = seriesCount * barHeight + (seriesCount - 1) * barGap + groupPadding;
  const width = 1200;
  const left = 320;
  const right = 1080;
  const legendHeight = grouped ? 36 : 0;
  const top = 140 + legendHeight;
  const plotBottom = top + groupHeight * spec.groups.length;
  const height = plotBottom + 110;
  const values = spec.groups.flatMap((group) => group.values.filter((value): value is number => value != null));
  const ticks = niceTicks(spec.vmax ?? Math.max(1, ...values) * 1.08);
  const vmax = ticks[ticks.length - 1] ?? 1;
  const suffix = spec.valueSuffix ?? "";
  const scale = (value: number) => ((right - left) * Math.max(0, value)) / vmax;

  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width * 2}" height="${height * 2}" viewBox="0 0 ${width} ${height}" font-family="${FONT}">`,
    `<rect width="${width}" height="${height}" fill="${SURFACE}"/>`,
    `<text x="40" y="58" font-size="30" font-weight="700" fill="${INK}">${escapeHtml(spec.title)}</text>`,
    `<text x="40" y="96" font-size="18" fill="${INK2}">${escapeHtml(spec.subtitle)}</text>`,
  ];
  if (grouped) {
    let x = 40;
    spec.series.forEach((name, index) => {
      parts.push(`<rect x="${x}" y="122" width="16" height="16" rx="3" fill="${SERIES[index % SERIES.length]}"/>`);
      parts.push(`<text x="${x + 24}" y="136" font-size="16" fill="${INK}">${escapeHtml(name)}</text>`);
      x += 24 + Math.min(320, name.length * 9 + 28);
    });
  }
  for (const tick of ticks) {
    const x = left + scale(tick);
    parts.push(
      `<line x1="${x.toFixed(1)}" y1="${top - 10}" x2="${x.toFixed(1)}" y2="${plotBottom}" stroke="${GRID}" stroke-width="1"/>`,
    );
    parts.push(
      `<text x="${x.toFixed(1)}" y="${plotBottom + 24}" font-size="14" fill="${MUTED}" text-anchor="middle">${tick}${suffix}</text>`,
    );
  }
  spec.groups.forEach((group, groupIndex) => {
    const y = top + groupHeight * groupIndex;
    const blockHeight = seriesCount * barHeight + (seriesCount - 1) * barGap;
    parts.push(
      `<text x="${left - 16}" y="${y + blockHeight / 2 + 7}" font-size="19" fill="${INK}" text-anchor="end">${escapeHtml(group.label)}</text>`,
    );
    group.values.forEach((value, seriesIndex) => {
      const barY = y + seriesIndex * (barHeight + barGap);
      if (value == null) {
        parts.push(
          `<text x="${left + 8}" y="${barY + barHeight / 2 + 6}" font-size="15" fill="${MUTED}">not measured</text>`,
        );
        return;
      }
      const barWidth = scale(value);
      const fill = SERIES[seriesIndex % SERIES.length];
      parts.push(
        `<rect x="${left}" y="${barY}" width="${barWidth.toFixed(1)}" height="${barHeight}" rx="4" fill="${fill}"/>`,
      );
      parts.push(
        `<text x="${(left + barWidth + 10).toFixed(1)}" y="${barY + barHeight / 2 + 7}" font-size="${grouped ? 17 : 20}" font-weight="700" fill="${INK}">${formatValue(value, suffix)}</text>`,
      );
    });
  });
  parts.push(
    `<text x="${(left + right) / 2}" y="${plotBottom + 54}" font-size="15" fill="${INK2}" text-anchor="middle">${escapeHtml(spec.unit)}</text>`,
  );
  parts.push(`<text x="40" y="${height - 20}" font-size="13" fill="${MUTED}">${escapeHtml(spec.footnote)}</text>`);
  parts.push("</svg>");
  return parts.join("\n");
}

function commandExists(command: string): boolean {
  const probe = spawnSync(process.platform === "win32" ? "where" : "which", [command], { stdio: "ignore" });
  return probe.status === 0;
}

export function svgToPng(svgPath: string, pngPath: string, env: NodeJS.ProcessEnv = process.env): string | null {
  fs.rmSync(pngPath, { force: true });
  if (process.platform === "darwin" && commandExists("sips")) {
    const result = spawnSync("sips", ["-s", "format", "png", svgPath, "--out", pngPath], { stdio: "ignore" });
    if (result.status === 0 && fs.existsSync(pngPath)) {
      return "sips";
    }
  }
  if (commandExists("rsvg-convert")) {
    const result = spawnSync("rsvg-convert", ["-o", pngPath, svgPath], { stdio: "ignore" });
    if (result.status === 0 && fs.existsSync(pngPath)) {
      return "rsvg-convert";
    }
  }
  const python = spawnSync(
    "python3",
    ["-I", "-c", "import sys, cairosvg; cairosvg.svg2png(url=sys.argv[1], write_to=sys.argv[2])", svgPath, pngPath],
    { stdio: "ignore", env },
  );
  if (python.status === 0 && fs.existsSync(pngPath)) {
    return "cairosvg";
  }
  return null;
}
