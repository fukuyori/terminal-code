import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { callerTty, canSplit, cannotOpenPanes, checkTerminal, detect, findOwner, unsupportedGraphicsMessage } from "@zenbu-labs/pixel/terminal";
import type { Direction } from "@zenbu-labs/pixel/terminal";

import { ask, connectDaemon, linesOf, sleep } from "./app/control";
import { DAEMON_DIR, PROCESS_PER_WINDOW, buildStamp, daemonAddress, daemonSocket } from "./app/protocol";
import type { OpenRequest, Reply, Request } from "./app/protocol";
import { CSS_FILE } from "./codeserver/server";
import { shimFile } from "./runtime/paths";
import { bootstrapEntry, daemonEntry, electronBinary } from "./runtime/launcher";
import type { TerminalPalette } from "./terminal/osc";

const APP_NAME = "terminal-code";
const APP_ID = "terminal-code";

export interface LaunchOptions {
  split?: string;
  size?: string;
  stages?: [string, number][];
  proxy?: string;
  partition?: string;
}

function windowCommand(url: string, options: LaunchOptions): string[] {
  const command = [process.execPath, path.resolve(__dirname, "main.js"), "--window", url];
  if (options.proxy) command.push(`--proxy=${options.proxy}`);
  if (options.partition) command.push(`--partition=${options.partition}`);
  return command;
}

function spawnDaemon(windowKey?: string): void {
  const env: Record<string, string | undefined> = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith("PIXEL_") && key !== "ELECTRON_RUN_AS_NODE",
    ),
  );
  if (windowKey) env.TODE_WINDOW_KEY = windowKey;
  fs.mkdirSync(DAEMON_DIR, { recursive: true });
  const log = fs.openSync(path.join(DAEMON_DIR, "daemon.log"), "a");
  // A Windows window process attaches to this process's console to draw, and
  // the handles it reads and writes the console modes through are the ones it
  // inherits: ignored, they are not a console, and the attach fails with an
  // invalid handle. It also goes when this console does, so it is not detached.
  const child = PROCESS_PER_WINDOW
    ? spawn(electronBinary(), [bootstrapEntry(), daemonEntry()], {
        stdio: ["inherit", "inherit", log],
        env,
      })
    : spawn(electronBinary(), [bootstrapEntry(), daemonEntry()], {
        detached: true,
        stdio: ["ignore", "ignore", log],
        env,
      });
  child.on("error", () => {});
  child.unref();
}

// Started by a program embedding tode in its own screen, or from inside
// another pixel app's pane: the window joins that host, so nothing here may
// probe or split the terminal.
function hosted(tty: string): boolean {
  return Boolean(process.env.PIXEL_EMBED) || findOwner(tty) !== null;
}

function windowTty(): string | null {
  return process.env.PIXEL_TTY ?? callerTty().path;
}

const OPEN_TIMEOUT_MS = 20_000;

async function daemonConnection(): Promise<net.Socket> {
  try {
    return await connectDaemon(daemonSocket());
  } catch {}
  spawnDaemon();
  const deadline = Date.now() + OPEN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      return await connectDaemon(daemonSocket());
    } catch {
      await sleep(100);
    }
  }
  throw new Error("the tode window process did not start");
}

/** What the engine needs to draw into the console this process is attached to:
 * Windows has no tty to open, so the window process is told whose console to
 * attach to, and under WezTerm what size the pane is, because a Windows console
 * reports no pixel size. */
function windowsConsole(): Record<string, string> {
  const env: Record<string, string> = { TERMINAL_BROWSER_CONSOLE_PID: String(process.pid) };
  if (process.env.WEZTERM_PANE === undefined) return env;
  try {
    const panes = JSON.parse(
      execFileSync("wezterm", ["cli", "list", "--format", "json"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      }),
    ) as Array<{ pane_id: number; size?: { cols?: number; rows?: number; pixel_width?: number; pixel_height?: number } }>;
    const size = panes.find((pane) => String(pane.pane_id) === process.env.WEZTERM_PANE)?.size;
    if (size) {
      env.TERMINAL_BROWSER_COLS = String(size.cols ?? 0);
      env.TERMINAL_BROWSER_ROWS = String(size.rows ?? 0);
      env.TERMINAL_BROWSER_WIDTH_PX = String(size.pixel_width ?? 0);
      env.TERMINAL_BROWSER_HEIGHT_PX = String(size.pixel_height ?? 0);
    }
  } catch {}
  return env;
}

/** Windows: one process per window, started here and under a name of its own.
 * The process keeps the console it attaches to, so it cannot be shared. */
async function openWindowProcess(request: OpenRequest): Promise<{ socket: net.Socket; reply: Reply }> {
  const key = `${Date.now().toString(36)}-${process.pid.toString(36)}`;
  const address = daemonAddress(key);
  spawnDaemon(key);
  const deadline = Date.now() + OPEN_TIMEOUT_MS;
  let socket: net.Socket | null = null;
  while (!socket && Date.now() < deadline) {
    try {
      socket = await connectDaemon(address);
    } catch {
      await sleep(100);
    }
  }
  if (!socket) throw new Error("the tode window process did not start");
  const reply = await ask(socket, { ...request, env: { ...request.env, ...windowsConsole() } }, OPEN_TIMEOUT_MS);
  return { socket, reply };
}

function stale(reply: Reply): boolean {
  return "ok" in reply && !reply.ok && reply.error === "stale";
}

async function daemonGone(within: number): Promise<void> {
  const deadline = Date.now() + within;
  while (Date.now() < deadline) {
    try {
      (await connectDaemon(daemonSocket())).destroy();
    } catch {
      return;
    }
    await sleep(100);
  }
}

async function openSession(request: OpenRequest): Promise<{ socket: net.Socket; reply: Reply }> {
  if (PROCESS_PER_WINDOW) return openWindowProcess(request);
  const build = buildStamp(daemonEntry());
  let socket = await daemonConnection();
  let reply = await ask(socket, { ...request, build }, OPEN_TIMEOUT_MS);
  if (stale(reply)) {
    socket.destroy();
    await daemonGone(5000);
    socket = await daemonConnection();
    reply = await ask(socket, { ...request, build }, OPEN_TIMEOUT_MS);
  }
  return { socket, reply };
}

function attachWindow(url: string, options: LaunchOptions): { exited: Promise<number>; close(): void } {
  let send = (_request: Request) => {};
  let closeRequested = false;
  const exited = (async () => {
    const tty = windowTty();
    if (!tty) {
      process.stderr.write("tode needs a terminal to draw on\n");
      return 1;
    }
    if (!hosted(tty)) {
      const check = await checkTerminal(detect());
      if (check.graphics === "unsupported") {
        process.stderr.write(unsupportedGraphicsMessage(process.stderr.isTTY === true));
        return 1;
      }
    }
    let session: { socket: net.Socket; reply: Reply };
    try {
      session = await openSession({
        cmd: "open",
        tty,
        url,
        env: process.env,
        proxy: options.proxy,
        partition: options.partition,
        timingFile: `${CSS_FILE}.timing.json`,
      });
    } catch (error) {
      process.stderr.write(`could not open the tode window: ${(error as Error).message}\n`);
      return 1;
    }
    const { socket, reply } = session;
    send = (request: Request) => {
      try {
        socket.write(`${JSON.stringify(request)}\n`);
      } catch {}
    };
    if ("ok" in reply && !reply.ok) {
      process.stderr.write(`could not open the tode window: ${reply.error}\n`);
      socket.destroy();
      return 1;
    }
    if (closeRequested) {
      send({ cmd: "close" });
      socket.end();
      return 0;
    }
    return new Promise<number>((resolve) => {
      linesOf(socket).on("line", (event: Reply) => {
        if ("event" in event && event.event === "closed") resolve(event.code);
      });
      socket.on("close", () => resolve(0));
      socket.on("error", () => resolve(1));
      process.on("SIGWINCH", () => send({ cmd: "resize" }));
      // The pane is going away either way; a window process that never
      // confirms the close must not keep this shell waiting.
      for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
        process.on(signal, () => {
          send({ cmd: "close" });
          setTimeout(() => resolve(130), 3000).unref();
        });
      }
    });
  })();
  return {
    exited,
    close() {
      closeRequested = true;
      send({ cmd: "close" });
    },
  };
}

export function registerSelf(): void {
  const bin = shimFile();
  if (!fs.existsSync(bin)) return;
  const override = process.env.TERMINAL_BROWSER_INTEROP_DIR;
  const root =
    override && path.isAbsolute(override)
      ? override
      : path.join(os.homedir(), ".local", "share", "terminal-browser-interop");
  const record = {
    version: 1,
    id: APP_ID,
    name: APP_NAME,
    bin,
    args: ["."],
    registeredAt: Date.now(),
  };
  try {
    fs.mkdirSync(path.join(root, "apps"), { recursive: true });
    fs.writeFileSync(path.join(root, "apps", `${APP_ID}.json`), `${JSON.stringify(record, null, 2)}\n`);
  } catch {}
}

export class Pane {
  private exit: Promise<number> | null = null;
  private closeWindow: (() => void) | null = null;

  constructor(private readonly options: LaunchOptions = {}) {}

  close(): void {
    this.closeWindow?.();
  }

  owned(): boolean {
    return this.exit !== null;
  }

  open(url: string): void {
    if (this.exit) return;
    try {
      fs.writeFileSync(
        `${CSS_FILE}.launch.json`,
        JSON.stringify({ spawnedAt: Date.now(), stages: this.options.stages ?? [] }),
      );
    } catch {}
    this.exit = this.options.split ? this.openSplit(url, this.options.split) : this.openHere(url);
  }

  exited(): Promise<number> {
    return this.exit ?? new Promise<number>(() => {});
  }

  private openHere(url: string): Promise<number> {
    const window = attachWindow(url, this.options);
    this.closeWindow = () => window.close();
    return window.exited;
  }

  private async openSplit(url: string, direction: string): Promise<number> {
    const tty = windowTty();
    if (tty && hosted(tty)) {
      process.stderr.write("--split is not available inside another program's pane\n");
      return 1;
    }
    const terminal = detect();
    if (!canSplit(terminal)) {
      process.stderr.write(`${cannotOpenPanes(terminal)}\n`);
      return 1;
    }
    const from = await terminal!.getCurrentPane?.({ tty, cwd: process.cwd() });
    if (!from) {
      process.stderr.write(`could not work out which ${terminal!.name} pane this is\n`);
      return 1;
    }
    const size = Number(this.options.size);
    await terminal!.split!({
      from,
      direction: direction as Direction,
      command: windowCommand(url, this.options),
      size: Number.isFinite(size) && size > 0 ? size : null,
      tty,
    });
    return 0;
  }
}

export function launchBrowser(
  url: string,
  _palette: TerminalPalette,
  options: LaunchOptions = {},
): Promise<number> {
  const pane = new Pane(options);
  pane.open(url);
  return pane.exited();
}
