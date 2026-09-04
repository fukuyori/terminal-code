import fs from "node:fs";
import path from "node:path";

import type { MainCtx, PreloadCtx } from "./browser/ctx";
import { browserMain } from "./browser/mainscript";
import { preloadMain } from "./browser/preload";
import { CSS_FILE } from "./codeserver/server";
import { DATA_DIR, IPC_DIR } from "./runtime/paths";
import { THEME_CHOICE_FILE } from "./profile";

export function ipcSocketDir(): string {
  return IPC_DIR;
}

export function preloadSource(ctx: PreloadCtx): string {
  return `"use strict";\n(${preloadMain.toString()})(${JSON.stringify(ctx)});\n`;
}

export function mainScriptSource(ctx: MainCtx): string {
  return `"use strict";\n(${browserMain.toString()})(${JSON.stringify(ctx)});\n`;
}

export function writeBrowserScripts(): { preload: string; mainScript: string } {
  const preload = path.join(DATA_DIR, "browser-preload.js");
  const mainScript = path.join(DATA_DIR, "browser-main.js");
  const ctx: MainCtx = {
    socketDir: ipcSocketDir(),
    themeChoiceFile: THEME_CHOICE_FILE,
    // the same file `tode timing` reads; the proxy used to write it from a
    // beacon route, now the preload's message lands it here
    timingFile: `${CSS_FILE}.timing.json`,
    modules: {
      livesync: path.join(__dirname, "livesync.js"),
      generate: path.join(__dirname, "theme", "generate.js"),
      ipc: path.join(__dirname, "ipc.js"),
    },
  };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(preload, preloadSource({}));
  fs.writeFileSync(mainScript, mainScriptSource(ctx));
  return { preload, mainScript };
}
