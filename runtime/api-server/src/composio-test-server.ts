/**
 * Minimal local test server for Composio OAuth feasibility verification.
 *
 * Usage:
 *   COMPOSIO_API_KEY=xxx node --import tsx src/composio-test-server.ts
 *
 * Then open http://localhost:3099 in your browser.
 */
import { createServer } from "node:http";
import {
  createManagedConnectLink,
  getConnectedAccount,
  proxyProviderRequest
} from "./composio-minimal-example.js";

const PORT = Number(process.env.PORT ?? 3099);
const API_KEY = process.env.COMPOSIO_API_KEY ?? "";

if (!API_KEY.trim()) {
  process.stderr.write("COMPOSIO_API_KEY is required\n");
  process.exit(1);
}

const PROXY_ENDPOINTS: Record<string, { method: "GET"; endpoint: string }> = {
  gmail: { method: "GET", endpoint: "https://gmail.googleapis.com/gmail/v1/users/me/profile" },
  google: { method: "GET", endpoint: "https://gmail.googleapis.com/gmail/v1/users/me/profile" },
  github: { method: "GET", endpoint: "https://api.github.com/user" },
  slack: { method: "GET", endpoint: "https://slack.com/api/auth.test" },
  linkedin: { method: "GET", endpoint: "https://api.linkedin.com/v2/userinfo" }
};

async function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString();
}

function json(res: import("node:http").ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  try {
    // --- Serve frontend ---
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(HTML);
      return;
    }

    // --- OAuth callback landing ---
    if (req.method === "GET" && url.pathname === "/callback") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(CALLBACK_HTML);
      return;
    }

    // --- API: create connect link ---
    if (req.method === "POST" && url.pathname === "/api/connect") {
      const body = JSON.parse(await readBody(req));
      const result = await createManagedConnectLink({
        apiKey: API_KEY,
        toolkitSlug: body.toolkitSlug,
        userId: body.userId ?? `test-user-${Date.now()}`,
        callbackUrl: `http://localhost:${PORT}/callback`
      });
      json(res, 200, result);
      return;
    }

    // --- API: check connected account status ---
    if (req.method === "GET" && url.pathname.startsWith("/api/account/")) {
      const id = url.pathname.replace("/api/account/", "");
      const account = await getConnectedAccount({
        apiKey: API_KEY,
        connectedAccountId: id
      });
      json(res, 200, account);
      return;
    }

    // --- API: proxy provider request ---
    if (req.method === "POST" && url.pathname === "/api/proxy") {
      const body = JSON.parse(await readBody(req));
      const result = await proxyProviderRequest({
        apiKey: API_KEY,
        connectedAccountId: body.connectedAccountId,
        method: body.method ?? "GET",
        endpoint: body.endpoint
      });
      json(res, 200, result);
      return;
    }

    json(res, 404, { error: "not found" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${message}\n`);
    json(res, 500, { error: message });
  }
});

server.listen(PORT, () => {
  process.stdout.write(`\nComposio OAuth Test Server running at:\n`);
  process.stdout.write(`  http://localhost:${PORT}\n\n`);
});

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

const CALLBACK_HTML = `<!DOCTYPE html>
<html><head><title>OAuth Callback</title></head>
<body>
<script>
  // Notify the opener window that OAuth is complete, then close
  if (window.opener) {
    window.opener.postMessage({ type: "composio-oauth-complete" }, "*");
  }
  document.body.innerHTML = "<h2>OAuth complete. You can close this tab.</h2>";
  setTimeout(() => window.close(), 1500);
</script>
</body></html>`;

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Composio OAuth Test</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #0a0a0a; color: #e5e5e5;
      min-height: 100vh; padding: 2rem;
    }
    h1 { font-size: 1.25rem; font-weight: 600; margin-bottom: 1.5rem; color: #fff; }
    .card {
      background: #141414; border: 1px solid #262626; border-radius: 8px;
      padding: 1.25rem; margin-bottom: 1rem; max-width: 640px;
    }
    label { display: block; font-size: 0.8rem; color: #999; margin-bottom: 0.25rem; }
    select, input {
      width: 100%; padding: 0.5rem 0.75rem; border-radius: 6px;
      border: 1px solid #333; background: #1a1a1a; color: #e5e5e5;
      font-size: 0.875rem; margin-bottom: 0.75rem;
    }
    button {
      padding: 0.5rem 1.25rem; border-radius: 6px; border: none; cursor: pointer;
      font-size: 0.875rem; font-weight: 500; transition: background-color 0.15s;
    }
    .btn-primary { background: #f58419; color: #000; }
    .btn-primary:hover { background: #e07515; }
    .btn-primary:disabled { background: #555; color: #999; cursor: not-allowed; }
    .btn-secondary { background: #262626; color: #e5e5e5; margin-left: 0.5rem; }
    .btn-secondary:hover { background: #333; }
    .btn-secondary:disabled { background: #1a1a1a; color: #555; cursor: not-allowed; }

    .step { margin-bottom: 0.75rem; }
    .step-header {
      display: flex; align-items: center; gap: 0.5rem;
      font-size: 0.8rem; font-weight: 600; text-transform: uppercase;
      letter-spacing: 0.05em; color: #777; margin-bottom: 0.5rem;
    }
    .dot {
      width: 8px; height: 8px; border-radius: 50%; background: #333;
      flex-shrink: 0;
    }
    .dot.pending { background: #555; }
    .dot.running { background: #f59e0b; animation: pulse 1s infinite; }
    .dot.success { background: #22c55e; }
    .dot.error { background: #ef4444; }
    @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }

    pre {
      background: #0f0f0f; border: 1px solid #222; border-radius: 6px;
      padding: 0.75rem; font-size: 0.75rem; overflow-x: auto;
      white-space: pre-wrap; word-break: break-all; color: #aaa;
      max-height: 300px; overflow-y: auto;
    }
    .error-text { color: #ef4444; }
    .success-text { color: #22c55e; }
    .muted { color: #666; font-size: 0.8rem; }
  </style>
</head>
<body>
  <h1>Composio OAuth Feasibility Test</h1>

  <div class="card">
    <label>Provider</label>
    <select id="toolkit">
      <option value="gmail">Gmail (Google)</option>
      <option value="github">GitHub</option>
      <option value="slack">Slack</option>
      <option value="linkedin">LinkedIn</option>
    </select>

    <label>User ID (optional)</label>
    <input id="userId" placeholder="auto-generated if empty" />

    <button class="btn-primary" id="startBtn" onclick="startFlow()">Start OAuth Flow</button>
    <button class="btn-secondary" id="resetBtn" onclick="resetAll()" disabled>Reset</button>
  </div>

  <div class="card" id="log">
    <div class="step" id="step1">
      <div class="step-header"><span class="dot pending" id="dot1"></span> Step 1 &mdash; Create Connect Link</div>
      <div id="out1"></div>
    </div>
    <div class="step" id="step2">
      <div class="step-header"><span class="dot pending" id="dot2"></span> Step 2 &mdash; OAuth &amp; Poll Status</div>
      <div id="out2"></div>
    </div>
    <div class="step" id="step3">
      <div class="step-header"><span class="dot pending" id="dot3"></span> Step 3 &mdash; Proxy Provider Request</div>
      <div id="out3"></div>
    </div>
  </div>

<script>
const PROXY_ENDPOINTS = ${JSON.stringify(PROXY_ENDPOINTS, null, 2)};

let pollTimer = null;

function dot(n, state) {
  document.getElementById("dot" + n).className = "dot " + state;
}
function out(n, html) {
  document.getElementById("out" + n).innerHTML = html;
}
function pre(obj) {
  return "<pre>" + escHtml(JSON.stringify(obj, null, 2)) + "</pre>";
}
function escHtml(s) {
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

function resetAll() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  for (let i = 1; i <= 3; i++) { dot(i, "pending"); out(i, ""); }
  document.getElementById("startBtn").disabled = false;
  document.getElementById("resetBtn").disabled = true;
}

async function startFlow() {
  document.getElementById("startBtn").disabled = true;
  document.getElementById("resetBtn").disabled = false;
  resetSteps();

  const toolkit = document.getElementById("toolkit").value;
  const userId = document.getElementById("userId").value.trim() || undefined;

  // Step 1: Create connect link
  dot(1, "running");
  out(1, '<span class="muted">Calling Composio...</span>');
  let link;
  try {
    const resp = await fetch("/api/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toolkitSlug: toolkit, userId })
    });
    link = await resp.json();
    if (link.error) throw new Error(link.error);
    dot(1, "success");
    out(1, '<span class="success-text">Connect link created</span>' + pre(link));
  } catch (e) {
    dot(1, "error");
    out(1, '<span class="error-text">Failed: ' + escHtml(e.message) + '</span>');
    return;
  }

  // Step 2: Open OAuth popup + poll status
  dot(2, "running");
  out(2, '<span class="muted">Opening OAuth window... Complete the authorization in the popup.</span>');

  const popup = window.open(link.redirectUrl, "composio-oauth", "width=600,height=700");

  // Listen for callback message
  const callbackPromise = new Promise((resolve) => {
    function onMessage(e) {
      if (e.data?.type === "composio-oauth-complete") {
        window.removeEventListener("message", onMessage);
        resolve();
      }
    }
    window.addEventListener("message", onMessage);
    // Also poll in case popup was blocked or message missed
    const checkClosed = setInterval(() => {
      if (popup && popup.closed) { clearInterval(checkClosed); resolve(); }
    }, 500);
  });

  // Start polling account status
  let account = null;
  let pollCount = 0;
  const maxPolls = 60; // 5 min at 5s intervals

  async function pollOnce() {
    pollCount++;
    try {
      const resp = await fetch("/api/account/" + link.connectedAccountId);
      const data = await resp.json();
      if (data.error) throw new Error(data.error);
      out(2,
        '<span class="muted">Poll #' + pollCount + ' &mdash; status: <b>' + data.status + '</b></span>' +
        pre(data)
      );
      if (data.status === "ACTIVE") {
        account = data;
        return true;
      }
    } catch (e) {
      out(2, '<span class="muted">Poll #' + pollCount + ' &mdash; ' + escHtml(e.message) + '</span>');
    }
    return false;
  }

  // Wait for callback, then start aggressive polling
  await callbackPromise;
  out(2, '<span class="muted">OAuth window closed. Checking account status...</span>');

  for (let i = 0; i < maxPolls; i++) {
    if (await pollOnce()) break;
    if (i < maxPolls - 1) await new Promise(r => setTimeout(r, 3000));
  }

  if (!account) {
    dot(2, "error");
    out(2, '<span class="error-text">Account did not become ACTIVE within timeout</span>');
    return;
  }
  dot(2, "success");
  out(2, '<span class="success-text">Account is ACTIVE</span>' + pre(account));

  // Step 3: Proxy request
  const proxyConfig = PROXY_ENDPOINTS[toolkit];
  if (!proxyConfig) {
    dot(3, "success");
    out(3, '<span class="muted">No default proxy endpoint for ' + toolkit + '. Skipped.</span>');
    return;
  }

  dot(3, "running");
  out(3, '<span class="muted">Calling ' + escHtml(proxyConfig.endpoint) + ' ...</span>');

  try {
    const resp = await fetch("/api/proxy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        connectedAccountId: link.connectedAccountId,
        method: proxyConfig.method,
        endpoint: proxyConfig.endpoint
      })
    });
    const result = await resp.json();
    if (result.error) throw new Error(result.error);
    dot(3, "success");
    out(3, '<span class="success-text">Proxy request succeeded (upstream status: ' + result.status + ')</span>' + pre(result));
  } catch (e) {
    dot(3, "error");
    out(3, '<span class="error-text">Proxy failed: ' + escHtml(e.message) + '</span>');
  }
}

function resetSteps() {
  for (let i = 1; i <= 3; i++) { dot(i, "pending"); out(i, ""); }
}
</script>
</body>
</html>`;
