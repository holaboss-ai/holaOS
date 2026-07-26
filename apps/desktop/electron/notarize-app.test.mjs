import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const DESKTOP_PACKAGE_PATH = new URL("../package.json", import.meta.url);
const NOTARIZE_SCRIPT_PATH = new URL("../scripts/notarize-app.mjs", import.meta.url);

test("desktop notarization helper declares its direct dependency", async () => {
  const [packageJson, scriptSource] = await Promise.all([
    readFile(DESKTOP_PACKAGE_PATH, "utf8").then((source) => JSON.parse(source)),
    readFile(NOTARIZE_SCRIPT_PATH, "utf8"),
  ]);

  assert.equal(packageJson.devDependencies["@electron/notarize"], "^2.5.0");
  assert.match(scriptSource, /import \{ notarize \} from "@electron\/notarize";/);
});
