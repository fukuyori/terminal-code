#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  CSS_FILE,
  ensureServer,
  extensionArgs,
  origin,
  serverCommand,
  stopServer,
} from "./codeserver/server";
import { SERVER_LABEL, ensureServerDist, narrateFetch } from "./codeserver/vendored";
import { installBridge, requestColorTheme, requestStartupOpen } from "./bridge";
import { BOOT_AFTER_APPLY, autoApplyShared, shortcutsCommand } from "./shortcuts/wizard";
import { importCommand } from "./import/command";
import { runOnboarding } from "./onboarding";
import { forgetEndpoint, listEndpoints, parseGoto, runningWindow, sendToExtension } from "./ipc";
import type { OpenFile } from "./ipc";
import { registerThemeExtension } from "./profile";
import {
  ensureFont,
  forgetThemeChoice,
  installActiveTheme,
  selectTodeTheme,
  installCss,
  installKeybindings,
  setLiveTheme,
  setThemeFile,
  installSettings,
  installTheme,
  readPalette,
  themeBackground,
} from "./profile";
import { Pane, launchBrowser } from "./launch";
import { resolveRuntime, resolveRuntimeWithProgress } from "./runtime/release";
import { INSTALL_ROOT, IPC_DIR, shimFile } from "./runtime/paths";
import { commandWith } from "./runtime/platform";
import { skillCommand } from "./skill";
import { resolveTarget, workbenchUrl } from "./target";
import { uninstallCommand } from "./uninstall";
import { upgrade } from "./upgrade";
import { restoreTerminal } from "./terminal/osc";
import { hex } from "./theme/color";
import { THEME_NAME, generateTheme, semanticColors } from "./theme/generate";

function todeCommand(): string[] {
  const shim = shimFile();
  if (fs.existsSync(shim)) return [shim];
  return [process.execPath, process.argv[1]];
}

async function bootEditorUrl(): Promise<string> {
  const { palette } = await readPalette();
  ensureFont();
  const theme = installActiveTheme(palette);
  installCss(palette, themeBackground(theme, palette));
  installSettings();
  installBridge(todeCommand());
  installKeybindings();
  const server = await ensureServer();
  return workbenchUrl(origin(server), resolveTarget(undefined, process.cwd()));
}

function fail(message: string): never {
  process.stderr.write(`tode: ${message}\n`);
  process.exit(1);
}

function takeFlag(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  const value = args[at + 1];
  if (value === undefined) fail(`${name} needs a value`);
  args.splice(at, 2);
  return value;
}

function takeAll(args: string[], ...names: string[]): string[] {
  const found: string[] = [];
  for (let at = 0; at < args.length;) {
    if (!names.includes(args[at])) {
      at += 1;
      continue;
    }
    const value = args[at + 1];
    if (value === undefined) fail(`${args[at]} needs a value`);
    found.push(value);
    args.splice(at, 2);
  }
  return found;
}

function takeBool(args: string[], name: string): boolean {
  const at = args.indexOf(name);
  if (at < 0) return false;
  args.splice(at, 1);
  return true;
}

const HELP = `Usage: tode [path...] [options]
       tode --<command>

  tode                  Open the folder in the current working directory
  tode <folder>         Open the specified folder
  tode <file>           Open the specified file


Options:
  -g, --goto <f:l:c>    Open a file at a line and column
  -a, --add <folder>    Add a folder to the active workspace
  -n, --new-window      Open a new pane even for a file
  -w, --wait            Wait until the file is closed again
  -d, --diff <a> <b>    Compare two files
  -r, --reuse-window    Open folder in this window rather than a new pane
  --install-extension   Install an extension by id or vsix path
  --uninstall-extension Remove an extension
  --list-extensions     List installed extensions
  --split <direction>   Open in a new pane: right, left, down, up
  --size <fraction>     The % a new split will take up (0.2 to 0.95)
  --timing              Report how long each stage of this open took
  --review              Open on the source control panel

Commands, each as the first argument:
  --shortcut-setup      Resolve shortcut conflicts between terminal-code and the current terminal
  --timing              Profile terminal-code launch
  --import [editor]     Bring settings, keybindings, snippets and extensions
                        over from vscode compatible editors
  --theme [file|name]   Set editor theme from a vscode theme json, or pick an
                        installed color theme by name ("Monokai"). No argument
                        goes back to the terminal's own colours
  --skill               An agent skill to assist with modifying terminal-code
  --upgrade [--check]   Upgrade terminal-code to the latest version
  --quit                Close the open terminal-code windows
  --reset-terminal      Put this terminal back after a pane was killed outright
  --shutdown            Stop all terminal-code activities
  --uninstall [--yes]   Remove all terminal-code data from this machine
`;


/**
 * i dont think this stuff is necessary come back to this
 */
const IGNORED: string[] = [
  "--verbose",
  "--disable-gpu",
  "--disable-telemetry",
  "--disable-updates",
  "--no-sandbox",
  "--skip-release-notes",
  "--skip-welcome",
  "--disable-workspace-trust",
];

const IGNORED_WITH_VALUE: string[] = [
  "--log",
  "--locale",
  "--sync",
  "--profile",
  "--user-data-dir",
  "--extensions-dir",
];

const UNSUPPORTED: [string, string][] = [
  ["--disable-extensions", "extensions are per code-server, not per window"],
  ["--disable-extension", "extensions are per code-server, not per window"],
];

function dropIgnored(args: string[]): void {
  for (const flag of IGNORED_WITH_VALUE) takeAll(args, flag);
  for (const flag of IGNORED) takeBool(args, flag);
  for (const [flag, why] of UNSUPPORTED) {
    const had = takeBool(args, flag) || takeAll(args, flag).length > 0;
    if (had) process.stderr.write(`tode: ignoring ${flag}, ${why}\n`);
  }
}

async function openCommand(args: string[]): Promise<number> {
  dropIgnored(args);
  const adding = takeBool(args, "-a") || takeBool(args, "--add");
  const going = takeBool(args, "-g") || takeBool(args, "--goto");
  const diffing = takeBool(args, "-d") || takeBool(args, "--diff");
  const extensions = takeAll(args, "--install-extension");
  const removals = takeAll(args, "--uninstall-extension");
  if (extensions.length > 0 || removals.length > 0) return manageExtensions(extensions, removals);
  if (takeBool(args, "--list-extensions")) {
    return listExtensions(takeBool(args, "--show-versions"));
  }

  const newWindow = takeBool(args, "-n") || takeBool(args, "--new-window");
  const reuse = takeBool(args, "-r") || takeBool(args, "--reuse-window");
  const wait = takeBool(args, "-w") || takeBool(args, "--wait");
  const split = takeFlag(args, "--split");
  const size = takeFlag(args, "--size");
  const timing = takeBool(args, "--timing");
  const review = takeBool(args, "--review");
  const unknown = args.find((arg) => arg.startsWith("-"));
  if (unknown) fail(`unknown option ${unknown}`);
  if (size !== undefined && !split) fail("--size only applies with --split");

  if (diffing && args.length !== 2) fail("--diff takes two files");
  const pair = diffing ? args.map((f) => path.resolve(process.cwd(), f)) : [];
  const gotos = going && !diffing ? args.map(parseGoto) : [];

  const positional = diffing || going ? [] : args;
  const wanted = positional.map((argument) => resolveTarget(argument, process.cwd()));
  const files: OpenFile[] = [
    ...wanted.filter((t) => t.file).map((t) => ({ path: t.file! })),
    ...gotos.map((goto) => ({ ...goto, path: path.resolve(process.cwd(), goto.path) })),
  ];
  const folders = wanted
    .filter((t) => t.folder)
    .map((t) => t.folder!)
    .filter((folder, at, all) => all.indexOf(folder) === at);

  const here = adding || reuse;
  const window = newWindow ? null : runningWindow();
  const sendFolders = here ? folders : [];
  const opensAPane = folders.length > 0 && !here;

  if (
    window &&
    !opensAPane &&
    (files.length > 0 || sendFolders.length > 0 || pair.length > 0 || review)
  ) {
    await sendToExtension(
      window,
      {
        files,
        folders: sendFolders,
        add: adding,
        wait,
        diff: pair,
        ...(review ? { view: "scm" } : {}),
      },
      wait ? 0 : 4000,
    ).catch((error) => fail(`could not reach the tode window: ${error.message}`));
    return 0;
  }

  const mark = Date.now();
  const stages: [string, number][] = [];
  const done = (label: string) => stages.push([label, Date.now() - mark]);

  const target = wanted[0] ?? resolveTarget(undefined, process.cwd());
  const runtime = await resolveRuntimeWithProgress();
  done("runtime");
  await ensureServerDist(narrateFetch(SERVER_LABEL));
  const { palette } = await readPalette();
  ensureFont();
  const theme = installActiveTheme(palette);
  installCss(palette, themeBackground(theme, palette));
  installSettings();
  done("profile");
  autoApplyShared();

  let finalized: Promise<string> | null = null;
  const finalize = () =>
  (finalized ??= (async () => {
    installBridge(todeCommand());
    installKeybindings();
    const server = await ensureServer();
    done("code-server");
    const startupFiles = files.filter((file) => file.line !== undefined || file.path !== target.file);
    if (review || startupFiles.length > 0 || pair.length > 0) {
      requestStartupOpen({
        ...(startupFiles.length > 0 ? { files: startupFiles } : {}),
        ...(pair.length > 0 ? { diff: pair } : {}),
        ...(review ? { view: "scm" } : {}),
      });
    }
    return workbenchUrl(origin(server), target);
  })());

  void ensureServer().catch(() => {});

  const pane = new Pane(runtime, { split, size, stages });
  await runOnboarding(pane, finalize, palette);
  if (pane.owned()) return pane.exited();

  const url = await finalize();
  if (timing) {
    for (const [label, ms] of stages) process.stderr.write(`  ${label.padEnd(12)} ${ms}ms\n`);
  }
  return launchBrowser(runtime, url, palette, { split, size, stages }).catch((error: Error) =>
    fail(error.message),
  );
}

function extensionCommand(args: string[], quiet = false): number {
  const command = commandWith(serverCommand(), [...args, ...extensionArgs()]);
  const result = spawnSync(command.file, command.args, {
    stdio: quiet ? ["ignore", "inherit", "ignore"] : "inherit",
    windowsHide: true,
  });
  return result.status ?? 1;
}

function listExtensions(withVersions: boolean): number {
  return extensionCommand(withVersions ? ["--list-extensions", "--show-versions"] : ["--list-extensions"], true);
}

function manageExtensions(install: string[], remove: string[]): number {
  for (const id of remove) {
    const code = extensionCommand(["--uninstall-extension", id]);
    if (code !== 0) return code;
  }
  for (const id of install) {
    const code = extensionCommand(["--install-extension", id]);
    if (code !== 0) return code;
  }
  registerThemeExtension();
  if (install.length > 0) process.stdout.write("open tode again to pick it up\n");
  return 0;
}

function swatch(color: string): string {
  const [r, g, b] = [1, 3, 5].map((at) => parseInt(color.slice(at, at + 2), 16));
  return `\x1b[48;2;${r};${g};${b}m   \x1b[0m`;
}

/** Hand a color theme name to every open window, and stage it for the ones
 * not open yet. The bridge writes it where the theme picker would, so the
 * browser keeps the choice across windows and sessions. */
async function broadcastColorTheme(name: string): Promise<number> {
  requestColorTheme(name);
  let reached = 0;
  for (const window of listEndpoints(IPC_DIR)) {
    await sendToExtension(window.address, { files: [], folders: [], add: false, colorTheme: name })
      .then(() => {
        reached += 1;
      })
      .catch(() => forgetEndpoint(window));
  }
  return reached;
}

async function themeCommand(argument?: string): Promise<number> {
  // a name that is not a file on disk selects an installed theme, the way the
  // editor's theme picker would — "Monokai" is a choice, not a missing file
  if (argument && !fs.existsSync(argument) && !/[\\/]|\.json5?$/.test(argument)) {
    const reached = await broadcastColorTheme(argument);
    process.stdout.write(
      reached > 0
        ? `color theme "${argument}" chosen — open windows switch now, and the browser remembers it\n`
        : `color theme "${argument}" chosen — the next open applies it\n`,
    );
    process.stdout.write("if no installed theme has that name, the editor says so and keeps its current one\n");
    return 0;
  }
  if (argument) {
    const error = setThemeFile(argument);
    if (error) {
      process.stderr.write(`tode: ${error}\n`);
      return 1;
    }
    installSettings();
    selectTodeTheme();
    installBridge(todeCommand());
    // a theme file paints through tode's own theme, so the workbench has to be
    // wearing it — a named scheme picked earlier would sideline the file
    await broadcastColorTheme(THEME_NAME);
    process.stdout.write(`theme set from ${argument} — open windows follow without a reload\n`);
    return 0;
  }
  const released = forgetThemeChoice();
  const { palette, source } = await readPalette();
  // slop copy fixme
  const where = {
    terminal: "read from this terminal",
    cache: "from the cache, this terminal did not answer",
    default: "built in default, no terminal answered and nothing cached",
  }[source];
  const accent = semanticColors(palette);
  const line = (label: string, color: string) => `  ${swatch(color)} ${color}  ${label}\n`;
  process.stdout.write(`palette ${where}\n`);
  process.stdout.write(line("background", hex(palette.background)));
  process.stdout.write(line("foreground", hex(palette.foreground)));
  process.stdout.write(`  ${palette.ansi.map((c) => swatch(hex(c))).join("")}  ansi 0-15\n`);
  for (const [name, color] of Object.entries(accent)) process.stdout.write(line(name, hex(color)));
  const { changed, fingerprint } = installTheme(palette);
  setLiveTheme(generateTheme(palette));
  selectTodeTheme();
  installBridge(todeCommand());
  installCss(palette);
  installSettings();
  installKeybindings();
  process.stdout.write(
    `\ntheme ${fingerprint} ${changed ? "written" : "already current"}\nfont ${ensureFont()}\n`,
  );
  if (released) process.stdout.write("the theme file you had set is no longer used\n");
  // going back to the terminal's colours includes undoing a named scheme
  // chosen earlier, or the workbench would keep wearing it
  await broadcastColorTheme(THEME_NAME);
  return 0;
}

type PageTiming = import("./browser/ctx").PageTiming;

const STAGES: [string, string][] = [
  ["renderer started", "code/didStartRenderer"],
  ["workbench script loaded", "code/didLoadWorkbenchMain"],
  ["workbench starting", "code/willStartWorkbench"],
  ["editors restored", "code/didRestoreEditors"],
  ["workbench ready", "code/didStartWorkbench"],
  ["settled", "code/LifecyclePhase/Eventually"],
];

function timingCommand(): number {
  let page: PageTiming;
  try {
    page = JSON.parse(fs.readFileSync(`${CSS_FILE}.timing.json`, "utf8")) as PageTiming;
  } catch {
    process.stdout.write("no page timing recorded yet, open tode once\n");
    return 0;
  }
  let launch: { spawnedAt: number; stages: [string, number][] } | null = null;
  try {
    launch = JSON.parse(fs.readFileSync(`${CSS_FILE}.launch.json`, "utf8"));
  } catch { }
  const bar = (ms: number, of: number) => "\u2588".repeat(Math.max(1, Math.round((ms / of) * 34)));
  const total = Math.max(page.marks["code/didStartWorkbench"] ?? 0, page.loadEnd, 1);
  const seconds = Math.round((Date.now() - page.at) / 1000);
  process.stdout.write(`page load, ${seconds}s ago\n\n`);
  const beforeNavigation = launch ? page.origin - launch.spawnedAt : null;
  const rows: [string, number][] = [
    ...(launch
      ? ([
        ...launch.stages.map(([label, ms]) => [`tode: ${label}`, ms - launch!.stages[launch!.stages.length - 1][1]] as [string, number]),
      ] as [string, number][])
      : []),
    ...(beforeNavigation !== null && beforeNavigation >= 0
      ? ([["browser start to navigation", beforeNavigation]] as [string, number][])
      : []),
    ["document arrived", page.responseEnd],
    ["dom interactive", page.domInteractive],
    ...STAGES.filter(([, mark]) => page.marks[mark] != null).map(
      ([label, mark]) => [label, page.marks[mark]] as [string, number],
    ),
  ];
  for (const [label, ms] of rows) {
    process.stdout.write(`  ${label.padEnd(24)} ${String(ms).padStart(5)}ms  ${bar(ms, total)}\n`);
  }
  return 0;
}

/** Close the windows without touching the keyboard. The quit chord is the usual
 * way, but a terminal can hold a chord and never pass it on — and where there is
 * no wizard to negotiate that, this is the way out that cannot be intercepted.
 * It also answers the question the chord cannot: a window that is not listed
 * here has no bridge running, so no chord would have reached it either. */
async function quitCommand(): Promise<number> {
  const here = runningWindow();
  const windows = here ? [{ file: "", address: here }] : listEndpoints(IPC_DIR);
  if (windows.length === 0) {
    process.stdout.write(`no tode window is listening in ${IPC_DIR}
`);
    return 0;
  }
  let quit = 0;
  for (const window of windows) {
    await sendToExtension(window.address, { files: [], folders: [], add: false, quit: true })
      .then(() => {
        quit += 1;
      })
      .catch(() => {
        if (window.file) forgetEndpoint(window);
      });
  }
  process.stdout.write(
    quit > 0
      ? `quit ${quit} window${quit === 1 ? "" : "s"}
`
      : `${windows.length} window(s) listed but none answered
`,
  );
  return 0;
}

async function shutdownCommand(): Promise<number> {
  const stopped = stopServer();
  const runtime = await resolveRuntime().catch(() => null);
  if (runtime) {
    await new Promise<void>((resolve) => {
      const shutdown = commandWith(runtime.command, ["shutdown"]);
      const child = spawn(shutdown.file, shutdown.args, {
        stdio: "ignore",
        windowsHide: true,
        env: { ...process.env, ...(shutdown.env ?? {}) },
      });
      child.on("error", () => resolve());
      child.on("exit", () => resolve());
    });
  }
  process.stdout.write(stopped ? "tode stopped\n" : "nothing was running\n");
  return 0;
}

async function upgradeCommand(args: string[]): Promise<number> {
  const check = takeBool(args, "--check");
  const version = takeFlag(args, "--version");
  let announced = false;
  let lastPercent = -1;
  const outcome = await upgrade({
    check,
    version,
    onStage: (stage, fraction) => {
      if (stage !== "downloading") return;
      if (!announced) {
        process.stderr.write("tode: downloading\n");
        announced = true;
      }
      const percent = Math.round(fraction * 100);
      if (percent === lastPercent) return;
      lastPercent = percent;
      process.stderr.write(`\r  ${percent}%${percent === 100 ? "\n" : ""}`);
    },
  });

  switch (outcome.kind) {
    case "not-an-install":
      fail(`${outcome.root} is a working tree, not an install — use git pull`);
    // eslint-disable-next-line no-fallthrough
    case "current":
      process.stdout.write(`tode ${outcome.version} is the newest on ${outcome.channel}\n`);
      return 0;
    case "available":
      process.stdout.write(`tode ${outcome.build.version} is available (you have ${outcome.from})\n`);
      return 0;
    case "upgraded": {
      stopServer();
      process.stdout.write(`tode ${outcome.from} -> ${outcome.build.version}\n`);
      return 0;
    }
  }
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args[0] === "--version" || args[0] === "-v") {
    let version = "dev";
    try {
      version = fs.readFileSync(path.join(INSTALL_ROOT, "VERSION"), "utf8").trim() || "dev";
    } catch {}
    process.stdout.write(`${version}\n`);
    return 0;
  }
  if (args[0] === "--help" || args[0] === "-h") {
    process.stdout.write(HELP);
    return 0;
  }
  if (args[0] === "--shortcut-setup") {
    const rest = args.slice(1);
    const noBoot = takeBool(rest, "--no-boot");
    const code = await shortcutsCommand(rest, noBoot ? undefined : bootEditorUrl);
    if (code === BOOT_AFTER_APPLY) return noBoot ? 0 : openCommand([]);
    return code;
  }
  if (args[0] === "--import") return importCommand(args.slice(1));
  if (args[0] === "--theme") return themeCommand(args[1]);
  // alone it reads the last load's story; next to a path it stays the open
  // option that reports this open's stages
  if (args[0] === "--timing" && args.length === 1) return timingCommand();
  if (args[0] === "--skill") return skillCommand();
  if (args[0] === "--upgrade") return upgradeCommand(args.slice(1));
  if (args[0] === "--quit") return quitCommand();
  if (args[0] === "--reset-terminal") {
    if (restoreTerminal()) return 0;
    process.stderr.write("tode: --reset-terminal needs to run in a terminal\n");
    return 1;
  }
  if (args[0] === "--shutdown") return shutdownCommand();
  if (args[0] === "--uninstall") return uninstallCommand(args.slice(1));
  return openCommand(args);
}

void main()
  .then((code) => {
    if (code) process.exit(code);
  })
  .catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
