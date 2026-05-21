import process from "node:process";

import {
  launchIsolatedDesktop,
  parseLauncherArgs,
} from "./isolated-runtime-launchers.mjs";

function printHelp() {
  console.log(`Usage: bun run desktop:dev:isolated -- [name] [options]

Launch an extra Electron desktop instance against the existing dev server,
with its own isolated user-data path under ~/.holaos/desktop/.

Options:
  --name <name>              Instance name. Defaults to "isolated".
  --dev-server-url <url>     Dev server URL. Defaults to http://localhost:5173.
  --user-data-path <path>    Override the derived user-data path.
  --no-prepare               Fail instead of auto-preparing the runtime bundle.
  --help                     Show this message.

Example:
  bun run desktop:dev:isolated -- feature-dev
`);
}

try {
  const parsed = parseLauncherArgs(process.argv.slice(2));
  if (parsed.help) {
    printHelp();
    process.exit(0);
  }

  const exitCode = await launchIsolatedDesktop(parsed);
  process.exit(exitCode);
} catch (error) {
  if (error instanceof Error && error.name === "UsageError") {
    console.error(error.message);
    console.error("");
    printHelp();
    process.exit(2);
  }
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
