import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const SETTINGS_DIALOG_PATH = new URL("./SettingsDialog.tsx", import.meta.url);

test("settings dialog no longer surfaces automations; that surface lives in the chat pane", async () => {
  const source = await readFile(SETTINGS_DIALOG_PATH, "utf8");

  assert.match(source, /appVersion: string;/);
  assert.doesNotMatch(source, /AutomationsPane/);
  assert.doesNotMatch(source, /\bautomations\b/);
  assert.doesNotMatch(source, /\bAutomations\b/);
  assert.doesNotMatch(source, /\bWorkflow\b/);
  assert.doesNotMatch(source, /automationsWorkspaceId/);
  assert.doesNotMatch(source, /onCreateAutomationSchedule/);
  assert.doesNotMatch(source, /onEditAutomationSchedule/);
  assert.doesNotMatch(source, /onOpenAutomationRunSession/);
  assert.match(source, /useWorkspaceDesktop/);
});

test("settings dialog settings section shows the app controls above appearance", async () => {
  const source = await readFile(SETTINGS_DIALOG_PATH, "utf8");

  assert.match(source, /const displayAppVersion = appVersion\.trim\(\) \|\| "Unavailable";/);
  assert.match(source, /function aboutAppUpdateState\(status: AppUpdateStatusPayload \| null\): \{/);
  assert.match(source, /const \[appUpdateStatus, setAppUpdateStatus\] =\s*useState<AppUpdateStatusPayload \| null>\(null\);/);
  assert.match(source, /const \[appUpdateChannelPending, setAppUpdateChannelPending\] = useState\(false\);/);
  assert.match(source, /const \[appUpdateInstallPending, setAppUpdateInstallPending\] = useState\(false\);/);
  assert.match(source, /const appUpdateState = aboutAppUpdateState\(appUpdateStatus\);/);
  assert.match(source, /window\.electronAPI\.appUpdate\.getStatus\(\)/);
  assert.match(source, /window\.electronAPI\.appUpdate\.checkNow\(\)/);
  assert.match(source, /window\.electronAPI\.appUpdate\.onStateChange\(\(status\) => \{/);
  assert.match(source, /async function handleSetBetaChannel\(checked: boolean\)/);
  assert.match(source, /function handleInstallAppUpdateNow\(\) \{/);
  assert.match(source, /void window\.electronAPI\.appUpdate\.installNow\(\)\.catch\(\(error\) => \{/);
  assert.match(source, /window\.electronAPI\.appUpdate\.setChannel\(\s*checked \? "beta" : "latest",?\s*\)/);
  assert.match(source, /activeSection === "about" \? \(/);
  assert.match(source, /if \(status\.downloaded\) \{\s*return \{\s*badge: "Ready",[\s\S]*progressPercent: null,[\s\S]*readyToInstall: true,/);
  assert.doesNotMatch(source, /if \(status\.downloaded\) \{\s*return \{[\s\S]*progressPercent: 100,/);

  const settingsSectionIndex = source.indexOf('activeSection === "settings" ? (');
  const appLabelIndex = source.indexOf("holaOS Desktop");
  const desktopUpdatesIndex = source.indexOf("Desktop updates");
  const betaUpdatesIndex = source.indexOf("Beta updates");
  const appearanceIndex = source.indexOf("Appearance");
  const workspaceCardsPerRowIndex = source.indexOf("Workspace cards per row");
  const aboutSectionIndex = source.indexOf('activeSection === "about" ? (');

  assert.notEqual(settingsSectionIndex, -1);
  assert.notEqual(appLabelIndex, -1);
  assert.notEqual(desktopUpdatesIndex, -1);
  assert.notEqual(betaUpdatesIndex, -1);
  assert.notEqual(appearanceIndex, -1);
  assert.notEqual(workspaceCardsPerRowIndex, -1);
  assert.notEqual(aboutSectionIndex, -1);
  assert.ok(settingsSectionIndex < appLabelIndex);
  assert.ok(appLabelIndex < desktopUpdatesIndex);
  assert.ok(desktopUpdatesIndex < betaUpdatesIndex);
  assert.ok(betaUpdatesIndex < appearanceIndex);
  assert.ok(appearanceIndex < workspaceCardsPerRowIndex);
  assert.ok(appearanceIndex < aboutSectionIndex);
  assert.match(source, /v\{displayAppVersion\}/);
  assert.match(source, /aria-live="polite"/);
  assert.match(source, /appUpdateState\.progressPercent !== null/);
  assert.match(source, /appUpdateState\.readyToInstall \? \(/);
  assert.match(source, /width: `\$\{appUpdateState\.progressPercent\}%`/);
  assert.match(source, /Update and Restart Now/);
  assert.match(source, /Restarting\.\.\./);
  assert.match(source, /Opt into beta desktop releases before they reach the stable channel\./);
  assert.match(source, /<SettingsToggle[\s\S]*checked=\{betaChannelEnabled\}/);
  assert.match(source, /workspaceCardsPerRow: ControlCenterCardsPerRow;/);
  assert.match(source, /onWorkspaceCardsPerRowChange: \(value: ControlCenterCardsPerRow\) => void;/);
  assert.match(source, /label="Workspace cards per row"/);
  assert.match(source, /Choose how many control center cards to fit on each row when the window is wide enough\./);
  assert.match(source, /value=\{String\(workspaceCardsPerRow\)\}/);
  assert.match(source, /onWorkspaceCardsPerRowChange\(\s*Number\(value\) as ControlCenterCardsPerRow,/);
  assert.match(source, /value: "2",[\s\S]*Comfortable, larger previews\./);
  assert.match(source, /value: "3",[\s\S]*Balanced density\./);
  assert.match(source, /value: "4",[\s\S]*Dense, smaller cards\./);
});

test("settings nav drops the automations section now that it lives in the chat pane", async () => {
  const source = await readFile(SETTINGS_DIALOG_PATH, "utf8");

  assert.notEqual(
    source.indexOf('{ id: "providers", label: "AI", icon: Waypoints }'),
    -1,
  );
  assert.equal(source.indexOf('label: "Automations"'), -1);
  assert.equal(source.indexOf('id: "automations"'), -1);
});
