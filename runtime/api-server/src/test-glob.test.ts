import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  fs.readFileSync(path.join(here, "..", "package.json"), "utf8"),
) as { scripts?: Record<string, string> };

/**
 * The glob has to stay QUOTED.
 *
 * Unquoted, the shell expands `src/**` + `/*.test.ts` — and without globstar
 * that collapses to `src/*` + `/*.test.ts`, i.e. only test files sitting in a
 * SUBDIRECTORY of src. Every top-level `src/*.test.ts` silently never ran: 112
 * files on disk, 13 tests executed. That is how three real bugs and a pile of
 * assertions pinning long-reversed decisions sat green in CI for months.
 *
 * The failure is invisible — the suite passes, loudly, having run 1% of itself
 * — so this guards the quoting rather than trusting anyone to notice.
 */
test("the api-server test glob is quoted, so node expands it and not the shell", () => {
  const script = pkg.scripts?.test;
  assert.ok(script, "package.json has no test script");

  assert.match(
    script,
    /"src\/\*\*\/\*\.test\.ts"/,
    `the test glob must stay quoted — unquoted, the shell drops every top-level src/*.test.ts. Saw: ${script}`,
  );
});

test("every test file on disk is reachable by that glob", () => {
  // A second failure mode: someone "fixes" the glob by narrowing it (e.g. to
  // src/*.test.ts) and silently drops the subdirectory tiers instead.
  const srcDir = path.join(here);
  const onDisk: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".test.ts")) {
        onDisk.push(full);
      }
    }
  };
  walk(srcDir);

  const topLevel = onDisk.filter((f) => path.dirname(f) === srcDir).length;
  const nested = onDisk.length - topLevel;

  assert.ok(topLevel > 0, "expected top-level src/*.test.ts files");
  assert.ok(nested > 0, "expected nested src/**/ test files");
  // `src/**/*.test.ts` in node's own matcher covers both tiers; this asserts the
  // pattern in package.json is the two-tier one, not a narrowed replacement.
  assert.match(pkg.scripts!.test!, /src\/\*\*\/\*\.test\.ts/);
});
