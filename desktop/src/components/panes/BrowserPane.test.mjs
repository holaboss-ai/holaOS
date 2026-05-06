import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(__dirname, "BrowserPane.tsx");

test("browser pane no longer exposes a dedicated close action in the chrome controls", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /interface BrowserPaneProps \{/);
  assert.match(
    source,
    /export function BrowserPane\(\{\s*suspendNativeView = false,\s*layoutSyncKey = "",\s*\}: BrowserPaneProps\)/,
  );
  assert.doesNotMatch(source, /label="Close browser pane"/);
});

test("browser pane exposes screenshot copy without browser comments", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /import \{ BrowserProfileImportButton \} from "@\/components\/panes\/BrowserProfileImportButton";/);
  assert.match(source, /useBrowserCaptureActions\(\)/);
  assert.match(source, /<BrowserProfileImportButton[\s\S]*buttonSize="sm"[\s\S]*buttonVariant="outline"/);
  assert.match(source, /aria-label="Copy browser screenshot"/);
  assert.match(source, /title="Copy browser screenshot"/);
  assert.match(source, /captureScreenshotToClipboard\(\)/);
  assert.match(source, /screenshotCapturePending \? \(\s*<Loader2 size=\{13\} className="animate-spin" \/>\s*\) : \(\s*<Camera size=\{13\} \/>\s*\)/);
  assert.doesNotMatch(source, /aria-label="Add browser comments to chat"/);
  assert.doesNotMatch(source, /captureCommentsForChat/);
  assert.doesNotMatch(source, /commentCapturePending/);
  assert.doesNotMatch(source, /MessageSquarePlus/);
  assert.match(source, /BrowserCaptureStatusToast/);
  assert.match(source, /<BrowserCaptureStatusToast message=\{actionStatus\} \/>/);
  assert.doesNotMatch(source, /px-1\.5 pb-1 text-\[11px\] text-muted-foreground/);
});

test("browser pane exposes a single inline browser-space switcher", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /const alternateBrowserSpace =\s*visibleBrowserSpace === "user" \? "agent" : "user";/);
  assert.match(source, /const visibleBrowserSpace = browserState\.space \|\| DEFAULT_BROWSER_SPACE;/);
  assert.match(source, /const VisibleBrowserIcon = visibleBrowserSpace === "user" \? Globe : Bot;/);
  assert.match(source, /Switch to \$\{alternateBrowserLabel\} browser/);
  assert.match(source, /window\.electronAPI\.browser\.setActiveWorkspace\(selectedWorkspaceId, space\)/);
  assert.match(source, /activeDownloadCount > 0/);
  assert.doesNotMatch(source, /visibleBrowserCount/);
  assert.doesNotMatch(source, /aria-label="Downloads"/);
});

test("browser pane keeps control treatment without a session selector in the chrome", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.doesNotMatch(source, /Choose session browser/);
  assert.doesNotMatch(source, /No session browsers/);
  assert.doesNotMatch(source, /onSelectAgentSessionBrowser/);
  assert.match(source, /const glowPreviewEnabled = useBrowserGlowPreview\(\);/);
  assert.match(
    source,
    /const showAgentActivityHighlight =\s*sessionBrowserStatus\?\.tone === "active" \|\| glowPreviewEnabled;/,
  );
  assert.doesNotMatch(source, /Shared agent browser/);
  assert.doesNotMatch(source, /<span className="truncate">\{sessionBrowserStatus\.detail\}<\/span>/);
  assert.match(source, /browser-active-glow border-transparent/);
  assert.match(source, /browser-active-glow-frame pointer-events-none absolute inset-0 rounded-\[inherit\]/);
  assert.doesNotMatch(source, /border-primary\/70/);
  assert.doesNotMatch(source, /browserBoundsRef/);
  assert.match(source, /const rect = viewport\.getBoundingClientRect\(\);/);
  assert.doesNotMatch(source, /absolute left-3 top-3 inline-flex items-center gap-1\.5 rounded-full/);
});

test("browser pane preserves explicit URL schemes and supports localhost-style input", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.equal(
    source.includes('const EXPLICIT_SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z\\d+\\-.]*:/;'),
    true,
  );
  assert.equal(
    source.includes("if (EXPLICIT_SCHEME_PATTERN.test(trimmed)) {\n    return trimmed;\n  }"),
    true,
  );
  assert.equal(
    source.includes('const LOCALHOST_PATTERN = /^localhost(?::\\d+)?(?:[/?#]|$)/i;'),
    true,
  );
  assert.equal(
    source.includes('const IPV4_HOST_PATTERN = /^(?:\\d{1,3}\\.){3}\\d{1,3}(?::\\d+)?(?:[/?#]|$)/;'),
    true,
  );
  assert.equal(
    source.includes('const IPV6_HOST_PATTERN = /^\\[[0-9a-fA-F:]+\\](?::\\d+)?(?:[/?#]|$)/;'),
    true,
  );
  assert.equal(source.includes("return `http://${trimmed}`;"), true);
});

test("browser pane selects the full address when the navigation field is clicked", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /const selectAddressInput = \(\) => \{\s*addressInputRef\.current\?\.focus\(\);\s*addressInputRef\.current\?\.select\(\);\s*\};/);
  assert.match(
    source,
    /ref=\{addressFieldRef\}[\s\S]*onClick=\{\(event\) => \{[\s\S]*event\.target instanceof HTMLElement[\s\S]*event\.target\.closest\("button"\)[\s\S]*selectAddressInput\(\);[\s\S]*\}\}/,
  );
  assert.match(source, /onFocus=\{\(event\) => \{\s*event\.currentTarget\.select\(\);/);
  assert.match(source, /onClick=\{\(event\) => event\.currentTarget\.select\(\)\}/);
});

test("browser pane keeps loading state in the address bar and turns refresh into stop", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /const isActiveTabBusy = activeTab\.loading \|\| !activeTab\.initialized;/);
  assert.match(source, /aria-label=\{activeTab\.loading \? "Stop loading" : "Refresh"\}/);
  assert.match(source, /title=\{activeTab\.loading \? "Stop loading" : "Refresh"\}/);
  assert.match(
    source,
    /activeTab\.loading\s*\?\s*window\.electronAPI\.browser\.stopLoading\(\)\s*:\s*window\.electronAPI\.browser\.reload\(\)/,
  );
  assert.match(
    source,
    /\{activeTab\.loading \? \(\s*<X size=\{13\} \/>\s*\) : \(\s*<RefreshCcw size=\{13\} \/>\s*\)\}/,
  );
  assert.match(
    source,
    /\{isActiveTabBusy \? \(\s*<Loader2[\s\S]*className="shrink-0 animate-spin text-primary\/85"[\s\S]*\/>\s*\) : \(\s*<Globe size=\{12\} className="shrink-0 text-primary\/85" \/>\s*\)\}/,
  );
  assert.doesNotMatch(source, /tab\.loading \? \(\s*<Loader2 size=\{11\} className="shrink-0 animate-spin" \/>\s*\) : null/);
  assert.doesNotMatch(source, /activeTab\.initialized && activeTab\.loading/);
});

test("browser pane only clears native browser bounds on suspend or unmount, not every layout sync", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /if \(suspendNativeView\) \{\s*void window\.electronAPI\.browser\.setBounds\(\{\s*x: 0,\s*y: 0,\s*width: 0,\s*height: 0,\s*\}\);\s*return;\s*\}/s);
  assert.match(source, /useLayoutEffect\(\(\) => \{[\s\S]*window\.setTimeout\(queueSync, 400\);[\s\S]*return \(\) => \{\s*observer\.disconnect\(\);[\s\S]*window\.cancelAnimationFrame\(rafId\);\s*\};\s*\}, \[layoutSyncKey, suspendNativeView\]\);/s);
  assert.match(source, /useEffect\(\(\) => \{\s*return \(\) => \{\s*void window\.electronAPI\.browser\.setBounds\(\{\s*x: 0,\s*y: 0,\s*width: 0,\s*height: 0,\s*\}\);\s*\};\s*\}, \[\]\);/s);
});

test("browser pane session-state polling keeps the last successful snapshot during transient runtime errors", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(
    source,
    /} catch \{\s*\/\/ Preserve the most recent runtime state snapshot during transient\s*\/\/ runtime restarts instead of triggering an unhandled rejection\.\s*\}/s,
  );
  assert.match(
    source,
    /const refreshVisibleSessionState = \(\) => \{\s*if \(document\.visibilityState !== "visible"\) \{\s*return;\s*\}\s*void loadSessionState\(\);\s*\};/s,
  );
});
