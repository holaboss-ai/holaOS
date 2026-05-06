import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(__dirname, "SpaceBrowserDisplayPane.tsx");
const glowPreviewHookPath = path.join(__dirname, "useBrowserGlowPreview.ts");
const stylesPath = path.join(__dirname, "..", "..", "index.css");

test("space browser display selects the full address when the navigation field is clicked", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(
    source,
    /const addressInputRef = useRef<HTMLInputElement \| null>\(null\);/,
  );
  assert.match(
    source,
    /const selectAddressInput = \(\) => \{\s*addressInputRef\.current\?\.focus\(\);\s*addressInputRef\.current\?\.select\(\);\s*\};/,
  );
  assert.match(
    source,
    /className="flex h-7 min-w-0 items-center gap-2 rounded-md border border-border bg-muted px-2\.5 transition-colors focus-within:border-muted-foreground"[\s\S]*onClick=\{selectAddressInput\}/,
  );
  assert.match(source, /ref=\{addressInputRef\}/);
  assert.match(
    source,
    /onFocus=\{\(event\) => \{[\s\S]*event\.currentTarget\.select\(\);[\s\S]*setAddressFocused\(true\);[\s\S]*\}\}/,
  );
  assert.match(source, /onClick=\{\(event\) => event\.currentTarget\.select\(\)\}/);
});

test("space browser display keeps loading state in the address bar and turns refresh into stop", async () => {
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
    /\{activeTab\.loading \? <X size=\{13\} \/> : <RefreshCcw size=\{13\} \/>\}/,
  );
  assert.match(
    source,
    /\{isActiveTabBusy \? \(\s*<Loader2[\s\S]*className="shrink-0 animate-spin text-primary"[\s\S]*\/>\s*\) : \(\s*<Globe size=\{13\} className="shrink-0 text-muted-foreground" \/>\s*\)\}/,
  );
  assert.doesNotMatch(source, /activeTab\.initialized && activeTab\.loading/);
});

test("space browser display exposes screenshot copy without browser comments", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /interface SpaceBrowserDisplayPaneProps \{/);
  assert.match(source, /import \{ BrowserProfileImportButton \} from "@\/components\/panes\/BrowserProfileImportButton";/);
  assert.match(source, /useBrowserCaptureActions\(\)/);
  assert.match(source, /const \[browserProfileImportDialogOpen, setBrowserProfileImportDialogOpen\] =\s*useState\(false\);/);
  assert.match(source, /const effectiveSuspendNativeView =\s*suspendNativeView \|\| browserProfileImportDialogOpen;/);
  assert.match(source, /<BrowserProfileImportButton[\s\S]*buttonSize="icon-sm"[\s\S]*buttonVariant="ghost"[\s\S]*open=\{browserProfileImportDialogOpen\}[\s\S]*onOpenChange=\{setBrowserProfileImportDialogOpen\}[\s\S]*showLabel=\{false\}/);
  assert.match(source, /aria-label="Copy browser screenshot"/);
  assert.match(source, /captureScreenshotToClipboard\(\)/);
  assert.match(source, /screenshotCapturePending \? \(\s*<Loader2 size=\{13\} className="animate-spin" \/>\s*\) : \(\s*<Camera size=\{13\} \/>\s*\)/);
  assert.doesNotMatch(source, /aria-label="Add browser comments to chat"/);
  assert.doesNotMatch(source, /captureCommentsForChat/);
  assert.doesNotMatch(source, /commentCapturePending/);
  assert.doesNotMatch(source, /MessageSquarePlus/);
  assert.match(source, /BrowserCaptureStatusToast/);
  assert.match(source, /<BrowserCaptureStatusToast message=\{actionStatus\} \/>/);
  assert.doesNotMatch(source, /px-1\.5 pt-1 text-\[11px\] text-muted-foreground/);
});

test("space browser display uses stored history entries for address suggestions", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(
    source,
    /useWorkspaceBrowser\(browserSpace, \{\s*includeHistory: true,\s*includeSessions: true,\s*\}\)/,
  );
  assert.match(source, /const \[addressFocused, setAddressFocused\] = useState\(false\);/);
  assert.match(
    source,
    /const historySuggestions = useMemo\(\(\) => \{[\s\S]*historyEntries\.filter\(\(entry\) => \{/,
  );
  assert.match(
    source,
    /window\.electronAPI\.browser\.showAddressSuggestions\(\s*bounds,\s*suggestions,\s*highlightedSuggestionIndex,\s*\)/,
  );
  assert.match(
    source,
    /window\.electronAPI\.browser\.onAddressSuggestionChosen\(\(index\) => \{[\s\S]*navigateTo\(entry\.url\);/,
  );
  assert.match(
    source,
    /if \(event\.key === "ArrowDown"\) \{[\s\S]*if \(event\.key === "ArrowUp"\) \{[\s\S]*if \(event\.key === "Enter" && highlightedSuggestionIndex >= 0\)/,
  );
  assert.match(
    source,
    /onBlur=\{\(\) =>\s*window\.setTimeout\(\(\) => setAddressFocused\(false\), 120\)\s*\}/,
  );
});

test("space browser display keeps takeover status without chrome session controls", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.doesNotMatch(source, /Choose agent session browser/);
  assert.doesNotMatch(source, /No session browsers/);
  assert.doesNotMatch(source, /selectAgentSessionBrowser/);
  assert.doesNotMatch(source, /Shared agent browser/);
  assert.match(source, /const glowPreviewEnabled = useBrowserGlowPreview\(\);/);
  assert.match(
    source,
    /const showAgentActivityHighlight =\s*sessionBrowserStatus\?\.tone === "active" \|\| glowPreviewEnabled;/,
  );
  assert.doesNotMatch(source, /<span className="truncate">\{sessionBrowserStatus\.detail\}<\/span>/);
  assert.match(source, /browser-active-glow border-border/);
  assert.match(source, /browser-active-glow-frame pointer-events-none absolute inset-0 rounded-\[inherit\]/);
  assert.doesNotMatch(source, /border-primary\/70/);
  assert.doesNotMatch(source, /browserBoundsRef/);
  assert.match(source, /const rect = viewport\.getBoundingClientRect\(\);/);
  assert.doesNotMatch(source, /absolute left-3 top-3 inline-flex items-center gap-1\.5 rounded-full/);
});

test("browser glow styles animate the active browser border", async () => {
  const source = await readFile(stylesPath, "utf8");

  assert.match(source, /@keyframes holaboss-browser-active-glow/);
  assert.match(source, /@keyframes holaboss-browser-active-frame/);
  assert.match(source, /0 0 44px color-mix\(in oklch, var\(--primary\) 56%, transparent\)/);
  assert.match(source, /inset 0 0 72px color-mix\(in oklch, var\(--primary\) 24%, transparent\)/);
  assert.match(
    source,
    /box-shadow:\s*inset 0 0 38px[\s\S]*color-mix\(in oklch, var\(--primary\) 30%, transparent\);/,
  );
  assert.match(source, /\.browser-active-glow \{[\s\S]*animation: holaboss-browser-active-glow 2\.8s ease-in-out infinite;/);
  assert.match(source, /\.browser-active-glow-frame \{[\s\S]*animation: holaboss-browser-active-frame 2\.8s ease-in-out infinite;/);
  assert.match(source, /@media \(prefers-reduced-motion: reduce\)/);
});

test("browser glow preview hook exposes a console toggle", async () => {
  const source = await readFile(glowPreviewHookPath, "utf8");

  assert.match(source, /const BROWSER_GLOW_PREVIEW_EVENT = "holaboss:browser-glow-preview-change";/);
  assert.match(source, /__holabossDevBrowserGlowPreview\?: \{/);
  assert.match(source, /window\.__holabossDevBrowserGlowPreview = \{/);
  assert.match(source, /on: \(\) => setBrowserGlowPreviewEnabled\(true\)/);
  assert.match(source, /off: \(\) => setBrowserGlowPreviewEnabled\(false\)/);
  assert.match(source, /toggle: \(\) =>\s*setBrowserGlowPreviewEnabled\(/);
  assert.match(source, /window\.dispatchEvent\(\s*new CustomEvent\(BROWSER_GLOW_PREVIEW_EVENT/);
});

test("space browser display only clears native browser bounds on suspend or unmount, not every layout sync", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /if \(effectiveSuspendNativeView\) \{\s*void window\.electronAPI\.browser\.setBounds\(\{\s*x: 0,\s*y: 0,\s*width: 0,\s*height: 0,\s*\}\);\s*return;\s*\}/s);
  assert.match(source, /useLayoutEffect\(\(\) => \{[\s\S]*window\.setTimeout\(queueSync, 400\);[\s\S]*return \(\) => \{\s*observer\.disconnect\(\);[\s\S]*window\.removeEventListener\("resize", queueSync\);[\s\S]*window\.cancelAnimationFrame\(rafId\);\s*\};\s*\}, \[effectiveSuspendNativeView, layoutSyncKey\]\);/s);
  assert.match(source, /useEffect\(\(\) => \{\s*return \(\) => \{\s*void window\.electronAPI\.browser\.setBounds\(\{\s*x: 0,\s*y: 0,\s*width: 0,\s*height: 0,\s*\}\);\s*\};\s*\}, \[\]\);/s);
});
