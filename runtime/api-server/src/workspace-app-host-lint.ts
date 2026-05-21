// Reject app source that hardcodes upstream API hosts for toolkits we
// support via Composio's broker proxy. Vibe-coded apps that wrote
// `fetch("https://api.twitter.com/...")` broke the moment Composio's
// Twitter toolkit moved to api.x.com — and that's the *easy* case;
// most toolkit hosts evolve silently over time and there's no way for
// an app to know.
//
// The right primitive is `createRuntimeBrokerTransport({ provider })`:
// the broker forwards the request to whatever host Composio currently
// routes that toolkit to, with the user's token attached. Apps stay
// host-agnostic; we (the platform) absorb the rebrand churn.
//
// This lint runs at workspace_apps_register. If it finds a hardcoded
// host that matches a toolkit we know about, the register call throws
// 400 with file/line context so the agent can switch to the broker.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// Maps a known upstream host pattern to the canonical Composio slug an
// app should be routing through instead. Patterns are matched against
// raw file contents (case-insensitive). Order doesn't matter — first
// match wins and the message names the suggested provider.
//
// Conservative list: only hosts that are 100% toolkit-routable. This
// is NOT a kitchen-sink "no external fetch" rule — apps may still need
// to reach non-Composio APIs (their own backends, public CDNs, etc.).
const FORBIDDEN_HOST_PATTERNS: ReadonlyArray<{
  pattern: RegExp;
  provider: string;
  host: string;
}> = [
  { pattern: /\bapi\.twitter\.com\b/i, provider: "twitter", host: "api.twitter.com" },
  { pattern: /\bapi\.x\.com\b/i, provider: "twitter", host: "api.x.com" },
  { pattern: /\bslack\.com\/api\b/i, provider: "slack", host: "slack.com/api" },
  { pattern: /\bapi\.slack\.com\b/i, provider: "slack", host: "api.slack.com" },
  { pattern: /\bdiscord\.com\/api\b/i, provider: "discordbot", host: "discord.com/api" },
  { pattern: /\bdiscordapp\.com\b/i, provider: "discordbot", host: "discordapp.com" },
  { pattern: /\bapi\.github\.com\b/i, provider: "github", host: "api.github.com" },
  { pattern: /\bapi\.notion\.com\b/i, provider: "notion", host: "api.notion.com" },
  { pattern: /\bapi\.linear\.app\b/i, provider: "linear", host: "api.linear.app" },
  { pattern: /\bgmail\.googleapis\.com\b/i, provider: "gmail", host: "gmail.googleapis.com" },
  { pattern: /\bapi\.figma\.com\b/i, provider: "figma", host: "api.figma.com" },
  { pattern: /\bapi\.hubspot\.com\b/i, provider: "hubspot", host: "api.hubspot.com" },
  { pattern: /\bapi\.stripe\.com\b/i, provider: "stripe", host: "api.stripe.com" },
  { pattern: /\boauth\.reddit\.com\b/i, provider: "reddit", host: "oauth.reddit.com" },
  { pattern: /\bapi\.calendly\.com\b/i, provider: "cal", host: "api.calendly.com" },
  { pattern: /\bapi\.mailchimp\.com\b/i, provider: "mailchimp", host: "api.mailchimp.com" },
  { pattern: /\bapi\.linkedin\.com\b/i, provider: "linkedin", host: "api.linkedin.com" },
  { pattern: /\bapi\.intercom\.io\b/i, provider: "intercom", host: "api.intercom.io" },
];

const SCANNABLE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
]);

const SKIPPED_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".vercel",
  ".cache",
  "out",
]);

export interface HostLintViolation {
  file: string;
  line: number;
  host: string;
  provider: string;
  snippet: string;
}

function walkSourceFiles(rootDir: string): string[] {
  const out: string[] = [];
  function visit(dir: string): void {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIPPED_DIR_NAMES.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!SCANNABLE_EXTENSIONS.has(ext)) continue;
      out.push(full);
    }
  }
  try {
    if (!statSync(rootDir).isDirectory()) return out;
  } catch {
    return out;
  }
  visit(rootDir);
  return out;
}

export function findForbiddenUpstreamHosts(appDir: string): HostLintViolation[] {
  const violations: HostLintViolation[] = [];
  // Per-app scan window: only src/ and the entry files at the root.
  // Skipping the rest avoids snapshotting vendor copies or compiled
  // output that legitimately reference these hosts in metadata.
  const candidateRoots = [
    path.join(appDir, "src"),
    appDir,
  ];
  const seenFiles = new Set<string>();
  for (const root of candidateRoots) {
    for (const file of walkSourceFiles(root)) {
      // Don't double-scan files reachable from both roots.
      if (seenFiles.has(file)) continue;
      // For the outer appDir scan, restrict to the top-level entry files
      // so we don't traverse into src/ a second time, or into app-builder
      // build outputs sitting alongside src/.
      if (root === appDir && path.dirname(file) !== appDir) continue;
      seenFiles.add(file);

      let contents: string;
      try {
        contents = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      for (const { pattern, provider, host } of FORBIDDEN_HOST_PATTERNS) {
        pattern.lastIndex = 0;
        const match = pattern.exec(contents);
        if (!match) continue;
        // Find line number for the first hit.
        const upTo = contents.slice(0, match.index);
        const line = upTo.split("\n").length;
        const lineText = contents.split("\n")[line - 1] ?? "";
        violations.push({
          file: path.relative(appDir, file) || file,
          line,
          host,
          provider,
          snippet: lineText.trim().slice(0, 160),
        });
      }
    }
  }
  return violations;
}

export function formatHostLintError(violations: HostLintViolation[]): string {
  const lines: string[] = [
    "app source hardcodes upstream API hosts. Route these through the broker instead — host strings drift (e.g. api.twitter.com → api.x.com) and the broker handles attaching the user's token + tracking the current upstream URL.",
  ];
  for (const violation of violations.slice(0, 5)) {
    lines.push(
      `  ${violation.file}:${violation.line} — '${violation.host}' (provider '${violation.provider}')`,
    );
    if (violation.snippet) {
      lines.push(`      ${violation.snippet}`);
    }
  }
  if (violations.length > 5) {
    lines.push(`  …and ${violations.length - 5} more.`);
  }
  lines.push(
    "Fix: import { createRuntimeBrokerTransport } from \"@holaboss/app-builder-sdk\" and call upstream APIs through it. The broker uses the provider slug from your app.runtime.yaml integration block; no host belongs in your code.",
  );
  return lines.join("\n");
}
