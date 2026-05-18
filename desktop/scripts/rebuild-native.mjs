#!/usr/bin/env node
// Wraps @electron/rebuild and re-signs the produced .node files on macOS.
//
// Why the re-sign: @electron/rebuild signs the .node ad-hoc, then its
// post-build path touches the file again (chmod/copy), which advances
// the inode mtime past the embedded cs_mtime. On launch the macOS kernel
// sees mtime drift, marks the page tainted, and SIGKILLs the Electron
// process before any JS runs. Re-signing here aligns cs_mtime with the
// current mtime so the page validates.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, "..");

function run(command, args, options = {}) {
  execFileSync(command, args, { stdio: "inherit", cwd: desktopDir, ...options });
}

function resignNativeBindings() {
  if (process.platform !== "darwin") return;
  const moduleDir = path.join(desktopDir, "node_modules", "better-sqlite3", "build", "Release");
  if (!fs.existsSync(moduleDir)) return;
  for (const entry of fs.readdirSync(moduleDir)) {
    if (!entry.endsWith(".node")) continue;
    const filePath = path.join(moduleDir, entry);
    const realPath = fs.realpathSync(filePath);
    process.stdout.write(`[rebuild-native] re-signing ${realPath}\n`);
    execFileSync("codesign", ["--force", "--sign", "-", realPath], { stdio: "inherit" });
  }
}

run("node", ["./node_modules/@electron/rebuild/lib/cli.js", "-f", "-w", "better-sqlite3"]);
resignNativeBindings();
