import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { _electron as electron } from "playwright";

const desktopRoot = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(desktopRoot, "..");
const electronEntrypoint = path.join(desktopRoot, "out", "dist-electron", "main.cjs");
const runtimeApiServerRoot = path.join(repoRoot, "runtime", "api-server");
const browserToolServiceRunner = path.join(runtimeApiServerRoot, "src", "desktop-browser-tools.e2e-runner.ts");
const tsxBinary = path.join(runtimeApiServerRoot, "node_modules", ".bin", "tsx");
const browserStorageKey = "workspace-profile";
const execFileAsync = promisify(execFile);

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitFor(description, callback, options = {}) {
  const timeoutMs = options.timeoutMs ?? 15000;
  const intervalMs = options.intervalMs ?? 200;
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      return await callback();
    } catch (error) {
      lastError = error;
      await delay(intervalMs);
    }
  }

  throw new Error(`${description} timed out${lastError ? `: ${lastError.message}` : "."}`);
}

async function startFixtureServer() {
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
    const title = requestUrl.searchParams.get("title") || "Fixture Page";
    const body = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title}</title>
  </head>
  <body>
    <main>
      <h1>${title}</h1>
      <p id="origin">${requestUrl.origin}</p>
    </main>
  </body>
</html>`;

    response.statusCode = 200;
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(body);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to resolve fixture server address.");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise((resolve) => server.close(() => resolve()));
    }
  };
}

function desktopBrowserConfigPath(userDataPath) {
  return path.join(userDataPath, "sandbox-host", "state", "runtime-config.json");
}

async function waitForDesktopBrowserConfig(userDataPath) {
  return waitFor("desktop browser service config", async () => {
    const raw = await readFile(desktopBrowserConfigPath(userDataPath), "utf-8");
    const parsed = JSON.parse(raw);
    const capability = parsed?.capabilities?.desktop_browser;
    const url = typeof capability?.url === "string" ? capability.url.trim() : "";
    const authToken = typeof capability?.auth_token === "string" ? capability.auth_token.trim() : "";
    if (!url || !authToken) {
      throw new Error("Desktop browser capability is not ready yet.");
    }
    return { url, authToken };
  });
}

async function launchDesktopApp(userDataPath) {
  const electronApp = await electron.launch({
    cwd: desktopRoot,
    args: [electronEntrypoint],
    env: {
      ...process.env,
      CI: "1",
      HOLABOSS_DISABLE_SINGLE_INSTANCE_LOCK: "1",
      HOLABOSS_DESKTOP_USER_DATA_PATH: userDataPath
    }
  });

  const page = await electronApp.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(() => Boolean(window.electronAPI?.browser?.setActiveWorkspace));
  await page.waitForFunction(async () => {
    const state = await window.electronAPI.browser.getState();
    return state.activeTabId === "" && Array.isArray(state.tabs) && state.tabs.length === 0;
  });
  const browserConfig = await waitForDesktopBrowserConfig(userDataPath);
  return { electronApp, page, browserConfig };
}

async function agentBrowserTool(browserConfig, workspaceId, toolId, args = {}) {
  const config = {
    authToken: "",
    userId: "",
    sandboxId: "",
    modelProxyBaseUrl: "",
    defaultModel: "openai/gpt-5.4",
    runtimeMode: "oss",
    defaultProvider: "",
    holabossEnabled: false,
    desktopBrowserEnabled: true,
    desktopBrowserUrl: browserConfig.url,
    desktopBrowserAuthToken: browserConfig.authToken,
    configPath: "/tmp/runtime-config.json",
    loadedFromFile: true
  };

  const { stdout, stderr } = await execFileAsync(
    tsxBinary,
    [
      "--tsconfig",
      path.join(runtimeApiServerRoot, "tsconfig.json"),
      browserToolServiceRunner,
      JSON.stringify(config),
      toolId,
      workspaceId,
      JSON.stringify(args)
    ],
    {
      cwd: repoRoot,
      env: process.env,
      maxBuffer: 1024 * 1024 * 4
    }
  );

  const output = stdout.trim();
  if (!output) {
    throw new Error(`Agent browser tool ${toolId} returned no output.${stderr ? ` ${stderr.trim()}` : ""}`);
  }
  return JSON.parse(output);
}

async function browserServiceRequest(browserConfig, requestPath, options = {}) {
  const method = options.method || "GET";
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "x-holaboss-desktop-token": browserConfig.authToken
  };
  if (options.workspaceId) {
    headers["x-holaboss-workspace-id"] = options.workspaceId;
  }

  const response = await fetch(`${browserConfig.url}${requestPath}`, {
    method,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  const raw = await response.text();
  const payload = raw.trim() ? JSON.parse(raw) : null;
  if (!response.ok) {
    throw new Error(`Browser service ${method} ${requestPath} failed: ${response.status} ${raw.trim()}`);
  }
  return payload;
}

async function readWorkspacePage(browserConfig, workspaceId) {
  return browserServiceRequest(browserConfig, "/page", { workspaceId });
}

async function evaluateWorkspace(browserConfig, workspaceId, expression) {
  const payload = await browserServiceRequest(browserConfig, "/evaluate", {
    method: "POST",
    workspaceId,
    body: { expression }
  });
  return payload.result;
}

async function waitForWorkspacePage(browserConfig, workspaceId, expectedTitle) {
  return waitFor(`workspace ${workspaceId} page ${expectedTitle}`, async () => {
    const payload = await readWorkspacePage(browserConfig, workspaceId);
    assert.equal(payload.title, expectedTitle);
    assert.equal(payload.loading, false);
    assert.equal(payload.initialized, true);
    assert.equal(payload.error, "");
    return payload;
  });
}

async function waitForWorkspaceStorageValue(browserConfig, workspaceId, expectedValue) {
  return waitFor(`workspace ${workspaceId} storage ${String(expectedValue)}`, async () => {
    const value = await evaluateWorkspace(
      browserConfig,
      workspaceId,
      `(() => window.localStorage.getItem(${JSON.stringify(browserStorageKey)}))()`
    );
    assert.equal(value, expectedValue);
    return value;
  });
}

async function setActiveWorkspace(page, workspaceId) {
  return page.evaluate(async (nextWorkspaceId) => {
    await window.electronAPI.browser.setActiveWorkspace(nextWorkspaceId);
    await window.electronAPI.browser.setBounds({ x: 0, y: 72, width: 1280, height: 720 });
    return window.electronAPI.browser.getState();
  }, workspaceId);
}

async function navigateActiveWorkspace(page, workspaceId, url) {
  await setActiveWorkspace(page, workspaceId);
  return page.evaluate(async (targetUrl) => window.electronAPI.browser.navigate(targetUrl), url);
}

test(
  "desktop browser keeps isolated workspace profiles, restores state on switch, and persists across relaunch",
  { timeout: 120000 },
  async (t) => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "holaboss-browser-e2e-"));
    const userDataPath = path.join(tempRoot, "user-data");
    const fixtureServer = await startFixtureServer();

    let currentLaunch = null;
    t.after(async () => {
      if (currentLaunch) {
        await currentLaunch.electronApp.close().catch(() => undefined);
      }
      await fixtureServer.close().catch(() => undefined);
      await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    });

    currentLaunch = await launchDesktopApp(userDataPath);

    const workspaceAUrl = `${fixtureServer.baseUrl}/app?title=${encodeURIComponent("Workspace A")}`;
    const workspaceBUrl = `${fixtureServer.baseUrl}/app?title=${encodeURIComponent("Workspace B")}`;

    await navigateActiveWorkspace(currentLaunch.page, "workspace-a", workspaceAUrl);
    const workspaceAPage = await waitForWorkspacePage(currentLaunch.browserConfig, "workspace-a", "Workspace A");
    assert.match(workspaceAPage.url, /title=Workspace%20A/);
    await evaluateWorkspace(
      currentLaunch.browserConfig,
      "workspace-a",
      `(() => {
        window.localStorage.setItem(${JSON.stringify(browserStorageKey)}, "workspace-a");
        return window.localStorage.getItem(${JSON.stringify(browserStorageKey)});
      })()`
    );
    await waitForWorkspaceStorageValue(currentLaunch.browserConfig, "workspace-a", "workspace-a");

    await navigateActiveWorkspace(currentLaunch.page, "workspace-b", workspaceBUrl);
    const workspaceBPage = await waitForWorkspacePage(currentLaunch.browserConfig, "workspace-b", "Workspace B");
    assert.match(workspaceBPage.url, /title=Workspace%20B/);
    await waitForWorkspaceStorageValue(currentLaunch.browserConfig, "workspace-b", null);
    await evaluateWorkspace(
      currentLaunch.browserConfig,
      "workspace-b",
      `(() => {
        window.localStorage.setItem(${JSON.stringify(browserStorageKey)}, "workspace-b");
        return window.localStorage.getItem(${JSON.stringify(browserStorageKey)});
      })()`
    );
    await waitForWorkspaceStorageValue(currentLaunch.browserConfig, "workspace-b", "workspace-b");

    await setActiveWorkspace(currentLaunch.page, "workspace-a");
    await waitForWorkspacePage(currentLaunch.browserConfig, "workspace-a", "Workspace A");
    await waitForWorkspaceStorageValue(currentLaunch.browserConfig, "workspace-a", "workspace-a");

    const agentScopedWorkspaceBPage = await waitForWorkspacePage(currentLaunch.browserConfig, "workspace-b", "Workspace B");
    assert.match(agentScopedWorkspaceBPage.url, /title=Workspace%20B/);
    await waitForWorkspaceStorageValue(currentLaunch.browserConfig, "workspace-b", "workspace-b");

    const agentWorkspaceAUrl = `${fixtureServer.baseUrl}/agent?title=${encodeURIComponent("Agent Workspace A")}`;
    const agentWorkspaceBUrl = `${fixtureServer.baseUrl}/agent?title=${encodeURIComponent("Agent Workspace B")}`;

    const agentNavigateA = await agentBrowserTool(currentLaunch.browserConfig, "workspace-a", "browser_navigate", {
      url: agentWorkspaceAUrl
    });
    const agentNavigateB = await agentBrowserTool(currentLaunch.browserConfig, "workspace-b", "browser_navigate", {
      url: agentWorkspaceBUrl
    });
    assert.equal(agentNavigateA.ok, true);
    assert.equal(agentNavigateB.ok, true);

    const agentStateA = await agentBrowserTool(currentLaunch.browserConfig, "workspace-a", "browser_get_state");
    const agentStateB = await agentBrowserTool(currentLaunch.browserConfig, "workspace-b", "browser_get_state");
    assert.equal(agentStateA.ok, true);
    assert.equal(agentStateB.ok, true);
    assert.equal(agentStateA.page.title, "Agent Workspace A");
    assert.equal(agentStateB.page.title, "Agent Workspace B");
    assert.match(String(agentStateA.page.url), /title=Agent%20Workspace%20A/);
    assert.match(String(agentStateB.page.url), /title=Agent%20Workspace%20B/);

    await waitForWorkspacePage(currentLaunch.browserConfig, "workspace-a", "Agent Workspace A");
    await waitForWorkspacePage(currentLaunch.browserConfig, "workspace-b", "Agent Workspace B");
    await waitForWorkspaceStorageValue(currentLaunch.browserConfig, "workspace-a", "workspace-a");
    await waitForWorkspaceStorageValue(currentLaunch.browserConfig, "workspace-b", "workspace-b");

    await currentLaunch.electronApp.close();
    currentLaunch = null;

    currentLaunch = await launchDesktopApp(userDataPath);
    const relaunchedWorkspaceAPage = await waitForWorkspacePage(currentLaunch.browserConfig, "workspace-a", "Agent Workspace A");
    const relaunchedWorkspaceBPage = await waitForWorkspacePage(currentLaunch.browserConfig, "workspace-b", "Agent Workspace B");
    assert.match(relaunchedWorkspaceAPage.url, /title=Agent%20Workspace%20A/);
    assert.match(relaunchedWorkspaceBPage.url, /title=Agent%20Workspace%20B/);
    await waitForWorkspaceStorageValue(currentLaunch.browserConfig, "workspace-a", "workspace-a");
    await waitForWorkspaceStorageValue(currentLaunch.browserConfig, "workspace-b", "workspace-b");
  }
);
