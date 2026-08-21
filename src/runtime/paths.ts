import os from "node:os";
import path from "node:path";

const HOME = os.homedir();

export const WINDOWS = process.platform === "win32";

function base(variable: string, fallback: string): string {
  const value = process.env[variable];
  return value && path.isAbsolute(value) ? value : path.join(HOME, fallback);
}

/** Windows has no XDG split. Everything machine-local lives under one tree in
 * LOCALAPPDATA, with the three homes kept as subdirectories so the rest of the
 * code can go on thinking in data/state/cache. */
const LOCAL_APP_DATA =
  process.env.LOCALAPPDATA && path.isAbsolute(process.env.LOCALAPPDATA)
    ? process.env.LOCALAPPDATA
    : path.join(HOME, "AppData", "Local");

/** One of tode's three homes. An XDG variable wins wherever it is set — Windows
 * included, so a sandboxed run (the tests, a second profile) has the same escape
 * hatch everywhere. Left alone, Windows keeps all three under one tree in
 * LOCALAPPDATA, since it has no XDG split of its own. */
function home(variable: string, posixFallback: string, windowsLeaf: string): string {
  const value = process.env[variable];
  if (value && path.isAbsolute(value)) return path.join(value, "tode");
  if (WINDOWS) return path.join(LOCAL_APP_DATA, "tode", windowsLeaf);
  return path.join(base(variable, posixFallback), "tode");
}

export const INSTALL_ROOT =
  process.env.TODE_INSTALL_ROOT && path.isAbsolute(process.env.TODE_INSTALL_ROOT)
    ? // a launcher that says %~dp0.. hands over an unnormalized path
      path.resolve(process.env.TODE_INSTALL_ROOT)
    : path.resolve(__dirname, "..", "..");

export const VENDOR_DIR = path.join(INSTALL_ROOT, "vendor");

export const DEFAULT_INSTALL_ROOT = WINDOWS
  ? path.join(LOCAL_APP_DATA, "Programs", "tode")
  : path.join(HOME, ".local", "lib", "tode");

export const DATA_DIR = home("XDG_DATA_HOME", ".local/share", "data");
export const STATE_DIR = home("XDG_STATE_HOME", ".local/state", "state");
export const CACHE_DIR = home("XDG_CACHE_HOME", ".cache", "cache");

export const RUNTIME_DIR = path.join(DATA_DIR, "runtime");
export const LOGS_DIR = path.join(STATE_DIR, "logs");

/** Where a window's ipc endpoint is advertised. On posix the files in here are
 * the unix sockets themselves; on Windows a named pipe has no filesystem entry,
 * so each window drops a `.pipe` file whose contents name its pipe. Either way
 * a directory listing is how the browser finds the open windows. */
export const IPC_DIR = path.join(STATE_DIR, "ipc");

/** The `tode` command itself: a shim on posix, a .cmd on Windows. */
export function shimFile(): string {
  if (WINDOWS) return path.join(DEFAULT_INSTALL_ROOT, "bin", "tode.cmd");
  const binHome =
    process.env.XDG_BIN_HOME && path.isAbsolute(process.env.XDG_BIN_HOME)
      ? process.env.XDG_BIN_HOME
      : path.join(HOME, ".local", "bin");
  return path.join(binHome, "tode");
}

export const BROWSER_HOME = {
  data: path.join(DATA_DIR, "browser", "share"),
  state: path.join(STATE_DIR, "browser", "state"),
  cache: path.join(CACHE_DIR, "browser"),
  // not sure why this is called chromium thats just wrong
  appData: path.join(DATA_DIR, "browser", "chromium"),
};
