import { DesktopBrowserToolService } from "./desktop-browser-tools.js";
import { installBenignStdioEpipeGuard } from "./stdio-epipe.js";

function requiredArg(args: string[], index: number, name: string): string {
  const value = args[index];
  if (!value) {
    throw new Error(`Missing ${name}.`);
  }
  return value;
}

async function main() {
  installBenignStdioEpipeGuard();
  const args = process.argv.slice(2);
  const config = JSON.parse(requiredArg(args, 0, "config")) as {
    authToken: string;
    userId: string;
    sandboxId: string;
    modelProxyBaseUrl: string;
    defaultModel: string;
    runtimeMode: string;
    defaultProvider: string;
    holabossEnabled: boolean;
    desktopBrowserEnabled: boolean;
    desktopBrowserUrl: string;
    desktopBrowserAuthToken: string;
    configPath: string;
    loadedFromFile: boolean;
  };
  const toolId = requiredArg(args, 1, "toolId");
  const workspaceId = requiredArg(args, 2, "workspaceId");
  const toolArgs = JSON.parse(requiredArg(args, 3, "toolArgs")) as Record<string, unknown>;

  const service = new DesktopBrowserToolService({
    resolveConfig: () => config
  });
  const result = await service.execute(toolId, toolArgs, { workspaceId });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

void main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
