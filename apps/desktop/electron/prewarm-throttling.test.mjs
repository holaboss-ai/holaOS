import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainSourcePath = path.join(__dirname, "main.ts");

/**
 * The prewarmed HolaEmployee surface is created detached and never shown until
 * the user opens it. Background throttling is turned off so the prewarm LOAD
 * runs at full speed — but leaving it off means an invisible page keeps its
 * timers, animations and polling running at full cadence for the whole app
 * session, whether or not the user ever opens that surface.
 */

test("prewarming restores background throttling once the load finishes", async () => {
  const source = await readFile(mainSourcePath, "utf8");

  const start = source.indexOf("async function prewarmWebHolaAppSurface");
  assert.notEqual(start, -1, "prewarmWebHolaAppSurface was not found");
  const fn = source.slice(start, source.indexOf("\n}\n", start));

  const disableAt = fn.indexOf("setBackgroundThrottling(false)");
  const restoreAt = fn.indexOf("setBackgroundThrottling(true)");

  assert.notEqual(disableAt, -1, "the prewarm no longer opts out of throttling");
  assert.notEqual(
    restoreAt,
    -1,
    "the prewarm never restores background throttling — the detached surface runs at full cadence forever",
  );
  // Order matters: restoring before the load would defeat the opt-out.
  assert.ok(
    restoreAt > disableAt,
    "throttling must be restored after the load, not before it",
  );

  // …and it has to be unconditional. Everything between the opt-out and the
  // restore can throw — seedAppSurfaceAuthCookies rejects, the view is
  // destroyed mid-prewarm — and the enclosing catch only logs, so a restore
  // sitting on the success path leaves the opt-out permanent on exactly the
  // failures this guards against.
  const finallyAt = fn.indexOf("} finally {");
  assert.notEqual(
    finallyAt,
    -1,
    "the restore is not in a finally — a throw during the prewarm leaks the opt-out for the rest of the session",
  );
  assert.ok(
    restoreAt > finallyAt,
    "background throttling must be restored inside the finally, not on the success path",
  );
  assert.ok(
    disableAt < finallyAt,
    "the opt-out must happen before the guarded block it is undone by",
  );
});
