import { rm } from "node:fs/promises";
import path from "node:path";

const targets = process.argv.slice(2);

if (targets.length === 0) {
  console.error("[remove-paths] expected at least one path argument.");
  process.exit(1);
}

await Promise.all(
  targets.map((target) =>
    rm(path.resolve(process.cwd(), target), {
      force: true,
      maxRetries: 10,
      recursive: true,
      retryDelay: 250,
    }),
  ),
);
