import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const WORKSPACE_DESKTOP_PATH = new URL(
	"./workspaceDesktop.tsx",
	import.meta.url,
);

test("workspace desktop error normalization unwraps Electron IPC errors before mapping", async () => {
	const source = await readFile(WORKSPACE_DESKTOP_PATH, "utf8");

	assert.match(
		source,
		/const ipcMatch = message\.match\(\s*\/\^Error invoking remote method '\[\^'\]\+': Error: \(\.\+\)\$\/s,/,
	);
	assert.match(
		source,
		/const unwrappedMessage = ipcMatch \? ipcMatch\[1\]\.trim\(\) : message\.trim\(\);/,
	);
	assert.match(source, /const normalized = unwrappedMessage\.toLowerCase\(\);/);
	assert.match(
		source,
		/if \(rawNormalized\.includes\("error invoking remote method"\) && !ipcMatch\) \{/,
	);
	assert.match(source, /return unwrappedMessage;/);
});

test("workspace desktop maps X provider ids to the Composio Twitter toolkit", async () => {
	const source = await readFile(WORKSPACE_DESKTOP_PATH, "utf8");

	assert.match(source, /x:\s*"twitter"/);
	assert.match(
		source,
		/export function composioToolkitSlugForProvider\(providerId: string\): string \{/,
	);
	assert.match(
		source,
		/composioToolkitMatchesProvider\(c\.toolkitSlug, provider\)/,
	);
	assert.match(
		source,
		/window\.electronAPI\.workspace\.composioConnect\(\{\s*provider: toolkitSlug,/,
	);
});

test("workspace desktop hydrates workspace summaries from cached or live sources while bootstrap runs", async () => {
	const source = await readFile(WORKSPACE_DESKTOP_PATH, "utf8");

	assert.match(source, /const BOOTSTRAP_IPC_TIMEOUT_MS = 8_000;/);
	assert.match(
		source,
		/function withBootstrapTimeout<T>\(promise: Promise<T>, label: string\): Promise<T> \{/,
	);
	assert.match(
		source,
		/reject\(new Error\(`Timed out loading \$\{label\}\.`\)\);/,
	);
	assert.match(
		source,
		/const \[runtimeConfigResult, runtimeStatusResult, clientConfigResult\] = await Promise\.allSettled\(\[\s*withBootstrapTimeout\(window\.electronAPI\.runtime\.getConfig\(\), "runtime configuration"\),\s*withBootstrapTimeout\(window\.electronAPI\.runtime\.getStatus\(\), "runtime status"\),\s*withBootstrapTimeout\(window\.electronAPI\.workspace\.getClientConfig\(\), "desktop client configuration"\)\s*\]\);/,
	);
	assert.match(
		source,
		/if \(bootstrapErrors\.length > 0\) \{\s*setWorkspaceErrorMessage\(bootstrapErrors\[0\]\);\s*\}/,
	);
	assert.match(
		source,
		/type WorkspaceListLoadSource = "auto" \| "live" \| "cached";/,
	);
	assert.match(
		source,
		/const canLoadLiveWorkspaceList = runtimeReadyForWorkspaceData \|\| isSignedIn;/,
	);
	assert.match(
		source,
		/const selectedWorkspaceNeedsLocalRuntime = selectedWorkspace\?\.location !== "cloud";/,
	);
	assert.match(
		source,
		/const workspaceListSource =\s*source === "auto"\s*\?\s*canLoadLiveWorkspaceList\s*\?\s*"live"\s*:\s*"cached"\s*:\s*source;/,
	);
	assert.match(
		source,
		/const workspaceResponse = workspaceListSource === "live"\s*\?\s*await window\.electronAPI\.workspace\.listWorkspaces\(\)\s*:\s*await window\.electronAPI\.workspace\.listWorkspacesCached\(\);/,
	);
	assert.match(
		source,
		/const unsubscribe = window\.electronAPI\.runtime\.onStateChange\(\(status\) => \{/,
	);
	assert.match(
		source,
		/void window\.electronAPI\.runtime\.getStatus\(\)\.then\(\(status\) => \{/,
	);
	assert.match(
		source,
		/const workspaceListSource =\s*nextRuntimeStatus\.status === "running" \|\| isSignedIn \? "live" : "cached";/,
	);
	assert.match(
		source,
		/const result = await loadWorkspaceData\(\{\s*preserveSelection: true,\s*allowEmpty: workspaceListSource === "live",\s*source: workspaceListSource,\s*\}\);/,
	);
	assert.match(
		source,
		/setHasHydratedWorkspaceList\(\s*\(current\) =>\s*current \|\| result\.source === "live" \|\| result\.resolvedCount > 0,\s*\);/,
	);
	assert.match(
		source,
		/await window\.electronAPI\.workspace\.listWorkspacesCached\(\);/,
	);
	assert.match(
		source,
		/if \(\s*!selectedWorkspaceId \|\|\s*!selectedWorkspaceExists \|\|\s*\(selectedWorkspaceNeedsLocalRuntime && !runtimeReadyForWorkspaceData\)\s*\) \{/,
	);
});

test("workspace activation reset clears the activating flag before wiping readiness state", async () => {
	const source = await readFile(WORKSPACE_DESKTOP_PATH, "utf8");

	assert.match(
		source,
		/if \(\s*!selectedWorkspaceId \|\|\s*!selectedWorkspaceExists \|\|\s*\(selectedWorkspaceNeedsLocalRuntime && !runtimeReadyForWorkspaceData\)\s*\) \{\s*setInstalledApps\(\[\]\);\s*setIsLoadingInstalledApps\(false\);\s*setIsActivatingWorkspace\(false\);\s*setWorkspaceLifecycleWorkspaceId\(""\);\s*setWorkspaceAppsReadyState\(false\);\s*setWorkspaceBlockingReasonState\(""\);\s*return;\s*\}/,
	);
});

test("workspace desktop re-activates workspaces while installed apps are still starting", async () => {
	const source = await readFile(WORKSPACE_DESKTOP_PATH, "utf8");

	assert.match(
		source,
		/const hasInitializingApps = installedApps\.some\(\(app\) => !app\.ready\);/,
	);
	assert.match(
		source,
		/window\.electronAPI\.workspace\s*\.activateWorkspace\(selectedWorkspaceId\)/,
		"expected non-ready app polling to re-run workspace activation instead of only reading lifecycle state",
	);
});
