import { mkdir, copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(scriptDir, "..");
const sourcePath = path.join(packageRoot, "src", "styles.css");
const outputDir = path.join(packageRoot, "dist");
const outputPath = path.join(outputDir, "styles.css");

await mkdir(outputDir, { recursive: true });
await copyFile(sourcePath, outputPath);
