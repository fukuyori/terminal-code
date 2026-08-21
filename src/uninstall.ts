import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";

import { stopServer } from "./codeserver/server";
import { FONT_ASSET, assetPath, unregisterWindowsFont, userFontsDir } from "./profile";
import {
  CACHE_DIR,
  DATA_DIR,
  DEFAULT_INSTALL_ROOT,
  INSTALL_ROOT,
  STATE_DIR,
  WINDOWS,
  shimFile,
} from "./runtime/paths";
import { commandWith } from "./runtime/platform";
import { localRuntime } from "./runtime/release";
import { ghosttyConfigDir, reloadGhostty, removeFreed } from "./shortcuts/backends/ghostty";


function confirm(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const ask = readline.createInterface({ input: process.stdin, output: process.stdout });
    ask.question(question, (answer) => {
      ask.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

const stubborn: string[] = [];

/** Windows keeps a handle on the batch file it is currently running and on
 * anything a live process opened, so a tree can refuse to go. That is worth
 * saying at the end rather than aborting halfway through the uninstall. */
function removeDir(dir: string): boolean {
  if (!fs.existsSync(dir)) return false;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    stubborn.push(dir);
    return false;
  }
  return true;
}

/** The user PATH entry the Windows install added for bin\tode.cmd.
 *
 * The registry is edited rather than [Environment]::SetEnvironmentVariable,
 * which writes the value back as a plain REG_SZ: a user PATH held as
 * REG_EXPAND_SZ would lose its %USERPROFILE% and friends, expanded once and
 * frozen. Reading with DoNotExpandEnvironmentNames and writing back with the
 * kind it already had leaves everything else exactly as it was. */
function removeFromUserPath(entry: string): void {
  if (!WINDOWS) return;
  const script = `
$wanted = $env:TODE_PATH_ENTRY.TrimEnd('\')
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
if ($key -eq $null) { exit 0 }
try {
  $kind = try { $key.GetValueKind('Path') } catch { exit 0 }
  $raw = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  $entries = $raw.Split(';') | Where-Object { $_ }
  $kept = $entries | Where-Object { $_.TrimEnd('\') -ine $wanted }
  if (($kept | Measure-Object).Count -ne ($entries | Measure-Object).Count) {
    $key.SetValue('Path', ($kept -join ';'), $kind)
  }
} finally {
  $key.Close()
}
`;
  try {
    execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, TODE_PATH_ENTRY: entry },
    });
  } catch {}
}

function removeFont(): boolean {
  const target = path.join(userFontsDir(), FONT_ASSET);
  try {
    const theirs = fs.readFileSync(target);
    const ours = fs.readFileSync(assetPath(FONT_ASSET));
    if (!theirs.equals(ours)) return false;
    fs.rmSync(target, { force: true });
    unregisterWindowsFont();
    return true;
  } catch {
    return false;
  }
}

function removeShim(): boolean {
  const shim = shimFile();
  try {
    const contents = fs.readFileSync(shim, "utf8");
    if (!contents.includes("TODE_INSTALL_ROOT")) return false;
    fs.rmSync(shim, { force: true });
    return true;
  } catch {
    return false;
  }
}

function spinner(label: string): () => void {
  if (!process.stdout.isTTY) return () => {};
  // dont think this actually works
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let at = 0;
  const timer = setInterval(() => {
    process.stdout.write(`\r${frames[at++ % frames.length]} ${label}`);
  }, 80);
  return () => {
    clearInterval(timer);
    process.stdout.write("\r\x1b[K");
  };
}

export async function uninstallCommand(args: string[]): Promise<number> {
  const yes = args.includes("--yes") || args.includes("-y");
  if (!yes) {
    if (!process.stdin.isTTY) {
      process.stderr.write("pass --yes to uninstall without a prompt\n");
      return 1;
    }
    if (!(await confirm("Uninstall terminal-code? [y/N] "))) return 0;
  }

  const stop = spinner("uninstalling");

  stopServer();
  const browser = localRuntime();
  if (browser) {
    const shutdown = commandWith(browser.command, ["shutdown"]);
    await new Promise<void>((resolve) => {
      const child = spawn(shutdown.file, shutdown.args, {
        stdio: "ignore",
        windowsHide: true,
        env: { ...process.env, ...(shutdown.env ?? {}) },
      });
      child.on("error", () => resolve());
      child.on("exit", () => resolve());
    });
  }

  if (!WINDOWS && removeFreed(ghosttyConfigDir())) reloadGhostty();

  removeFont();

  for (const dir of [DATA_DIR, STATE_DIR, CACHE_DIR]) removeDir(dir);

  for (const root of new Set([INSTALL_ROOT, DEFAULT_INSTALL_ROOT])) {
    if (fs.existsSync(path.join(root, "VERSION"))) {
      removeFromUserPath(path.join(root, "bin"));
      removeDir(root);
    }
  }
  removeShim();

  stop();
  if (stubborn.length > 0) {
    process.stdout.write(
      `done, except for ${stubborn.length} in-use path(s) — remove them once this shell is closed:\n`,
    );
    for (const dir of stubborn) process.stdout.write(`  ${dir}\n`);
    return 0;
  }
  process.stdout.write("done\n");
  return 0;
}
