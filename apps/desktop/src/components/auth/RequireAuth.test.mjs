import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const requireAuthPath = path.join(__dirname, "RequireAuth.tsx");
const appPath = path.join(__dirname, "../../App.tsx");

test("RequireAuth gates on useDesktopAuthSession with three branches", async () => {
  const source = await readFile(requireAuthPath, "utf8");

  assert.match(source, /import \{ useDesktopAuthSession \} from "@\/lib\/auth\/authClient";/);
  assert.match(source, /const \{ data, error, isPending \} = useDesktopAuthSession\(\);/);

  // Splash while the initial IPC for the cached session is in flight.
  assert.match(source, /if \(isPending && !data && !error\) \{\s*return <BootSplash \/>;\s*\}/);

  // Resolved with no user → sign-in screen.
  assert.match(source, /if \(!data\) \{\s*return <SignInScreen \/>;\s*\}/);

  // Authenticated → children pass through.
  assert.match(source, /return <>\{children\}<\/>;/);
});

test("App.tsx wraps the shell in RequireAuth and keeps Umami inside the gate", async () => {
  const source = await readFile(appPath, "utf8");

  assert.match(source, /import \{ RequireAuth \} from "@\/components\/auth\/RequireAuth";/);
  assert.match(
    source,
    /<RequireAuth>\s*<UmamiIdentity \/>\s*\{useNewShell \? <NewAppShell \/> : <AppShell \/>\}\s*<\/RequireAuth>/,
  );
});
