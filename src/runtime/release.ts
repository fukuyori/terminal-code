/**
 * need to look into how we can make the icon stop popping up
 *
 * i think thats an electron thing
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { BROWSER_HOME, RUNTIME_DIR, VENDOR_DIR, WINDOWS } from "./paths";
import type { Command } from "./platform";
import { copyTree, extractArchive, versionMatches } from "./platform";

// The Windows fork is based on v0.8.0 and carries its own -win revision.
// versionMatches() accepts that suffix while still rejecting a different base.
export const PINNED_VERSION = WINDOWS ? "v0.8.0" : "v0.7.3";

const RELEASE_ORIGIN = process.env.TODE_RELEASE_ORIGIN ?? "https://terminal-browser.sh/install";

/** Where a terminal-browser installed on its own lives. The posix installer
 * unpacks into the data home; the Windows installer is an Inno setup that
 * defaults to {localappdata}\Programs. */
const SYSTEM_INSTALL = WINDOWS
  ? path.join(
      process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"),
      "Programs",
      "terminal-browser",
    )
  : path.join(
      process.env.XDG_DATA_HOME ?? path.join(process.env.HOME ?? "", ".local/share"),
      "terminal-browser",
      "app",
    );

export interface Release {
  version: string;
  channel: string;
  url: string;
  sha256: string;
  size: number;
}

export type Source = "override" | "vendored" | "pinned" | "cloned" | "downloaded" | "installed";

export function targetTriple(): string {
  const platform = process.platform === "darwin" ? "darwin" : WINDOWS ? "win32" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return `${platform}-${arch}`;
}

const VENDORED = path.join(VENDOR_DIR, "terminal-browser");

export interface Runtime {
  /** how to run terminal-browser: on posix a generated launcher, on Windows the
   * bundled node with the cli's entry point and the environment the launcher
   * would otherwise have exported */
  command: Command;
  root: string;
  version: string;
  source: Source;
}

export async function lookup(version: string): Promise<Release> {
  const url = `${RELEASE_ORIGIN}/v/${version}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`no release ${version} (${response.status} from ${url})`);
  const script = await response.text();
  const field = (name: string) => {
    const found = script.match(new RegExp(`^${name}="([^"]*)"`, "m"));
    if (!found) throw new Error(`release ${version} did not report ${name}`);
    return found[1];
  };
  const target = targetTriple();
  const row = field("PLATFORMS")
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .find((columns) => columns[0] === target);
  if (!row || row.length < 4) throw new Error(`release ${version} has no build for ${target}`);
  return {
    version: field("VERSION"),
    channel: field("CHANNEL"),
    url: row[1],
    sha256: row[2],
    size: Number(row[3]),
  };
}

function versionAt(root: string): string | null {
  try {
    return fs.readFileSync(path.join(root, "VERSION"), "utf8").trim() || null;
  } catch {
    return null;
  }
}

/** Where the electron binary lives inside a terminal-browser tree. macOS ships
 * an app bundle; linux ships the bare electron layout; Windows ships electron
 * next to a plain node.exe. */
export function electronEntry(root: string): string {
  if (process.platform === "darwin") {
    return path.join(root, "electron", "terminal-browser.app", "Contents", "MacOS", "terminal-browser");
  }
  return path.join(root, "electron", WINDOWS ? "electron.exe" : "electron");
}

/** The Windows package carries its own node.exe, which is what its own launcher
 * runs the cli with. */
function nodeEntry(root: string): string {
  return path.join(root, "runtime", "node.exe");
}

function usable(root: string, version: string): boolean {
  return (
    versionMatches(versionAt(root), version) &&
    fs.existsSync(path.join(root, "cli", "dist", "main.js")) &&
    fs.existsSync(electronEntry(root))
  );
}

function rootFor(version: string): string {
  return path.join(RUNTIME_DIR, "terminal-browser", version);
}

/** The environment the browser is given, whichever way it is started: its own
 * data kept apart from a terminal-browser the user installed for themselves. */
function browserEnv(root: string): NodeJS.ProcessEnv {
  for (const dir of Object.values(BROWSER_HOME)) fs.mkdirSync(dir, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    TERMINAL_BROWSER_DIST_ROOT: root,
    XDG_DATA_HOME: process.env.TODE_BROWSER_DATA ?? BROWSER_HOME.data,
    XDG_STATE_HOME: process.env.TODE_BROWSER_STATE ?? BROWSER_HOME.state,
    XDG_CACHE_HOME: process.env.TODE_BROWSER_CACHE ?? BROWSER_HOME.cache,
    TERMINAL_BROWSER_APPDATA: process.env.TODE_BROWSER_APPDATA ?? BROWSER_HOME.appData,
  };
  // XDG_RUNTIME_DIR keeps the session's own value: the Wayland socket lives
  // there, and the daemon socket is already namespaced by a hash of the install
  // root.
  if (process.env.TODE_BROWSER_RUN) env.XDG_RUNTIME_DIR = process.env.TODE_BROWSER_RUN;
  return env;
}

/** Windows has no exec-a-script, so nothing is written: the cli is started
 * directly with the bundled node, or with electron pretending to be node when a
 * build shipped without one. */
function windowsCommand(root: string): Command {
  const node = nodeEntry(root);
  const env = browserEnv(root);
  const cli = path.join(root, "cli", "dist", "main.js");
  if (fs.existsSync(node)) return { file: node, args: [cli], env };
  return { file: electronEntry(root), args: [cli], env: { ...env, ELECTRON_RUN_AS_NODE: "1" } };
}

function writeLauncher(root: string): Command {
  if (WINDOWS) return windowsCommand(root);
  const bin = path.join(root, "bin", "terminal-browser");
  const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
  const electron = path.relative(root, electronEntry(root));
  const scrollHelper =
    process.platform === "darwin"
      ? `export NATIVE_SCROLL_HELPER="\${NATIVE_SCROLL_HELPER:-$ROOT/bin/native-scroll-helper}"\n`
      : "";
  fs.writeFileSync(
    bin,
    `#!/bin/sh
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)"
export TERMINAL_BROWSER_DIST_ROOT="$ROOT"
export ELECTRON_RUN_AS_NODE=1
${scrollHelper}export XDG_DATA_HOME=\${TODE_BROWSER_DATA:-${quote(BROWSER_HOME.data)}}
export XDG_STATE_HOME=\${TODE_BROWSER_STATE:-${quote(BROWSER_HOME.state)}}
export XDG_CACHE_HOME=\${TODE_BROWSER_CACHE:-${quote(BROWSER_HOME.cache)}}
# XDG_RUNTIME_DIR keeps the session's own value: the Wayland socket lives there,
# and the daemon socket is already namespaced by a hash of the install root.
if [ -n "\${TODE_BROWSER_RUN:-}" ]; then export XDG_RUNTIME_DIR="\$TODE_BROWSER_RUN"; fi
export TERMINAL_BROWSER_APPDATA=\${TODE_BROWSER_APPDATA:-${quote(BROWSER_HOME.appData)}}
exec "$ROOT/${electron}" "$ROOT/cli/dist/main.js" "$@"
`,
  );
  fs.chmodSync(bin, 0o755);
  for (const dir of Object.values(BROWSER_HOME)) fs.mkdirSync(dir, { recursive: true });
  return { file: bin, args: [] };
}

export function unpack(tarball: string, root: string) {
  const staging = `${root}.unpacking`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  extractArchive(tarball, staging, 1);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(root), { recursive: true });
  fs.renameSync(staging, root);
}

function cloneTree(from: string, to: string): boolean {
  const staging = `${to}.cloning`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(to), { recursive: true });
  if (!copyTree(from, staging)) {
    fs.rmSync(staging, { recursive: true, force: true });
    return false;
  }
  fs.rmSync(to, { recursive: true, force: true });
  fs.renameSync(staging, to);
  return true;
}

export async function fetchVerified(
  url: string,
  sha256: string,
  size: number,
  tarball: string,
  onProgress?: (fraction: number) => void,
): Promise<string> {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`download failed (${response.status} from ${url})`);
  }
  fs.mkdirSync(path.dirname(tarball), { recursive: true });
  const hash = crypto.createHash("sha256");
  const file = fs.createWriteStream(tarball);
  let read = 0;
  for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
    hash.update(chunk);
    read += chunk.byteLength;
    if (!file.write(chunk)) await new Promise<void>((resolve) => file.once("drain", () => resolve()));
    if (size) onProgress?.(read / size);
  }
  await new Promise<void>((resolve, reject) => {
    file.end((error?: Error | null) => (error ? reject(error) : resolve()));
  });
  const got = hash.digest("hex");
  if (got !== sha256) {
    fs.rmSync(tarball, { force: true });
    throw new Error(`download corrupted: expected ${sha256}, got ${got}`);
  }
  return tarball;
}

function download(release: Release, onProgress?: (fraction: number) => void): Promise<string> {
  const tarball = path.join(RUNTIME_DIR, `${release.version}.tar.gz`);
  return fetchVerified(release.url, release.sha256, release.size, tarball, onProgress);
}

/** The runtime as it can be found on this machine right now, without reaching
 * for the network. Used where a download would be wrong — shutting down, and
 * uninstalling. */
export function localRuntime(version = PINNED_VERSION): Runtime | null {
  const places: [string, Source][] = [
    [VENDORED, "vendored"],
    [rootFor(version), "pinned"],
    [SYSTEM_INSTALL, WINDOWS ? "installed" : "cloned"],
  ];
  for (const [root, source] of places) {
    if (usable(root, version)) {
      return { command: writeLauncher(root), root, version: versionAt(root) ?? version, source };
    }
  }
  return null;
}

export interface ResolveOptions {
  version?: string;
  onProgress?(stage: "cloning" | "downloading", fraction: number): void;
}

export async function resolveRuntimeWithProgress(): Promise<Runtime> {
  let announced = false;
  let lastPercent = -1;
  return resolveRuntime({
    onProgress: (stage, fraction) => {
      if (stage === "downloading") {
        if (!announced) {
          process.stderr.write(`tode: fetching terminal-browser ${PINNED_VERSION}\n`);
          announced = true;
        }
        const percent = Math.round(fraction * 100);
        if (percent === lastPercent) return;
        lastPercent = percent;
        process.stderr.write(`\r  ${percent}%${percent === 100 ? "\n" : ""}`);
      }
      if (stage === "cloning" && !announced) {
        process.stderr.write(`tode: reusing the terminal-browser ${PINNED_VERSION} already installed\n`);
        announced = true;
      }
    },
  });
}

/** Windows has no published terminal-browser tarball on the upstream release
 * channel, so an install of the Windows build is the whole story. Say where to
 * get it rather than failing with a 404 from the release worker. */
function missingOnWindows(version: string): Error {
  return new Error(
    `no terminal-browser ${version} for Windows was found.\n` +
      `  install it from https://github.com/fukuyori/terminal-browser/releases\n` +
      `  (looked in ${SYSTEM_INSTALL}), or point TODE_TERMINAL_BROWSER_BIN at a build`,
  );
}

export async function resolveRuntime(options: ResolveOptions = {}): Promise<Runtime> {
  const version = options.version ?? PINNED_VERSION;

  const override = process.env.TODE_TERMINAL_BROWSER_BIN;
  if (override) {
    if (!fs.existsSync(override)) throw new Error(`TODE_TERMINAL_BROWSER_BIN is not there: ${override}`);
    const root = path.resolve(path.dirname(override), "..");
    const found = versionAt(root) ?? "override";
    // on Windows the override names the dist root's launcher, which cannot be
    // spawned directly, so the same command the launcher would run is rebuilt
    const command = WINDOWS ? windowsCommand(root) : { file: override, args: [] };
    return { command, root, version: found, source: "override" };
  }

  if (version === PINNED_VERSION && usable(VENDORED, version)) {
    return { command: writeLauncher(VENDORED), root: VENDORED, version, source: "vendored" };
  }

  const root = rootFor(version);
  if (usable(root, version)) {
    return { command: writeLauncher(root), root, version, source: "pinned" };
  }

  if (usable(SYSTEM_INSTALL, version)) {
    // The Windows installer owns its tree and updates it in place, so it is used
    // where it stands instead of being copied into tode's runtime directory.
    if (WINDOWS) {
      return {
        command: writeLauncher(SYSTEM_INSTALL),
        root: SYSTEM_INSTALL,
        version: versionAt(SYSTEM_INSTALL) ?? version,
        source: "installed",
      };
    }
    options.onProgress?.("cloning", 0);
    if (cloneTree(SYSTEM_INSTALL, root)) {
      options.onProgress?.("cloning", 1);
      return { command: writeLauncher(root), root, version, source: "cloned" };
    }
  }

  if (WINDOWS) throw missingOnWindows(version);

  const release = await lookup(version);
  const tarball = await download(release, (fraction) => options.onProgress?.("downloading", fraction));
  unpack(tarball, root);
  fs.rmSync(tarball, { force: true });
  if (!usable(root, version)) throw new Error(`unpacked ${version} but it is missing pieces`);
  return { command: writeLauncher(root), root, version, source: "downloaded" };
}
