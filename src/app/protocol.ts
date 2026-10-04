import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { DATA_DIR, INSTALL_ROOT, STATE_DIR, WINDOWS } from "../runtime/paths";

export const DAEMON_DIR = path.join(STATE_DIR, "daemon");

export function installVersion(): string {
  try {
    return fs.readFileSync(path.join(INSTALL_ROOT, "VERSION"), "utf8").trim() || "dev";
  } catch {
    return "dev";
  }
}

/** A Windows process attaches to one console and keeps it, so a window process
 * there serves exactly one window and is started for it, instead of one process
 * serving every window the way it does elsewhere. */
export const PROCESS_PER_WINDOW = WINDOWS;

/** What a window process is called in the daemon directory: the install
 * version everywhere a process is shared, and an id of its own on Windows. */
export function windowKey(): string {
  return process.env.TODE_WINDOW_KEY || installVersion();
}

/** A named pipe has no filesystem entry, so the address is derived from the key
 * and the install it belongs to (a second install must not answer for this one). */
export function windowPipe(key: string): string {
  const install = crypto.createHash("sha1").update(INSTALL_ROOT).digest("hex").slice(0, 8);
  return `\\\\.\\pipe\\tode-${install}-${key}`;
}

export function daemonAddress(key: string): string {
  return WINDOWS ? windowPipe(key) : path.join(DAEMON_DIR, `${key}.sock`);
}

export function daemonSocket(): string {
  return daemonAddress(windowKey());
}

export function daemonPidFile(): string {
  return path.join(DAEMON_DIR, `${windowKey()}.pid`);
}

/** Windows lists its pipes in the directory too, as `<key>.pipe` files holding
 * the pipe name, so a directory listing finds every window process. */
export function daemonPipeFile(): string {
  return path.join(DAEMON_DIR, `${windowKey()}.pipe`);
}

export function buildStamp(entry: string): string {
  try {
    return String(Math.floor(fs.statSync(entry).mtimeMs));
  } catch {
    return "unknown";
  }
}

export function browserProfileDir(): string {
  const key = crypto.createHash("sha1").update(INSTALL_ROOT).digest("hex").slice(0, 8);
  return path.join(DATA_DIR, "browser", key);
}

export interface OpenRequest {
  cmd: "open";
  tty: string;
  url: string;
  env: Record<string, string | undefined>;
  proxy?: string;
  partition?: string;
  timingFile?: string;
  build?: string;
}

export type Request =
  | OpenRequest
  | { cmd: "resize" }
  | { cmd: "close" }
  | { cmd: "shutdown" }
  | { cmd: "status" }
  | { cmd: "transparency"; on: boolean };

export type Reply =
  | { ok: true; pid: number; windows?: number }
  | { ok: false; error: string }
  | { event: "closed"; code: number };

export function lines(onLine: (line: string) => void): (chunk: Buffer | string) => void {
  let buffer = "";
  return (chunk) => {
    buffer += chunk.toString();
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      onLine(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
  };
}
