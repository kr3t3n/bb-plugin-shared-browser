import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import {
  AXI_BROWSER_URL,
  CDP_PORT,
  CHROME_LOG_PATH,
  CHROME_PID_PATH,
  DATA_DIR,
  PROFILE_DIR,
  STATE_PATH,
  VIEWER_LOG_PATH,
  VIEWER_PID_PATH,
  VIEWER_PORT,
  XVFB_DISPLAY,
  XVFB_PID_PATH,
} from "./constants.js";

export type BrowserMode = "shared" | "headless";

export type BrowserState = {
  mode: BrowserMode | null;
  running: boolean;
  cdpPort: number;
  viewerPort: number | null;
  display: string | null;
  chromePid: number | null;
  viewerPid: number | null;
  xvfbPid: number | null;
  url: string | null;
  startedAt: string | null;
  axiBrowserUrl: string | null;
};

function ensureDirs(): void {
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(PROFILE_DIR, { recursive: true });
}

function readPid(file: string): number | null {
  try {
    const raw = readFileSync(file, "utf8").trim();
    const pid = Number(raw);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    try {
      process.kill(pid, 0);
      return pid;
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

function writePid(file: string, pid: number): void {
  writeFileSync(file, `${pid}\n`, "utf8");
}

function clearPid(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    /* ignore */
  }
}

function killPid(pid: number | null, signal: NodeJS.Signals = "SIGTERM"): void {
  if (pid === null) return;
  try {
    process.kill(pid, signal);
  } catch {
    /* ignore */
  }
}

async function waitFor(
  pred: () => Promise<boolean> | boolean,
  timeoutMs: number,
  intervalMs = 200,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await pred()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createServer()
      .once("error", () => resolve(false))
      .once("listening", () => {
        socket.close(() => resolve(true));
      })
      .listen(port, "127.0.0.1");
  });
}

async function cdpReady(): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export function findChromeBinary(): string {
  if (
    process.env.CHROME_DEVTOOLS_EXECUTABLE &&
    existsSync(process.env.CHROME_DEVTOOLS_EXECUTABLE)
  ) {
    return process.env.CHROME_DEVTOOLS_EXECUTABLE;
  }
  const root = "/home/bb/.cache/ms-playwright";
  if (existsSync(root)) {
    const dirs = readdirSync(root)
      .filter((d) => d.startsWith("chromium-"))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    for (let i = dirs.length - 1; i >= 0; i--) {
      const bin = path.join(root, dirs[i]!, "chrome-linux64", "chrome");
      if (existsSync(bin)) return bin;
    }
  }
  const snap = "/snap/chromium/current/usr/lib/chromium-browser/chrome";
  if (existsSync(snap)) return snap;
  throw new Error("No Chromium binary found (Playwright cache or snap)");
}

function readStateFile(): Partial<BrowserState> {
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8")) as Partial<BrowserState>;
  } catch {
    return {};
  }
}

function writeState(state: BrowserState): void {
  ensureDirs();
  writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export function getStatus(): BrowserState {
  const chromePid = readPid(CHROME_PID_PATH);
  const viewerPid = readPid(VIEWER_PID_PATH);
  const xvfbPid = readPid(XVFB_PID_PATH);
  const saved = readStateFile();
  const running = chromePid !== null;
  return {
    mode: running ? (saved.mode ?? "shared") : null,
    running,
    cdpPort: CDP_PORT,
    viewerPort: viewerPid !== null ? VIEWER_PORT : null,
    display: running && saved.mode === "shared" ? XVFB_DISPLAY : null,
    chromePid,
    viewerPid,
    xvfbPid,
    url: saved.url ?? null,
    startedAt: running ? (saved.startedAt ?? null) : null,
    axiBrowserUrl: running ? AXI_BROWSER_URL : null,
  };
}

async function ensureXvfb(): Promise<number> {
  const existing = readPid(XVFB_PID_PATH);
  if (existing !== null) return existing;

  const child = spawn(
    "Xvfb",
    [XVFB_DISPLAY, "-screen", "0", "1440x900x24", "-ac", "-nolisten", "tcp"],
    { detached: true, stdio: "ignore" },
  );
  if (child.pid === undefined) throw new Error("Failed to start Xvfb");
  child.unref();
  writePid(XVFB_PID_PATH, child.pid);
  await new Promise((r) => setTimeout(r, 400));
  return child.pid;
}

async function startChrome(mode: BrowserMode, startUrl: string): Promise<number> {
  const chrome = findChromeBinary();
  const args = [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    `--remote-debugging-port=${CDP_PORT}`,
    "--remote-allow-origins=*",
    `--user-data-dir=${PROFILE_DIR}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--window-size=1440,900",
    "--use-mock-keychain",
    "--password-store=basic",
  ];

  const env = { ...process.env };
  if (mode === "shared") {
    await ensureXvfb();
    env.DISPLAY = XVFB_DISPLAY;
  } else {
    args.push("--headless=new");
  }
  args.push(startUrl);

  ensureDirs();
  const out = openSync(CHROME_LOG_PATH, "a");
  const child = spawn(chrome, args, {
    detached: true,
    env,
    stdio: ["ignore", out, out],
  });
  if (child.pid === undefined) throw new Error("Failed to start Chrome");
  child.unref();
  writePid(CHROME_PID_PATH, child.pid);

  const ready = await waitFor(() => cdpReady(), 30_000);
  if (!ready) {
    killPid(child.pid, "SIGKILL");
    clearPid(CHROME_PID_PATH);
    throw new Error(
      `Chrome started (pid ${child.pid}) but CDP did not become ready on :${CDP_PORT}. See ${CHROME_LOG_PATH}`,
    );
  }
  return child.pid;
}

async function startViewer(): Promise<number> {
  const existing = readPid(VIEWER_PID_PATH);
  if (existing !== null) return existing;

  const script =
    "/home/bb/plugins/bb-plugin-shared-browser/lib/viewer-server.mjs";
  if (!existsSync(script)) {
    throw new Error(`Viewer script missing: ${script}`);
  }

  ensureDirs();
  const out = openSync(VIEWER_LOG_PATH, "a");
  const child = spawn(process.execPath, [script], {
    detached: true,
    env: {
      ...process.env,
      SHARED_BROWSER_CDP_PORT: String(CDP_PORT),
      SHARED_BROWSER_VIEWER_PORT: String(VIEWER_PORT),
    },
    stdio: ["ignore", out, out],
  });
  if (child.pid === undefined) throw new Error("Failed to start viewer");
  child.unref();
  writePid(VIEWER_PID_PATH, child.pid);

  const ready = await waitFor(async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${VIEWER_PORT}/health`, {
        signal: AbortSignal.timeout(1000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }, 15_000);
  if (!ready) {
    killPid(child.pid, "SIGKILL");
    clearPid(VIEWER_PID_PATH);
    throw new Error(
      `Viewer failed to become ready on :${VIEWER_PORT}. See ${VIEWER_LOG_PATH}`,
    );
  }
  return child.pid;
}

export async function startBrowser(opts: {
  mode: BrowserMode;
  url?: string;
}): Promise<BrowserState> {
  ensureDirs();
  const startUrl = opts.url?.trim() || "about:blank";
  const current = getStatus();

  if (current.running) {
    if (opts.mode === "shared" && current.viewerPid === null) {
      await startViewer();
    }
    if (opts.url) await navigateBrowser(opts.url);
    const next = getStatus();
    writeState({
      ...next,
      mode: opts.mode === "shared" ? "shared" : (next.mode ?? opts.mode),
      url: opts.url ?? next.url,
      startedAt: next.startedAt ?? new Date().toISOString(),
      axiBrowserUrl: AXI_BROWSER_URL,
    });
    return getStatus();
  }

  if (!(await portFree(CDP_PORT))) {
    if (await cdpReady()) {
      throw new Error(
        `Port ${CDP_PORT} already has a CDP Chrome that this plugin does not own. Stop it, or reuse CHROME_DEVTOOLS_AXI_BROWSER_URL=${AXI_BROWSER_URL}.`,
      );
    }
    throw new Error(`Port ${CDP_PORT} is in use. Free it and retry.`);
  }

  await startChrome(opts.mode, startUrl);
  if (opts.mode === "shared") await startViewer();

  writeState({
    ...getStatus(),
    mode: opts.mode,
    url: startUrl === "about:blank" ? null : startUrl,
    startedAt: new Date().toISOString(),
    axiBrowserUrl: AXI_BROWSER_URL,
  });
  return getStatus();
}

export async function stopBrowser(): Promise<BrowserState> {
  const chromePid = readPid(CHROME_PID_PATH);
  const viewerPid = readPid(VIEWER_PID_PATH);
  const xvfbPid = readPid(XVFB_PID_PATH);

  killPid(viewerPid);
  killPid(chromePid);
  await new Promise((r) => setTimeout(r, 400));
  killPid(chromePid, "SIGKILL");
  killPid(viewerPid, "SIGKILL");
  killPid(xvfbPid);
  killPid(xvfbPid, "SIGKILL");

  clearPid(CHROME_PID_PATH);
  clearPid(VIEWER_PID_PATH);
  clearPid(XVFB_PID_PATH);

  const stopped: BrowserState = {
    mode: null,
    running: false,
    cdpPort: CDP_PORT,
    viewerPort: null,
    display: null,
    chromePid: null,
    viewerPid: null,
    xvfbPid: null,
    url: null,
    startedAt: null,
    axiBrowserUrl: null,
  };
  writeState(stopped);
  return stopped;
}

export async function navigateBrowser(url: string): Promise<void> {
  if (!(await cdpReady())) throw new Error("Shared browser is not running");

  const version = (await (
    await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)
  ).json()) as { webSocketDebuggerUrl?: string };
  const list = (await (
    await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)
  ).json()) as Array<{
    type: string;
    webSocketDebuggerUrl?: string;
  }>;
  const page =
    list.find((t) => t.type === "page" && t.webSocketDebuggerUrl) ?? list[0];
  const wsUrl = page?.webSocketDebuggerUrl ?? version.webSocketDebuggerUrl;
  if (!wsUrl) throw new Error("No CDP page target for navigation");

  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const send = (method: string, params?: Record<string, unknown>) => {
      id += 1;
      ws.send(JSON.stringify({ id, method, params }));
    };
    ws.addEventListener("open", () => {
      send("Page.enable");
      send("Page.navigate", { url });
    });
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data)) as { id?: number };
      if (msg.id === 2) {
        ws.close();
        resolve();
      }
    });
    ws.addEventListener("error", () => reject(new Error("CDP navigate failed")));
    setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      resolve();
    }, 5000);
  });

  const saved = readStateFile();
  writeState({
    ...getStatus(),
    mode: saved.mode ?? "shared",
    url,
    startedAt: saved.startedAt ?? new Date().toISOString(),
    axiBrowserUrl: AXI_BROWSER_URL,
  });
}
