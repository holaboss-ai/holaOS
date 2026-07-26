import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const AUTH_CLIENT_PATH = new URL("./authClient.ts", import.meta.url);

test("desktop auth hook treats sign-out as a local state transition instead of refetching the session", async () => {
  const source = await readFile(AUTH_CLIENT_PATH, "utf8");

  assert.match(source, /const signOut = useCallback\(async \(\) => \{/);
  assert.match(source, /await window\.electronAPI\.auth\.signOut\(\);/);
  assert.match(source, /cachedAuthUser = null;/);
  assert.match(source, /setData\(null\);/);
  assert.match(source, /setIsPending\(false\);/);
  assert.doesNotMatch(
    source,
    /const signOut = useCallback\(async \(\) => \{[\s\S]*await refetch\(\);[\s\S]*\}, \[[^\]]*\]\);/,
  );
});

test("desktop auth hook only refetches automatically while the shared auth cache is unknown", async () => {
  const source = await readFile(AUTH_CLIENT_PATH, "utf8");

  assert.match(
    source,
    /useEffect\(\(\) => \{\s*if \(cachedAuthUser === undefined\) \{\s*void refetch\(\);\s*}/,
  );
});
