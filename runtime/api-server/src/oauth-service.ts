import { createServer, type Server } from "node:http";
import { randomBytes, createHash, randomUUID } from "node:crypto";
import { type RuntimeStateStore } from "@holaboss/runtime-state-store";

export class OAuthService {
  readonly store: RuntimeStateStore;
  private activeSessions = new Map<string, { server: Server; reject: (err: Error) => void }>();

  constructor(store: RuntimeStateStore) {
    this.store = store;
  }

  async startFlow(providerId: string, ownerUserId: string): Promise<{ authorize_url: string; state: string }> {
    const config = this.store.getOAuthAppConfig(providerId);
    if (!config) {
      throw new Error(`No OAuth app configured for "${providerId}". Configure it in the Developer tab.`);
    }

    const codeVerifier = randomBytes(32).toString("base64url");
    const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
    const state = randomUUID();
    const redirectUri = `http://127.0.0.1:${config.redirectPort}/oauth/callback`;

    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: config.scopes.join(" "),
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      access_type: "offline",
      prompt: "consent"
    });

    const authorizeUrl = `${config.authorizeUrl}?${params.toString()}`;

    const codePromise = new Promise<string>((resolve, reject) => {
      const server = createServer((req, res) => {
        const url = new URL(req.url ?? "/", `http://127.0.0.1:${config.redirectPort}`);
        if (url.pathname !== "/oauth/callback") {
          res.writeHead(404); res.end("Not found"); return;
        }
        const code = url.searchParams.get("code");
        const returnedState = url.searchParams.get("state");
        const error = url.searchParams.get("error");

        if (error) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end("<html><body><h2>Authorization failed</h2><p>You can close this window.</p></body></html>");
          reject(new Error(`OAuth error: ${error}`));
          server.close(); return;
        }
        if (!code || returnedState !== state) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end("<html><body><h2>Invalid callback</h2></body></html>");
          reject(new Error("Invalid OAuth callback"));
          server.close(); return;
        }
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<html><body><h2>Connected!</h2><p>You can close this window and return to Holaboss.</p></body></html>");
        resolve(code);
        server.close();
      });

      server.listen(config.redirectPort, "127.0.0.1");
      server.on("error", reject);
      this.activeSessions.set(state, { server, reject });

      setTimeout(() => {
        if (this.activeSessions.has(state)) {
          this.activeSessions.delete(state);
          server.close();
          reject(new Error("OAuth flow timed out"));
        }
      }, 5 * 60 * 1000);
    });

    codePromise.then(async (code) => {
      this.activeSessions.delete(state);
      await this.exchangeCode(providerId, code, codeVerifier, config.redirectPort, ownerUserId);
    }).catch(() => {
      this.activeSessions.delete(state);
    });

    return { authorize_url: authorizeUrl, state };
  }

  private async exchangeCode(providerId: string, code: string, codeVerifier: string, redirectPort: number, ownerUserId: string): Promise<void> {
    const config = this.store.getOAuthAppConfig(providerId);
    if (!config) return;

    const redirectUri = `http://127.0.0.1:${redirectPort}/oauth/callback`;
    const response = await fetch(config.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code", code,
        redirect_uri: redirectUri, client_id: config.clientId,
        client_secret: config.clientSecret, code_verifier: codeVerifier
      }).toString()
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Token exchange failed: ${response.status} ${errorText}`);
    }

    const tokens = await response.json() as {
      access_token: string; refresh_token?: string;
      expires_in?: number; scope?: string;
    };

    const expiresAt = tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000).toISOString() : null;
    const secretPayload = JSON.stringify({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token ?? null,
      expires_at: expiresAt,
      token_type: "Bearer"
    });

    this.store.upsertIntegrationConnection({
      connectionId: randomUUID(), providerId, ownerUserId,
      accountLabel: `${providerId} (OAuth)`, authMode: "oauth_app",
      grantedScopes: tokens.scope ? tokens.scope.split(" ") : config.scopes,
      status: "active", secretRef: secretPayload
    });
  }
}
