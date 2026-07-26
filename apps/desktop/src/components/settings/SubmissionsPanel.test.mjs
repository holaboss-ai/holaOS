import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const PANEL_PATH = new URL("./SubmissionsPanel.tsx", import.meta.url);

test("submissions panel waits for desktop auth before loading submissions", async () => {
  const source = await readFile(PANEL_PATH, "utf8");

  assert.match(source, /const authSessionState = useDesktopAuthSession\(\);/);
  assert.match(source, /const isSignedIn = Boolean\(authSessionState\.data\?\.user\?\.id\?\.trim\(\)\);/);
  assert.match(
    source,
    /if \(authSessionState\.isPending\) \{\s*setLoading\(true\);\s*return;\s*\}/,
  );
  assert.match(
    source,
    /if \(!isSignedIn\) \{\s*setSubmissions\(\[\]\);\s*setError\(null\);\s*setLoading\(false\);\s*return;\s*\}/,
  );
});

test("submissions panel renders an explicit sign-in requirement instead of surfacing authless IPC errors", async () => {
  const source = await readFile(PANEL_PATH, "utf8");

  assert.match(source, /<span>Sign-In Required<\/span>/);
  assert.match(
    source,
    /Your template submissions are only available after you sign in\./,
  );
  assert.match(source, /manage marketplace submissions\./);
  assert.match(
    source,
    /onClick=\{\(\) => void authSessionState\.requestAuth\(\)\}/,
  );
  assert.doesNotMatch(
    source,
    /useEffect\(\(\) => \{\s*const signal = \{ cancelled: false \};\s*void fetchSubmissions\(signal\);/,
  );
});
