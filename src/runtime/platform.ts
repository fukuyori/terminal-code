import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const WINDOWS = process.platform === "win32";

/** A command to run: the executable plus the arguments that always come first.
 * Windows cannot exec a shell script, so the pieces tode used to hide behind a
 * generated launcher are carried around instead. */
export interface Command {
  file: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

export function commandWith(command: Command, args: string[]): Command {
  return { ...command, args: [...command.args, ...args] };
}

/** Windows ships bsdtar as System32\tar.exe and it reads both .tar.gz and .zip.
 * It is named outright rather than looked up on PATH: a git-for-windows or msys
 * install puts a GNU tar in front of it, and that one reads `C:\...` as a remote
 * host and refuses to resolve it. */
function tarBinary(): string {
  if (!WINDOWS) return "tar";
  const system = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
  return fs.existsSync(system) ? system : "tar";
}

/** Unpacks a .tar.gz or .zip into `into`. */
export function extractArchive(archive: string, into: string, strip = 1): void {
  fs.mkdirSync(into, { recursive: true });
  const args = ["-xf", archive, "-C", into];
  if (strip > 0) args.push("--strip-components", String(strip));
  // --force-local is what a GNU tar needs to read a drive letter as a path; it
  // is only reached if the bsdtar that does not need it was not there
  const attempts = WINDOWS ? [args, [...args, "--force-local"]] : [args];
  let last: unknown = null;
  for (const attempt of attempts) {
    try {
      execFileSync(tarBinary(), attempt, {
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      });
      return;
    } catch (error) {
      last = error;
    }
  }
  const stderr = (last as { stderr?: Buffer })?.stderr?.toString().trim();
  throw new Error(`could not unpack ${archive}${stderr ? `: ${stderr}` : ""}`);
}

/** A recursive copy that clones rather than copies where the filesystem can
 * (apfs), and otherwise falls back to a plain copy. Returns false only if
 * every attempt failed. */
export function copyTree(from: string, to: string): boolean {
  if (WINDOWS) {
    try {
      fs.cpSync(from, to, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }
  try {
    execFileSync("cp", ["-Rc", from, to], { stdio: "ignore" });
    return true;
  } catch {
    try {
      execFileSync("cp", ["-R", from, to], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }
}

/** The path half of a vscode uri. It is always posix, with the drive letter
 * behind a leading slash and lower-cased the way vscode normalises it:
 * C:\src\main.ts is /c:/src/main.ts. Everything inside tode keeps the
 * platform's own paths; this is the conversion at the edge, and it has to match
 * vscode exactly wherever the two compare uris — the extension registry does. */
export function uriPath(target: string): string {
  if (!WINDOWS) return target;
  const posix = target.replaceAll("\\", "/");
  const slashed = posix.startsWith("/") ? posix : `/${posix}`;
  return slashed.replace(/^\/([a-zA-Z]):/, (_all, drive: string) => `/${drive.toLowerCase()}:`);
}

/** npm is a shell script everywhere but Windows, where the launcher CreateProcess
 * can start is npm.cmd. */
export const NPM = WINDOWS ? "npm.cmd" : "npm";

/** Compares a version stamp with the version tode pinned. The Windows builds of
 * terminal-browser carry a fork suffix (0.5.8-win.1) on top of the upstream tag
 * they were cut from, so the pin has to match the base rather than the whole
 * string. */
export function versionMatches(found: string | null, wanted: string): boolean {
  if (!found) return false;
  const strip = (value: string) => value.replace(/^v/, "");
  const a = strip(found);
  const b = strip(wanted);
  if (a === b) return true;
  return WINDOWS && a.startsWith(`${b}-win.`);
}
