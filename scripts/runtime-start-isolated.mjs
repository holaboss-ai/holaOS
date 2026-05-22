import process from "node:process";

import {
  launchStandaloneRuntime,
  parseLauncherArgs,
} from "./isolated-runtime-launchers.mjs";

function printHelp() {
  console.log(`Usage: bun run runtime:start:isolated -- [name] [options]
       bun run runtime:start:evals -- [name] [options]

Launch a standalone runtime with an isolated sandbox root under ~/.holaos/.

Options:
  --name <name>            Instance name. Defaults to "isolated".
  --default-name <name>    Internal default used by script aliases.
  --namespace <name>       Namespace folder under ~/.holaos/. Defaults to "runtime".
  --sandbox-root <path>    Override the derived sandbox root.
  --port <port>            Override the derived runtime API port.
  --no-prepare             Fail instead of auto-preparing the runtime bundle.
  --help                   Show this message.

Examples:
  bun run runtime:start:isolated -- bugfix-a
  bun run runtime:start:evals
  bun run runtime:start:evals -- memory-evals-2 --port 43001
`);
}

try {
  const parsed = parseLauncherArgs(process.argv.slice(2));
  if (parsed.help) {
    printHelp();
    process.exit(0);
  }

  const exitCode = await launchStandaloneRuntime(parsed);
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
