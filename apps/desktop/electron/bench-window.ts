import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  BrowserWindow,
  clipboard,
  dialog,
  type IpcMainInvokeEvent,
  ipcMain,
  nativeImage,
  session,
  shell,
} from "electron";
import JSZip from "jszip";
import {
  BENCH_CARD_SCALE,
  BENCH_CARD_SIZE,
  BENCH_WINDOW_SIZE,
  type BenchDeepLink,
  benchCatalog,
  isBenchRunDir,
  isCardName,
  loadBenchContext,
  publishBenchRun,
  xIntentUrl,
} from "./bench-links";
import type { BenchKitFile, BenchPublishResult, BenchWindowContext } from "../shared/bench-protocol";

/** What the renderer may read back from a run directory to cut the kit's videos. */
const READABLE_RUN_FILES = new Set(["events.jsonl", "recording.mp4", "recording.webm"]);
const CUT_FILES = new Set(["recording-16x9.mp4", "recording-9x16.mp4"]);

export interface BenchWindowDeps {
  preloadPath: string;
  loadRenderer: (win: BrowserWindow, query: Record<string, string>) => Promise<void>;
  /** e.g. `<HolaHub>/bench/subjects`; empty disables deep links. */
  subjectsBaseUrl: () => string;
  /** e.g. `<HolaHub>/bench/runs`. */
  resultBaseUrl: () => string;
  /** `<sandbox>/workspace`, the parent of every workspace directory. */
  workspaceRoot: () => string;
  /** HolaHub's API through the BFF, e.g. `<api>/gateway/hub`; empty disables publishing. */
  hubApiBaseUrl: () => string;
  /** The signed-in session's cookie, or "" when signed out. */
  cookieHeader: () => string;
  /** Who the public page says ran it. */
  submitterName: () => Promise<string>;
  fetchImpl?: typeof fetch;
}

export function createBenchWindowController(deps: BenchWindowDeps) {
  let win: BrowserWindow | null = null;
  let context: BenchWindowContext | null = null;

  async function open(link: BenchDeepLink, showRunId: string | null = null): Promise<void> {
    context = {
      ...(await loadBenchContext(link, {
        subjectsBaseUrl: deps.subjectsBaseUrl(),
        resultBaseUrl: deps.resultBaseUrl(),
        fetchImpl: deps.fetchImpl,
      })),
      show_run_id: showRunId,
    };
    if (win && !win.isDestroyed()) {
      win.webContents.send("bench:context", context);
      if (win.isMinimized()) {
        win.restore();
      }
      win.focus();
      return;
    }
    const created = new BrowserWindow({
      ...BENCH_WINDOW_SIZE,
      useContentSize: true,
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      show: false,
      title: "holaOS Benchmark",
      backgroundColor: "#0b0b0c",
      webPreferences: {
        preload: deps.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        // The run view keeps streaming tokens and recording while another app is in front.
        backgroundThrottling: false,
      },
    });
    win = created;
    created.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    created.once("ready-to-show", () => created.show());
    created.on("closed", () => {
      if (win === created) {
        win = null;
      }
    });
    await deps.loadRenderer(created, { view: "bench" });
  }

  function assertRunDir(runDir: string): string {
    if (!isBenchRunDir(deps.workspaceRoot(), runDir)) {
      throw new Error("Refusing to write outside a benchmark run directory.");
    }
    return path.resolve(runDir);
  }

  async function renderCard(runDir: string, name: string, html: string): Promise<{ file: string; dataUrl: string }> {
    const dir = assertRunDir(runDir);
    if (!isCardName(name)) {
      throw new Error("Invalid card name.");
    }
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "holaos-card-"));
    const renderWindow = new BrowserWindow({
      ...BENCH_CARD_SIZE,
      useContentSize: true,
      show: false,
      webPreferences: {
        offscreen: { deviceScaleFactor: BENCH_CARD_SCALE },
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        javascript: true,
      },
    });
    try {
      const htmlPath = path.join(tempDir, "card.html");
      await fs.writeFile(htmlPath, html, "utf8");
      await renderWindow.loadFile(htmlPath);
      await renderWindow.webContents.executeJavaScript("document.fonts.ready.then(() => true)");
      let image = await renderWindow.webContents.capturePage();
      const target = { width: BENCH_CARD_SIZE.width * BENCH_CARD_SCALE, height: BENCH_CARD_SIZE.height * BENCH_CARD_SCALE };
      const size = image.getSize();
      if (size.width !== target.width || size.height !== target.height) {
        image = image.resize({ ...target, quality: "best" });
      }
      const file = path.join(dir, `${name}.png`);
      await fs.writeFile(file, image.toPNG());
      return { file, dataUrl: image.toDataURL() };
    } finally {
      renderWindow.destroy();
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async function saveRecording(runDir: string, bytes: Uint8Array, extension: string): Promise<{ file: string }> {
    const dir = assertRunDir(runDir);
    const ext = extension === "webm" ? "webm" : "mp4";
    const file = path.join(dir, `recording.${ext}`);
    await fs.writeFile(file, bytes);
    return { file };
  }

  async function readRunFile(runDir: string, name: string): Promise<Uint8Array> {
    const dir = assertRunDir(runDir);
    if (!READABLE_RUN_FILES.has(name)) {
      throw new Error("That file can't be read from the run directory.");
    }
    return new Uint8Array(await fs.readFile(path.join(dir, name)));
  }

  async function saveCut(runDir: string, name: string, bytes: Uint8Array): Promise<{ file: string }> {
    const dir = assertRunDir(runDir);
    if (!CUT_FILES.has(name)) {
      throw new Error("Invalid video name.");
    }
    const file = path.join(dir, name);
    await fs.writeFile(file, bytes);
    return { file };
  }

  async function exportKit(runDir: string, suggestedName: string, files: BenchKitFile[]): Promise<{ path: string | null }> {
    const dir = assertRunDir(runDir);
    const zip = new JSZip();
    for (const entry of files) {
      const name = path.basename(entry.name);
      if (entry.text !== undefined) {
        zip.file(name, entry.text);
      } else if (entry.path) {
        const source = path.resolve(entry.path);
        if (path.dirname(source) !== dir) {
          throw new Error("Kit files must come from the run directory.");
        }
        zip.file(name, await fs.readFile(source));
      }
    }
    const result = await dialog.showSaveDialog(win && !win.isDestroyed() ? win : (undefined as never), {
      title: "Export creator kit",
      defaultPath: path.join(os.homedir(), "Downloads", path.basename(suggestedName)),
      filters: [{ name: "Zip", extensions: ["zip"] }],
    });
    if (result.canceled || !result.filePath) {
      return { path: null };
    }
    await fs.writeFile(result.filePath, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
    return { path: result.filePath };
  }

  async function share(runDir: string, cardFile: string, text: string, url: string): Promise<void> {
    const dir = assertRunDir(runDir);
    const source = path.resolve(cardFile);
    if (path.dirname(source) !== dir) {
      throw new Error("Only a card from this run can be shared.");
    }
    clipboard.writeImage(nativeImage.createFromPath(source));
    await shell.openExternal(xIntentUrl(text, url));
  }

  async function publish(runDir: string): Promise<BenchPublishResult> {
    return publishBenchRun(assertRunDir(runDir), {
      hubApiBaseUrl: deps.hubApiBaseUrl(),
      resultBaseUrl: deps.resultBaseUrl(),
      cookie: deps.cookieHeader(),
      submitterName: deps.submitterName,
      fetchImpl: deps.fetchImpl,
    });
  }

  function showInFolder(runDir: string): void {
    const dir = assertRunDir(runDir);
    shell.showItemInFolder(path.join(dir, "run-record.json"));
  }

  function currentWindow(): BrowserWindow | null {
    return win && !win.isDestroyed() ? win : null;
  }

  function fromBenchWindow<Args extends unknown[], Result>(
    channel: string,
    handler: (...args: Args) => Result | Promise<Result>,
  ): void {
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: Args) => {
      if (event.sender !== currentWindow()?.webContents) {
        throw new Error(`Unauthorized IPC sender for ${channel}.`);
      }
      return handler(...args);
    });
  }

  function register(): void {
    fromBenchWindow("bench:getContext", () => context);
    fromBenchWindow("bench:renderCard", (runDir: string, name: string, html: string) => renderCard(runDir, name, html));
    fromBenchWindow("bench:saveRecording", (runDir: string, bytes: Uint8Array, extension: string) =>
      saveRecording(runDir, bytes, extension),
    );
    fromBenchWindow("bench:readRunFile", (runDir: string, name: string) => readRunFile(runDir, name));
    fromBenchWindow("bench:saveCut", (runDir: string, name: string, bytes: Uint8Array) => saveCut(runDir, name, bytes));
    fromBenchWindow("bench:exportKit", (runDir: string, suggestedName: string, files: BenchKitFile[]) =>
      exportKit(runDir, suggestedName, files),
    );
    fromBenchWindow("bench:showInFolder", (runDir: string) => showInFolder(runDir));
    fromBenchWindow("bench:publish", (runDir: string) => publish(runDir));
    fromBenchWindow("bench:share", (runDir: string, cardFile: string, text: string, url: string) =>
      share(runDir, cardFile, text, url),
    );
    // Tab capture of the bench window itself: no screen-recording permission and no picker.
    session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
      const target = win && !win.isDestroyed() ? win.webContents.mainFrame : null;
      const frame = request.frame;
      if (target && frame && frame.processId === target.processId && frame.routingId === target.routingId) {
        callback({ video: frame });
        return;
      }
      callback({});
    });
  }

  return { open, register, window: currentWindow, catalog: benchCatalog };
}
