import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const here = path.dirname(fileURLToPath(import.meta.url));
const appSource = fs.readFileSync(path.join(here, "app.ts"), "utf8");
const serviceSource = fs.readFileSync(
  path.join(here, "runtime-agent-tools.ts"),
  "utf8",
);

/**
 * `return somethingAsync()` inside a try/catch does NOT route rejections to
 * that catch — the value is returned before it settles, and the enclosing
 * async function adopts it outside the try. The catch becomes dead code, and
 * these routes use it to map service errors onto their status and {detail}
 * body; without it a failure falls through to the generic error handler, which
 * has no statusCode to read for a plain Error and answers 500 where the route
 * meant 400.
 *
 * This is easy to reintroduce whenever a service method is made async — which
 * is how it arrived here — so guard the shape rather than the two known sites.
 */
function asyncServiceMethods(): Set<string> {
  return new Set(
    [...serviceSource.matchAll(/^\s{2}async\s+([a-zA-Z0-9_]+)\s*\(/gm)].map(
      (match) => match[1]!,
    ),
  );
}

test("no route returns an async service call un-awaited inside a try/catch", () => {
  const asyncMethods = asyncServiceMethods();
  assert.ok(asyncMethods.size > 0, "found no async methods to check against");

  const lines = appSource.split("\n");
  const offenders: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i]!.match(
      /^(\s*)return runtimeAgentToolsService\.([a-zA-Z0-9_]+)\(/,
    );
    if (!match) continue;
    const [, indent, method] = match;
    if (!asyncMethods.has(method!)) continue;

    let inTry = false;
    for (let j = i - 1; j >= 0 && j > i - 60; j -= 1) {
      if (/^\s*app\.(post|get|put|delete|patch)/.test(lines[j]!)) break;
      if (/^\s*try \{\s*$/.test(lines[j]!) && lines[j]!.search(/\S/) < indent!.length) {
        inTry = true;
        break;
      }
    }
    if (!inTry) continue;

    let hasCatch = false;
    for (let j = i + 1; j < lines.length && j < i + 40; j += 1) {
      if (/^\s*\} catch/.test(lines[j]!)) {
        hasCatch = true;
        break;
      }
    }
    if (hasCatch) offenders.push(`app.ts:${i + 1} ${method}`);
  }

  assert.deepEqual(
    offenders,
    [],
    `these returns skip their own catch — add \`await\`:\n${offenders.join("\n")}`,
  );
});
