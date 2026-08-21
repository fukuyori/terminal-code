import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { DATA_DIR, LOGS_DIR, STATE_DIR, WINDOWS } from "../runtime/paths";
import type { Command } from "../runtime/platform";
import type { ServerDist } from "./vendored";
import { SERVER_LABEL, ensureServerDist, installedServer, narrateFetch } from "./vendored";

const VSCODE_DIR = path.join(DATA_DIR, "vscode");

/** Where the profile lives. The reh-web server does not serve out of the
 * --user-data-dir it is given: it keeps the profile under its server data
 * directory, as <root>/data/User and <root>/extensions. Pointing --server-data-dir
 * at VSCODE_DIR is what makes those the very directories tode writes to, so the
 * extensions it installs are the ones the workbench loads.
 *
 * Settings are a different story: the web workbench takes its user settings
 * from the browser, not from this directory, so what tode wants is handed to
 * the page instead — see withConfigurationDefaults in inject.ts. */
export const USER_DATA_DIR = WINDOWS
  ? path.join(VSCODE_DIR, "data")
  : path.join(VSCODE_DIR, "user-data");
const EXTENSIONS_PATH = path.join(VSCODE_DIR, "extensions");
export const STATE_FILE = path.join(STATE_DIR, "server.json");

export interface ServerState {
  pid: number;
  port: number;
  /** the injecting proxy the browser actually talks to */
  injectorPid: number;
  injectorPort: number;
  version: string;
  startedAt: number;
}
/**
 * this is odd i would say
 */

export const CSS_FILE = path.join(DATA_DIR, "inject.css");
/** The settings the workbench is handed in its document. See
 * withConfigurationDefaults in inject.ts for why they cannot simply be written
 * into the profile. */
export const WEB_CONFIG_FILE = path.join(DATA_DIR, "web-defaults.json");
// kept apart from the run state, which is cleared on every stop
export const PORT_FILE = path.join(DATA_DIR, "injector.port");

function fontAsset(): string {
  for (let dir = __dirname; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "assets", "fonts", "JetBrainsMono-Regular.ttf");
    if (fs.existsSync(candidate)) return candidate;
    if (path.dirname(dir) === dir) return "";
  }
}

export const LOG_FILE = path.join(LOGS_DIR, "code-server.log");

/** Starts something that has to outlive this command, and returns its pid.
 *
 * posix detaches and keeps the streams, appending them to tode's log.
 *
 * Windows has to be asked differently, because the two obvious answers each
 * break the other half of what a background editor server needs:
 *
 *   detached     the process gets no console at all, so every console program
 *                *it* forks — the extension host, the file watcher, git — is
 *                given a console of its own, and a console with no parent is a
 *                terminal window drawn on top of the editor.
 *   windowsHide  the process inherits the terminal's console, so nothing new is
 *                drawn, but closing the pane closes that console and takes the
 *                server with it.
 *
 * What is wanted is a console of its own with no window, which is what
 * Start-Process -WindowStyle Hidden makes. Its children inherit that console
 * and so draw nothing either, and it belongs to no terminal, so the pane can
 * come and go. -PassThru reports the pid, which is what tode records.
 *
 * The streams are the price: nothing is redirected, so the editor server writes
 * its own logs under its data directory, and the injector is handed the log
 * path and writes there itself. */
async function startWindowsBackground(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  label: string,
): Promise<number> {
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const script = path.join(STATE_DIR, `${label}.start.ps1`);
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(
    script,
    `$p = Start-Process -FilePath ${quote(file)} -ArgumentList ${args
      .map(quote)
      .join(",")} -WindowStyle Hidden -PassThru
$p.Id
`,
  );
  const reported = await new Promise<string>((resolve, reject) => {
    execFile(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script],
      { encoding: "utf8", windowsHide: true, env },
      (error, stdout, stderr) => {
        if (error) reject(new Error(stderr.trim() || error.message));
        else resolve(stdout);
      },
    );
  });
  const pid = Number(reported.trim().split(/\s+/).pop());
  if (!pid) throw new Error(`could not start ${label}: the launcher reported no pid`);
  // kept only when it failed, where it says what was tried
  fs.rmSync(script, { force: true });
  return pid;
}

async function startBackground(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  log: number,
  label: string,
): Promise<number> {
  if (WINDOWS) return startWindowsBackground(file, args, env, label);
  const child = spawn(file, args, { detached: true, stdio: ["ignore", log, log], env });
  child.unref();
  if (!child.pid) throw new Error(`could not start ${label}`);
  return child.pid;
}

export function serverCommand(): Command {
  const found = installedServer();
  if (found) return found.command;
  throw new Error(`${SERVER_LABEL} not found`);
}

/** The flags that start the workbench, per server. code-server takes its own
 * dialect; the reh-web server takes vscode's. */
function serveArgs(dist: ServerDist, port: number): string[] {
  const shared = ["--user-data-dir", USER_DATA_DIR, "--extensions-dir", EXTENSIONS_PATH];
  if (dist.kind === "reh-web") {
    return [
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--without-connection-token",
      "--accept-server-license-terms",
      "--server-data-dir",
      VSCODE_DIR,
      // Undocumented on this server — it is not in --help — but honoured, and
      // without it a folder opens in restricted mode, where every extension
      // that is not one of vscode's own stays disabled. That includes tode's
      // bridge, so nothing answers the quit chord, and tode's theme, so the
      // workbench ignores the terminal's colours.
      "--disable-workspace-trust",
      "--telemetry-level",
      "off",
      ...shared,
    ];
  }
  return [
    "--auth",
    "none",
    "--bind-addr",
    `127.0.0.1:${port}`,
    ...shared,
    "--app-name",
    "tode",
    "--disable-telemetry",
    "--disable-update-check",
    "--disable-workspace-trust",
    "--disable-getting-started-override",
    "--ignore-last-opened",
  ];
}

/** code-server reads its marketplace out of the environment, so tode points it
 * at the one vscode itself uses. The reh-web server takes its gallery from the
 * product.json it shipped with — Open VSX for VSCodium — and honours the
 * VSCODE_GALLERY_* variables if the user would rather have another one, so
 * nothing is forced here. */
function galleryEnv(dist: ServerDist): NodeJS.ProcessEnv {
  if (dist.kind !== "code-server") return {};
  return {
    EXTENSIONS_GALLERY: JSON.stringify({
      serviceUrl: "https://marketplace.visualstudio.com/_apis/public/gallery",
      itemUrl: "https://marketplace.visualstudio.com/items",
      cacheUrl: "https://vscode.blob.core.windows.net/gallery/index",
      controlUrl: "",
    }),
  };
}

/** The flags every server understands for extension work, so `tode
 * --install-extension` reaches the same profile the workbench uses. */
export function extensionArgs(): string[] {
  return ["--extensions-dir", EXTENSIONS_PATH, "--user-data-dir", USER_DATA_DIR];
}

function readState(): ServerState | null {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as ServerState;
  } catch {
    return null;
  }
}

function writeState(state: ServerState) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function answering(port: number, timeout = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    const settle = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeout, () => settle(false));
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
  });
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => {
        if (address && typeof address === "object") resolve(address.port);
        else reject(new Error("no port assigned"));
      });
    });
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function currentServer(): Promise<ServerState | null> {
  const state = readState();
  if (!state || !running(state.pid) || !running(state.injectorPid)) return null;
  const [up, proxied] = await Promise.all([answering(state.port), answering(state.injectorPort)]);
  return up && proxied ? state : null;
}

function serverVersion(command: Command): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      command.file,
      [...command.args, "--version"],
      { encoding: "utf8", windowsHide: true },
      (error, stdout) => {
        resolve(error ? "unknown" : stdout.split("\n")[0].trim());
      },
    );
  });
}

let booting: Promise<ServerState> | null = null;

export function ensureServer(): Promise<ServerState> {
  if (!booting) {
    booting = startServer();
    booting.catch(() => {
      booting = null;
    });
  }
  return booting;
}

async function startServer(): Promise<ServerState> {
  const existing = await currentServer();
  if (existing) return existing;

  const dist = await ensureServerDist(narrateFetch(SERVER_LABEL));
  // asked now, awaited after the injector is up — the version is a detail for
  // `tode daemon status`, not something the boot should stall on
  const version = serverVersion(dist.command);
  const port = await freePort();
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  const log = fs.openSync(LOG_FILE, "a");
  const pid = await startBackground(
    dist.command.file,
    [...dist.command.args, ...serveArgs(dist, port)],
    { ...process.env, ...galleryEnv(dist) },
    log,
    "editor-server",
  );

  const injector = await startInjector(port, log);
  void codeServerReady(port, pid).then((up) => {
    if (up) void warmUp(injector.port);
  });
  const state = {
    pid,
    port,
    injectorPid: injector.pid,
    injectorPort: injector.port,
    version: await version,
    startedAt: Date.now(),
  };
  writeState(state);
  return state;
}

async function codeServerReady(port: number, pid: number): Promise<boolean> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await answering(port)) return true;
    if (!running(pid)) return false;
    await sleep(60);
  }
  return false;
}

async function injectorPort(portFile: string): Promise<number> {
  let previous = 0;
  try {
    previous = Number(fs.readFileSync(portFile, "utf8").trim());
  } catch {}
  const port = previous && (await available(previous)) ? previous : await freePort();
  fs.mkdirSync(path.dirname(portFile), { recursive: true });
  fs.writeFileSync(portFile, String(port));
  return port;
}

export function available(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

export async function startInjector(
  upstream: number,
  log: number,
  portFile = PORT_FILE,
): Promise<{ pid: number; port: number }> {
  const port = await injectorPort(portFile);
  // interesting? a script?
  const script = path.join(__dirname, "injector-main.js");
  const font = fontAsset();
  const pid = await startBackground(
    process.execPath,
    [script, String(upstream), String(port), CSS_FILE, font, LOG_FILE, WEB_CONFIG_FILE],
    process.env,
    log,
    "injector",
  );
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await answering(port)) return { pid, port };
    if (!running(pid)) throw new Error("the css injector exited during start");
    await sleep(40);
  }
  throw new Error("the css injector did not start within 10s");
}

async function warmUp(port: number): Promise<void> {
  try {
    const page = await fetch(`http://127.0.0.1:${port}/`, {
      headers: { accept: "text/html" },
    });
    const html = await page.text();
    const assets = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map((m) => m[1]);
    await Promise.all(
      assets.slice(0, 4).map((asset) =>
        fetch(new URL(asset, `http://127.0.0.1:${port}/`)).then((r) => r.arrayBuffer()).catch(() => null),
      ),
    );
  } catch {}
}

export function stopServer(): boolean {
  const state = readState();
  if (!state) return false;
  let stopped = false;
  for (const pid of [state.injectorPid, state.pid]) {
    if (pid && running(pid)) {
      process.kill(pid, "SIGTERM");
      stopped = true;
    }
  }
  fs.rmSync(STATE_FILE, { force: true });
  return stopped;
}

export function origin(state: ServerState): string {
  return `http://127.0.0.1:${state.injectorPort}/`;
}
