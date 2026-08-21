#!/usr/bin/env node
import fs from "node:fs";

import { createInjector } from "./inject";

const upstream = Number(process.argv[2]);
const port = Number(process.argv[3]);
const cssFile = process.argv[4];
const fontFile = process.argv[5];
/** Windows starts this with no streams to redirect — see backgroundOptions in
 * server.ts — so the log is written from here instead. */
const logFile = process.argv[6];
const configFile = process.argv[7];

function say(line: string): void {
  if (!logFile) {
    process.stdout.write(line);
    return;
  }
  try {
    fs.appendFileSync(logFile, line);
  } catch {}
}

if (!upstream || !port || !cssFile) {
  say("usage: injector-main <upstreamPort> <port> <cssFile>\n");
  process.exit(1);
}

process.on("uncaughtException", (error: Error) => {
  say(`tode injector crashed: ${error.stack ?? error.message}\n`);
  process.exit(1);
});

createInjector(upstream, cssFile, fontFile, undefined, configFile).listen(port, "127.0.0.1", () => {
  say(`tode injector ${port} -> ${upstream}\n`);
});
