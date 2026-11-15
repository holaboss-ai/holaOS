import assert from "node:assert/strict";
import { test } from "node:test";

import { groupedBarSvg, niceTicks } from "./evaluation-charts.js";
import { renderMarkdownToHtml } from "./evaluation-markdown.js";
import { redactPublicText } from "./evaluation-redact.js";
import { findUnverifiedNumbers, resolvePlaceholders } from "./evaluation-report.js";

const identity = { hostnames: ["studio-mbp.local", "studio-mbp"], usernames: ["alex"] };

test("redaction strips local addresses, paths, host and user names", () => {
  const input = [
    "Server http://127.0.0.1:8000/v1/models and http://192.168.1.20:11434 and localhost:1234",
    "LAN peer 10.0.0.7, public docs https://huggingface.co/openbmb/MiniCPM5",
    "Model at /Users/alex/models/MiniCPM5-2B-Q4_K_M.gguf and C:\\Users\\alex\\m.gguf",
    "Ran on studio-mbp.local by alex; see ~/notes/run.txt",
  ].join("\n");
  const output = redactPublicText(input, identity);
  assert.doesNotMatch(output, /127\.0\.0\.1|192\.168|10\.0\.0\.7|localhost:1234/);
  assert.doesNotMatch(output, /\balex\b|studio-mbp/);
  assert.match(output, /https:\/\/huggingface\.co\/openbmb\/MiniCPM5/);
  assert.match(output, /…\/MiniCPM5-2B-Q4_K_M\.gguf/);
  assert.match(output, /…\\m\.gguf/);
  assert.match(output, /…\/run\.txt/);
  assert.match(output, /\[host\]/);
});

test("placeholders resolve from the data layer; unknown keys are reported", () => {
  const values = {
    "speed.q4.decode_tps@0": { value: 114.5, label: "Decode" },
    "capability.q4.overall.rate": { value: "85%", label: "Rate" },
    "run.q4.context_window": { value: 32768, label: "Context" },
  };
  const resolved = resolvePlaceholders(
    "{{speed.q4.decode_tps@0}} tok/s, {{ capability.q4.overall.rate }}, ctx {{run.q4.context_window}}, {{nope}}",
    values,
  );
  assert.equal(resolved.text, "114.5 tok/s, 85%, ctx 32,768, {{nope}}");
  assert.deepEqual(resolved.unresolved, ["nope"]);
});

test("bare numbers that are not in the data are flagged; names and years are not", () => {
  const values = {
    "speed.q4.decode_tps@0": { value: 114.47, label: "Decode" },
    "capability.q4.code.passed": { value: "17/20", label: "Passed" },
    "capability.q4.code.rate": { value: "85%", label: "Rate" },
  };
  const text =
    "MiniCPM5-2B in Q4_K_M with 32K context, tested in 2026: 114.5 tok/s, 17 of 20, 85%, but 61.2% on math and 3 runs. `999` in code.";
  assert.deepEqual(findUnverifiedNumbers(text, values), ["61.2%"]);
});

test("markdown renderer escapes html and supports tables, lists and links", () => {
  const html = renderMarkdownToHtml(
    [
      "## Verdict <script>",
      "",
      "**Fast** and *small*, see [docs](https://example.com) and `x<y`.",
      "",
      "| a | b |",
      "|---|---|",
      "| 1 | 2 |",
      "",
      "- one",
      "- two",
      "",
      "[bad](javascript:alert(1))",
    ].join("\n"),
  );
  assert.match(html, /<h2>Verdict &lt;script&gt;<\/h2>/);
  assert.match(html, /<strong>Fast<\/strong> and <em>small<\/em>/);
  assert.match(html, /<a href="https:\/\/example.com" rel="noopener noreferrer">docs<\/a>/);
  assert.match(html, /<code>x&lt;y<\/code>/);
  assert.match(html, /<table><thead><tr><th>a<\/th><th>b<\/th><\/tr><\/thead><tbody><tr><td>1<\/td><td>2<\/td><\/tr><\/tbody><\/table>/);
  assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  assert.doesNotMatch(html, /href="javascript/);
});

test("charts: nice ticks and grouped bars with a legend, flattened when crowded", () => {
  assert.deepEqual(niceTicks(123.6), [0, 50, 100, 150]);
  assert.deepEqual(niceTicks(100), [0, 25, 50, 75, 100]);
  const grouped = groupedBarSvg({
    title: "T",
    subtitle: "S",
    unit: "u",
    footnote: "f",
    series: ["full", "lean"],
    groups: [{ label: "Q4", values: [50, null] }],
    vmax: 100,
    valueSuffix: "%",
  });
  assert.match(grouped, /full<\/text>/);
  assert.match(grouped, /not measured/);
  assert.match(grouped, />50%<\/text>/);
  const crowded = groupedBarSvg({
    title: "T",
    subtitle: "S",
    unit: "u",
    footnote: "f",
    series: ["a", "b", "c", "d", "e"],
    groups: [{ label: "g", values: [1, 2, 3, 4, 5] }],
  });
  assert.match(crowded, /e · g/);
});
