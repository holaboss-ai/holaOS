import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const TOP_TABS_BAR_PATH = new URL("./TopTabsBar.tsx", import.meta.url);

test("top tabs bar keeps the profile menu and gates the workspace switcher off on the control center", async () => {
  const source = await readFile(TOP_TABS_BAR_PATH, "utf8");

  assert.match(source, /const \[workspaceSwitcherOpen, setWorkspaceSwitcherOpen\] = useState\(false\);/);
  assert.match(source, /const \{ selectedWorkspaceId, setSelectedWorkspaceId } =\s*useWorkspaceSelection\(\);/);
  assert.match(source, /if \(!controlCenterActive \|\| !workspaceSwitcherOpen\) \{\s*return;\s*\}\s*closeWorkspaceSwitcher\(\);/);
  assert.match(source, /!controlCenterActive \? \(/);
  assert.match(source, /!controlCenterActive &&\s*workspaceSwitcherOpen/);
  assert.match(source, /<DropdownMenu\b/);
  assert.doesNotMatch(source, /<NotificationCenter/);
  assert.doesNotMatch(source, /notificationUnreadCount/);
});

test("top tabs bar exposes a control center action alongside integrated title bar controls", async () => {
  const source = await readFile(TOP_TABS_BAR_PATH, "utf8");

  assert.match(source, /controlCenterActive\?: boolean;/);
  assert.match(source, /onOpenControlCenter\?: \(\) => void;/);
  assert.match(source, /!controlCenterActive \? \(/);
  assert.match(source, /variant="bordered"\s*size="icon-sm"/);
  assert.match(source, /onClick=\{\(\) => onOpenControlCenter\?\.\(\)\}/);
  assert.match(source, /Open control center/);
  assert.match(source, /Control center/);
  assert.match(
    source,
    /const isWindowsIntegratedTitleBar =\s*integratedTitleBar && desktopPlatform === "win32";/,
  );
  assert.match(source, /"window-drag relative h-\[38px\] px-2\.5 pt-1"/);
  assert.match(source, /window\.electronAPI\.ui\.getWindowState\(\)/);
  assert.match(source, /window\.electronAPI\.ui\.minimizeWindow\(\)/);
  assert.match(source, /window\.electronAPI\.ui\.closeWindow\(\)/);
  assert.match(source, /aria-label="Minimize window"/);
  assert.match(source, /aria-label="Close window"/);
});

test("top tabs bar keeps broad integrated title bar space draggable in workspace mode", async () => {
  const source = await readFile(TOP_TABS_BAR_PATH, "utf8");

  assert.match(
    source,
    /<div className="hidden min-w-0 items-center gap-1\.5 lg:flex">\s*\{showLayoutPicker && onLayoutModeChange \? \(/,
  );
  assert.match(
    source,
    /<div className="flex min-w-0 items-center justify-self-end gap-1\.5">/,
  );
  assert.match(
    source,
    /const workspaceSwitcherContainerClassName = `\$\{integratedTitleBar \? "window-no-drag " : ""\}relative \$\{isWindowsIntegratedTitleBar \? "w-44" : "w-40"\} shrink-0`;/,
  );
  assert.doesNotMatch(
    source,
    /className=\{`\$\{integratedTitleBar \? "window-no-drag " : ""\}hidden min-w-0 items-center gap-1\.5 lg:flex`\}/,
  );
  assert.doesNotMatch(
    source,
    /className=\{`\$\{integratedTitleBar \? "window-no-drag " : ""\}flex min-w-0 items-center justify-self-end gap-1\.5`\}/,
  );
});

test("top tabs bar keeps BrowserView suspension sticky while popovers hand off", async () => {
  const source = await readFile(TOP_TABS_BAR_PATH, "utf8");

  assert.match(source, /const TOP_BAR_POPOVER_CLOSE_GRACE_MS = 120;/);
  assert.match(
    source,
    /const topBarPopoverCloseTimerRef = useRef<number \| null>\(null\);/,
  );
  assert.match(source, /const topBarPopoverSuspendedRef = useRef\(false\);/);
  assert.match(
    source,
    /const hasOpenTopBarPopover =\s*inboxOpen \|\| accountMenuOpen \|\| layoutPickerOpen;/,
  );
  assert.match(
    source,
    /if \(hasOpenTopBarPopover\) \{[\s\S]*topBarPopoverSuspendedRef\.current = true;[\s\S]*onTopBarPopoverOpenChange\(true\);/,
  );
  assert.match(
    source,
    /topBarPopoverCloseTimerRef\.current = window\.setTimeout\(\(\) => \{[\s\S]*topBarPopoverSuspendedRef\.current = false;[\s\S]*onTopBarPopoverOpenChange\(false\);[\s\S]*\}, TOP_BAR_POPOVER_CLOSE_GRACE_MS\);/,
  );
});
