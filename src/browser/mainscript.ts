import type { MainCtx, ThemeMessage, TimingMessage } from "./ctx";

export function browserMain(ctx: MainCtx): void {
  const fs = require("node:fs") as typeof import("node:fs");
  const { parseRawColors } = require(ctx.modules.livesync) as typeof import("../livesync");
  const { generateTheme } = require(ctx.modules.generate) as typeof import("../theme/generate");
  const {
    sendToExtension: sendToWindow,
    listEndpoints,
    forgetEndpoint,
  } = require(ctx.modules.ipc) as typeof import("../ipc");
  const { ipcMain } = require("electron") as {
    ipcMain: { on(channel: string, listener: (event: unknown, message: unknown) => void): void };
  };

  ipcMain.on("tode:message", (_event, message) => {
    const timed = message as TimingMessage | null | undefined;
    if (timed && timed.type === "timing" && timed.page) {
      try {
        fs.writeFileSync(ctx.timingFile, JSON.stringify(timed.page));
      } catch { }
      return;
    }
    const themed = message as ThemeMessage | null | undefined;
    if (!themed || themed.type !== "theme" || !themed.colors) return;
    // A theme set from a file is the user's answer to what the editor wears.
    // The terminal changing its colours underneath is not a reason to overrule
    // it, and the window that received one would write it back over the choice.
    if (fs.existsSync(ctx.themeChoiceFile)) return;
    const palette = parseRawColors(JSON.stringify(themed.colors));
    if (!palette) return;
    const theme = generateTheme(palette) as unknown as Record<string, unknown>;
    for (const endpoint of listEndpoints(ctx.socketDir)) {
      sendToWindow(endpoint.address, { files: [], folders: [], add: false, theme }).catch(
        (error: NodeJS.ErrnoException) => {
          if (
            error &&
            (error.code === "ECONNREFUSED" || error.code === "ENOENT" || error.code === "EPIPE")
          ) {
            forgetEndpoint(endpoint);
          }
        },
      );
    }
  });
}
