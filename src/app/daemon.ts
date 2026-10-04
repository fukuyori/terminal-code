import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { app, ipcMain } from "@zenbu-labs/pixel/electron";
import { WebView, createRoot } from "@zenbu-labs/pixel";
import type { Root, WebViewHandle } from "@zenbu-labs/pixel";
import { createElement } from "react";

import { forgetEndpoint, listEndpoints, sendToExtension } from "../ipc";
import { parseRawColors } from "../livesync";
import { THEME_CHOICE_FILE, cachedPalette, currentTheme, installActiveTheme, installCss, themeBackground, transparencyEnabled } from "../profile";
import { IPC_DIR } from "../runtime/paths";
import type { TerminalPalette } from "../terminal/osc";
import { MESSAGE_CHANNEL } from "./messages";
import type { ThemeMessage, TimingMessage } from "./messages";
import { PROCESS_PER_WINDOW, browserProfileDir, buildStamp, daemonPidFile, daemonPipeFile, daemonSocket, lines } from "./protocol";
import type { OpenRequest, Reply, Request } from "./protocol";

fs.mkdirSync(browserProfileDir(), { recursive: true });
app.setPath("userData", browserProfileDir());
app.setPath("sessionData", browserProfileDir());

const IDLE_EXIT_MS = 15_000;
const SOCKET = daemonSocket();
const BUILD = buildStamp(__filename);

interface Window {
  view: WebViewHandle | null;
  request: OpenRequest;
  transparent: boolean;
}

const windows = new Map<Root, Window>();
let idle: ReturnType<typeof setTimeout> | null = null;
let lastPalette: TerminalPalette | null = null;

// A process that serves one window has nothing left to do once it closes.
const CLOSED_EXIT_MS = 300;

function scheduleIdleExit(afterClose = false) {
  if (idle) clearTimeout(idle);
  idle = setTimeout(
    () => {
      if (windows.size === 0) app.exit(0);
    },
    afterClose && PROCESS_PER_WINDOW ? CLOSED_EXIT_MS : IDLE_EXIT_MS,
  );
}

ipcMain.on(MESSAGE_CHANNEL, (event, message: ThemeMessage | TimingMessage | null) => {
  if (!message) return;
  if (message.type === "timing" && message.page) {
    const timingFile = [...windows.values()].find((window) => window.view?.webContents.id === event.sender.id)
      ?.request.timingFile;
    if (timingFile) {
      try {
        fs.writeFileSync(timingFile, JSON.stringify(message.page));
      } catch {}
    }
    return;
  }
  if (message.type !== "theme" || !message.colors) return;
  const palette = parseRawColors(JSON.stringify(message.colors));
  if (!palette) return;
  lastPalette = palette;
  broadcastTheme(palette);
});

function broadcastTheme(palette: TerminalPalette) {
  // A theme set from a file is the user's answer to what the editor wears. The
  // terminal changing its colours underneath is not a reason to overrule it.
  if (fs.existsSync(THEME_CHOICE_FILE)) return;
  const theme = currentTheme(palette) as unknown as Record<string, unknown>;
  for (const endpoint of listEndpoints(IPC_DIR)) {
    sendToExtension(endpoint.address, { files: [], folders: [], add: false, theme }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error && (error.code === "ECONNREFUSED" || error.code === "ENOENT" || error.code === "EPIPE")) {
          forgetEndpoint(endpoint);
        }
      },
    );
  }
}

function page(window: Window, url: string) {
  return createElement(WebView, {
    key: window.transparent ? "clear" : "opaque",
    ref: (handle: WebViewHandle | null) => {
      window.view = handle;
    },
    src: url,
    style: { width: "100%", height: "100%" },
    preload: path.join(__dirname, "preload.js"),
    proxy: window.request.proxy,
    partition: window.request.partition,
    clipboardRead: true,
    onOpenWindow: "popup",
    onContextMenu: () => {},
    ...(window.transparent ? { browserWindowOptions: { transparent: true, backgroundColor: "#00000000" } } : {}),
  });
}

function applyTransparency(on: boolean) {
  const palette = lastPalette ?? cachedPalette();
  if (palette) {
    // the active theme is the chosen file's when there is one, and the
    // terminal's colours otherwise; either way it is painted clear or opaque
    const theme = installActiveTheme(palette, on);
    installCss(palette, themeBackground(theme, palette), on);
  }
  for (const [root, window] of windows) {
    if (window.transparent === on) continue;
    const url = window.view?.state.url || window.request.url;
    window.transparent = on;
    window.view = null;
    root.render(page(window, url));
  }
}

function openWindow(request: OpenRequest, onClosed: (code: number) => void): Root {
  const root = createRoot({
    name: "tode",
    tty: request.tty,
    sessionEnv: request.env,
    onExit(code) {
      if (!windows.delete(root)) return;
      onClosed(code);
      scheduleIdleExit(true);
    },
  });
  const window: Window = { view: null, request, transparent: transparencyEnabled() };
  try {
    root.render(page(window, request.url));
    windows.set(root, window);
  } catch (error) {
    root.stop(1);
    throw error;
  }
  return root;
}

function serve() {
  fs.mkdirSync(path.dirname(daemonPidFile()), { recursive: true });
  // a pipe has no file to clear away; its name is listed in a file of its own
  if (PROCESS_PER_WINDOW) fs.writeFileSync(daemonPipeFile(), `${SOCKET}\n`);
  else fs.rmSync(SOCKET, { force: true });
  try {
    fs.writeFileSync(daemonPidFile(), String(process.pid));
    process.on("exit", () => {
      for (const file of [daemonPidFile(), daemonPipeFile()]) {
        try {
          fs.rmSync(file, { force: true });
        } catch {}
      }
    });
  } catch {}
  const server = net.createServer((connection) => {
    let root: Root | null = null;
    const reply = (value: Reply) => {
      try {
        connection.write(`${JSON.stringify(value)}\n`);
      } catch {}
    };
    connection.on(
      "data",
      lines((line) => {
        const request = JSON.parse(line) as Request;
        switch (request.cmd) {
          case "open":
            if (root) return;
          
            if (request.build && request.build !== BUILD && windows.size === 0) {
              reply({ ok: false, error: "stale" });
              connection.end(() => setTimeout(() => app.exit(0), 50));
              return;
            }
            if (idle) clearTimeout(idle);
            try {
              root = openWindow(request, (code) => {
                reply({ event: "closed", code });
                connection.end();
              });
              reply({ ok: true, pid: process.pid });
            } catch (error) {
              reply({ ok: false, error: error instanceof Error ? error.message : String(error) });
              connection.end();
              scheduleIdleExit();
            }
            return;
          case "resize":
            root?.nudgeResize();
            return;
          case "close":
            root?.stop();
            return;
          case "shutdown":
            reply({ ok: true, pid: process.pid, windows: windows.size });
            connection.end();
            for (const open of windows.keys()) open.stop();
            setTimeout(() => app.exit(0), 100);
            return;
          case "status":
            reply({ ok: true, pid: process.pid, windows: windows.size });
            connection.end();
            return;
          case "transparency":
            applyTransparency(request.on);
            reply({ ok: true, pid: process.pid });
            connection.end();
            return;
        }
      }),
    );
    connection.on("error", () => {});
    connection.on("close", () => root?.stop());
  });
  server.on("error", (error) => {
    process.stderr.write(`tode window: socket error: ${error.message}\n`);
    app.exit(1);
  });
  server.listen(SOCKET);
  scheduleIdleExit();
}

if (PROCESS_PER_WINDOW) {
  // started for one window, under a name of its own: nothing else serves it
  serve();
} else {
  // A window process for this version may already be serving the socket.
  const probe = net.connect(SOCKET);
  probe.once("connect", () => {
    probe.destroy();
    app.exit(0);
  });
  probe.once("error", () => serve());
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    for (const open of windows.keys()) open.stop();
    setTimeout(() => app.exit(0), 200);
  });
}
