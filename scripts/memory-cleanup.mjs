#!/usr/bin/env node

import { cleanupInteractionMemory, parseCommonArgs } from "./lib/memory-live-utils.mjs";

function printUsage() {
  console.log(
    [
      "Usage: node scripts/memory-cleanup.mjs --workspace-id <workspace-id> [options]",
      "",
      "Options:",
      "  --workspace-dir <path>           Override workspace directory",
      "  --agents-baseline-file <path>    Reset AGENTS.md from a baseline file after cleanup",
      "  --dry-run                        Report what would be cleaned without changing anything",
      "  --json                           Print the result as JSON",
    ].join("\n"),
  );
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printUsage();
    return;
  }

  const args = parseCommonArgs(process.argv.slice(2));
  const result = cleanupInteractionMemory({
    workspaceDir: args.workspaceDir,
    dryRun: args.dryRun,
    agentsBaselinePath: args.agentsBaselinePath,
  });

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`workspace: ${result.workspaceDir}`);
  console.log(`runtime_db: ${result.dbPath}`);
  console.log(`agents_md: ${result.agentsPath}`);
  console.log(`dry_run: ${args.dryRun ? "yes" : "no"}`);
  console.log("counts:");
  for (const [key, value] of Object.entries(result.counts)) {
    console.log(`  ${key}: ${value}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
