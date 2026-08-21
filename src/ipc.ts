import fs from "node:fs";
import net from "node:net";
import path from "node:path";

export interface OpenFile {
  path: string;
  line?: number;
  column?: number;
}

export interface OpenRequest {
  files: OpenFile[];
  folders: string[];
  add: boolean;
  wait?: boolean;
  diff?: string[];
  view?: string;
  theme?: Record<string, unknown>;
  /** close the window this reaches, the same way the quit chord does */
  quit?: boolean;
}

/** Windows has no socket in the filesystem, so a window advertises itself with a
 * small file naming the pipe it listens on. Everywhere else the file in the ipc
 * directory is the socket. */
export function isPipeName(endpoint: string): boolean {
  return endpoint.startsWith("\\\\.\\pipe\\") || endpoint.startsWith("\\\\?\\pipe\\");
}

export function runningWindow(): string | null {
  const endpoint = process.env.TODE_IPC;
  if (!endpoint) return null;
  if (isPipeName(endpoint)) return endpoint;
  try {
    return fs.statSync(endpoint).isSocket() ? endpoint : null;
  } catch {
    return null;
  }
}

export interface Endpoint {
  /** the entry in the ipc directory, removed when the window turns out to be gone */
  file: string;
  /** what net.connect takes: a socket path, or a pipe name */
  address: string;
}

/** Every window currently advertising itself. */
export function listEndpoints(dir: string): Endpoint[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const found: Endpoint[] = [];
  for (const name of names) {
    const file = path.join(dir, name);
    if (name.endsWith(".sock")) {
      found.push({ file, address: file });
      continue;
    }
    if (!name.endsWith(".pipe")) continue;
    try {
      const address = fs.readFileSync(file, "utf8").trim();
      if (address) found.push({ file, address });
    } catch {}
  }
  return found;
}

export function forgetEndpoint(endpoint: Endpoint): void {
  try {
    fs.rmSync(endpoint.file, { force: true });
  } catch {}
}

export function sendToExtension(socket: string, request: OpenRequest, timeoutMs = 4000): Promise<void> {
  return new Promise((resolve, reject) => {
    const connection = net.connect(socket);
    const timer = timeoutMs
      ? setTimeout(() => {
        connection.destroy();
        reject(new Error("the tode window did not answer"));
      }, timeoutMs)
      : null;
    let buffer = "";
    const settle = (error: Error | null) => {
      if (timer) clearTimeout(timer);
      connection.destroy();
      if (error) reject(error);
      else resolve();
    };
    connection.on("connect", () => connection.write(`${JSON.stringify(request)}\n`));
    connection.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (!buffer.includes("\n")) return;
      try {
        const reply = JSON.parse(buffer.split("\n")[0]) as { ok?: boolean; error?: string };
        settle(reply.ok ? null : new Error(reply.error ?? "the window refused"));
      } catch {
        settle(new Error("the window sent something unreadable"));
      }
    });
    connection.on("error", (error) => settle(error));
  });
}

export function parseGoto(argument: string): OpenFile {
  if (fs.existsSync(argument)) return { path: argument };
  const match = /^(.*?):(\d+)(?::(\d+))?$/.exec(argument);
  if (!match) return { path: argument };
  return {
    path: match[1],
    line: Number(match[2]),
    column: match[3] ? Number(match[3]) : 1,
  };
}
