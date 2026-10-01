import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { DATA_DIR, INSTALL_ROOT, STATE_DIR } from "../runtime/paths";

export const DAEMON_DIR = path.join(STATE_DIR, "daemon");

export function installVersion(): string {
  try {
    return fs.readFileSync(path.join(INSTALL_ROOT, "VERSION"), "utf8").trim() || "dev";
  } catch {
    return "dev";
  }
}

export function daemonSocket(): string {
  return path.join(DAEMON_DIR, `${installVersion()}.sock`);
}

export function daemonPidFile(): string {
  return path.join(DAEMON_DIR, `${installVersion()}.pid`);
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
