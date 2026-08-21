#!/usr/bin/env node
// One vite build per page, because vite.config.mts is written for a single page
// at a time (see the note there). A shell would say `TODE_PAGE=shortcuts vite
// build`; cmd.exe has no such prefix, so the variable is set here instead and
// the same command runs everywhere.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vite = path.join(root, "node_modules", "vite", "bin", "vite.js");

for (const page of process.argv.slice(2).length ? process.argv.slice(2) : ["shortcuts", "import"]) {
  const result = spawnSync(process.execPath, [vite, "build"], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, TODE_PAGE: page },
  });
  if (result.status !== 0) {
    process.stderr.write(`build-pages: ${page} failed\n`);
    process.exit(result.status ?? 1);
  }
}
