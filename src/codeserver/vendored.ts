import fs from "node:fs";
import path from "node:path";

import { DATA_DIR, WINDOWS } from "../runtime/paths";
import type { Command } from "../runtime/platform";
import { extractArchive } from "../runtime/platform";
import { fetchVerified, targetTriple } from "../runtime/release";

/** The code-server build tode is written against. The workbench tode injects
 * into is version-specific, so it pins rather than taking whatever happens to
 * be installed. Bump the version and the hashes together — they come from the
 * digests GitHub publishes on the release assets. */
export const CODE_SERVER_VERSION = "4.132.0";

/** code-server has no Windows build and never has: its release assets are linux
 * and macos only, and the npm package's postinstall fetches one of those. The
 * same workbench is available for Windows as VSCodium's "reh-web" server — the
 * OSS build of the same vscode server code-server itself wraps — so that is what
 * a Windows tode runs. Extensions come from Open VSX unless the VSCODE_GALLERY_*
 * variables point somewhere else. */
export const VSCODIUM_VERSION = "1.126.04524";

/** tode target -> the name code-server releases under, and the sha256 GitHub
 * reports for that asset. */
const CODE_SERVER_BUILDS: Record<string, { asset: string; sha256: string; size: number }> = {
  "darwin-arm64": {
    asset: "macos-arm64",
    sha256: "449814f6637faaf9b68544f7bce560f5ec500de688815d5c7f9afa7a51577992",
    size: 211120710,
  },
  "linux-x64": {
    asset: "linux-amd64",
    sha256: "a38d26f4cb81f768feddff79e2937fd3f39c83d3da8be3da7225e1087e62e4ed",
    size: 238758593,
  },
  "linux-arm64": {
    asset: "linux-arm64",
    sha256: "ade569a677d1c04ee66ef153382b7e15bf261f955407663c7ddc6b87f9ee29fc",
    size: 232503176,
  },
};

const VSCODIUM_BUILDS: Record<string, { asset: string; sha256: string; size: number }> = {
  "win32-x64": {
    asset: `vscodium-reh-web-win32-x64-${VSCODIUM_VERSION}.tar.gz`,
    sha256: "43f15c8e5c95b795d6eb72a62095498d901ee633938cb3f8297256192062b333",
    size: 108172190,
  },
};

/** Which server this platform runs. The two speak the same http workbench, so
 * everything downstream of the spawn is shared; only the argv differs. */
export type ServerKind = "code-server" | "reh-web";

export const SERVER_KIND: ServerKind = WINDOWS ? "reh-web" : "code-server";
export const SERVER_VERSION = WINDOWS ? VSCODIUM_VERSION : CODE_SERVER_VERSION;
export const SERVER_LABEL = WINDOWS
  ? `VSCodium server ${VSCODIUM_VERSION}`
  : `code-server ${CODE_SERVER_VERSION}`;

export interface ServerDist {
  kind: ServerKind;
  root: string;
  /** how to run the server's cli */
  command: Command;
}

export function codeServerRoot(version = SERVER_VERSION): string {
  return path.join(DATA_DIR, WINDOWS ? "vscodium-server" : "code-server", version);
}

/** The bundled node next to a reh-web tree, which is what its own launcher uses
 * and what keeps tode from depending on a node being installed. */
function serverNode(root: string): string {
  const bundled = path.join(root, "node.exe");
  return fs.existsSync(bundled) ? bundled : process.execPath;
}

function distAt(root: string): ServerDist | null {
  if (WINDOWS) {
    const entry = path.join(root, "out", "server-main.js");
    if (!fs.existsSync(entry)) return null;
    return { kind: "reh-web", root, command: { file: serverNode(root), args: [entry] } };
  }
  const bin = path.join(root, "bin", "code-server");
  if (!fs.existsSync(bin)) return null;
  return { kind: "code-server", root, command: { file: bin, args: [] } };
}

/** TODE_CODE_SERVER may name the launcher, or the server entry script — the
 * second is the only one Windows can start without a shell. */
function overrideDist(configured: string): ServerDist {
  if (configured.endsWith(".js")) {
    const root = path.resolve(path.dirname(configured), "..");
    return {
      kind: SERVER_KIND,
      root,
      command: { file: serverNode(root), args: [configured] },
    };
  }
  return {
    kind: SERVER_KIND,
    root: path.resolve(path.dirname(configured), ".."),
    command: { file: configured, args: [] },
  };
}

export function installedServer(): ServerDist | null {
  const configured = process.env.TODE_CODE_SERVER;
  if (configured) return overrideDist(configured);
  return distAt(codeServerRoot());
}

export function narrateFetch(label: string): (fraction: number) => void {
  let announced = false;
  let lastPercent = -1;
  return (fraction) => {
    if (!announced) {
      process.stderr.write(`tode: fetching ${label}\n`);
      announced = true;
    }
    const percent = Math.round(fraction * 100);
    if (percent === lastPercent) return;
    lastPercent = percent;
    process.stderr.write(`\r  ${percent}%${percent === 100 ? "\n" : ""}`);
  };
}

interface Download {
  url: string;
  sha256: string;
  size: number;
  /** how many leading path components the archive carries: code-server wraps its
   * tree in a versioned directory, the reh-web tarball does not */
  strip: number;
}

function downloadFor(target: string): Download {
  if (WINDOWS) {
    const build = VSCODIUM_BUILDS[target];
    if (!build) throw new Error(`no pinned VSCodium server build for ${target}`);
    return {
      url: `https://github.com/VSCodium/vscodium/releases/download/${VSCODIUM_VERSION}/${build.asset}`,
      sha256: build.sha256,
      size: build.size,
      strip: 0,
    };
  }
  const build = CODE_SERVER_BUILDS[target];
  if (!build) throw new Error(`no pinned code-server build for ${target}`);
  return {
    url:
      `https://github.com/coder/code-server/releases/download/` +
      `v${CODE_SERVER_VERSION}/code-server-${CODE_SERVER_VERSION}-${build.asset}.tar.gz`,
    sha256: build.sha256,
    size: build.size,
    strip: 1,
  };
}

export async function ensureServerDist(
  onProgress?: (fraction: number) => void,
): Promise<ServerDist> {
  const already = installedServer();
  if (already) return already;

  const build = downloadFor(targetTriple());
  const root = codeServerRoot();
  const tarball = `${root}.tar.gz`;
  await fetchVerified(build.url, build.sha256, build.size, tarball, onProgress);

  const staging = `${root}.unpacking`;
  fs.rmSync(staging, { recursive: true, force: true });
  extractArchive(tarball, staging, build.strip);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(root), { recursive: true });
  fs.renameSync(staging, root);
  fs.rmSync(tarball, { force: true });

  const dist = distAt(root);
  if (!dist) throw new Error(`unpacked ${SERVER_LABEL} but its entry point is missing`);
  return dist;
}
