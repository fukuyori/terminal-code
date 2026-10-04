import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const packageDir = path.resolve(import.meta.dirname, "..");
const version = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8")).config.electron;
const electronDir = path.join(packageDir, "electron");
const dest = path.join(electronDir, "dist");
const typesFile = path.join(electronDir, "electron.d.ts");
const typesMarker = path.join(electronDir, ".electron.d.ts.source");
const marker = path.join(dest, ".zenbu-electron-sha256");
const skipBinary = process.env.PIXEL_SKIP_DOWNLOAD === "1";

const platforms = {
  "darwin-arm64": "darwin-arm64",
  "darwin-x64": "darwin-x64",
  "linux-x64": "linux-x64",
  "linux-arm64": "linux-arm64",
};
// Windows takes frames as bitmaps, which stock electron already draws, so it
// runs the published build instead of the patched one.
const stockPlatforms = { "win32-x64": "win32-x64" };
const target = `${process.platform}-${process.arch}`;
const platform = platforms[target] ?? stockPlatforms[target];
if (!platform) {
  process.stderr.write(`pixel: unsupported platform ${target}\n`);
  process.exit(1);
}
const stock = target in stockPlatforms;

// Patched electron builds are published as electron-v<version> releases. Newer ones live on
// the terminal-browser repo, where pixel now lives; older ones stayed on the archived pixel repo.
const mirrors = process.env.PIXEL_ELECTRON_MIRROR
  ? [process.env.PIXEL_ELECTRON_MIRROR]
  : [
      `https://github.com/zenbu-labs/terminal-browser/releases/download/electron-v${version}`,
      `https://github.com/zenbu-labs/pixel/releases/download/electron-v${version}`,
    ];
let mirror = mirrors[0];
const stockMirror = `https://github.com/electron/electron/releases/download/v${version}`;
const zipName = `electron-v${version}-${platform}.zip`;

async function fetchBytes(url) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`${url}: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function isSymlink(file) {
  try {
    return fs.lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

function readMarker(file) {
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return null;
  }
}

fs.mkdirSync(electronDir, { recursive: true });

let shasums;
let lastError;
for (const candidate of mirrors) {
  try {
    shasums = (await fetchBytes(`${candidate}/SHASUMS256.txt`)).toString("utf8");
    mirror = candidate;
    break;
  } catch (error) {
    lastError = error;
  }
}
if (!shasums) {
  const error = lastError;
  if (skipBinary && fs.existsSync(typesFile)) process.exit(0);
  process.stderr.write(
    `pixel: no patched electron v${version} is published (${error.message}). ` +
      `This release of pixel is built against electron ${version}; a newer pixel may be needed.\n`,
  );
  process.exit(1);
}
const binaryMirror = stock ? stockMirror : mirror;
const listedIn = (sums, name) =>
  sums
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .find((columns) => columns[1] === `*${name}` || columns[1] === name)?.[0];
const listed = (name) => listedIn(shasums, name);

// Types: generated from the patched docs by the same build as the binary. Older
// releases predate that asset, so fall back to upstream's types for the version.
const typesSha = listed("electron.d.ts");
const wantedSource = typesSha ? `${version} ${typesSha}` : `${version} npm`;
if (readMarker(typesMarker) !== wantedSource || !fs.existsSync(typesFile)) {
  let bytes;
  if (typesSha) {
    bytes = await fetchBytes(`${mirror}/electron.d.ts`);
    if (sha256(bytes) !== typesSha) {
      process.stderr.write(`pixel: electron.d.ts does not match SHASUMS256.txt\n`);
      process.exit(1);
    }
  } else {
    const tgz = await fetchBytes(`https://registry.npmjs.org/electron/-/electron-${version}.tgz`);
    bytes = execFileSync("tar", ["-xzf", "-", "-O", "package/electron.d.ts"], {
      input: tgz,
      maxBuffer: 64 * 1024 * 1024,
    });
  }
  fs.writeFileSync(typesFile, bytes);
  fs.writeFileSync(typesMarker, wantedSource);
  process.stderr.write(`pixel: installed electron.d.ts for v${version}\n`);
}

if (skipBinary) process.exit(0);

const binarySums = stock ? (await fetchBytes(`${binaryMirror}/SHASUMS256.txt`)).toString("utf8") : shasums;
const expected = listedIn(binarySums, zipName);
if (!expected) {
  process.stderr.write(`pixel: ${zipName} is missing from ${binaryMirror}/SHASUMS256.txt\n`);
  process.exit(1);
}
const frameworkBinary = path.join(
  dest, "Electron.app", "Contents", "Frameworks", "Electron Framework.framework", "Electron Framework",
);
// The marker says which zip the directory came from; these say the steps that
// follow unpacking also finished.
const intact =
  process.platform === "darwin"
    ? isSymlink(frameworkBinary)
    : process.platform !== "win32" || fs.existsSync(path.join(dest, "pixel.exe"));
if (readMarker(marker) === expected && intact) process.exit(0);

// Package managers that copy this package (pnpm file: links, fresh installs)
// run this script again, so downloaded zips are kept per user and reused.
const cacheDir = path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"), "pixel");
// Unpacking beside the destination keeps the move into place a rename; a
// temporary directory can sit on another filesystem, which rename refuses.
const tmp = fs.mkdtempSync(path.join(electronDir, ".unpack-"));
try {
  const cached = path.join(cacheDir, zipName);
  let bytes = fs.existsSync(cached) ? fs.readFileSync(cached) : null;
  if (!bytes || sha256(bytes) !== expected) {
    process.stderr.write(
      `pixel: downloading ${stock ? "" : "patched "}electron v${version} (${platform})\n`,
    );
    bytes = await fetchBytes(`${binaryMirror}/${zipName}`);
    const actual = sha256(bytes);
    if (actual !== expected) {
      throw new Error(`${zipName} does not match SHASUMS256.txt (expected ${expected}, got ${actual})`);
    }
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(cached, bytes);
  }
  const zip = path.join(tmp, zipName);
  fs.writeFileSync(zip, bytes);
  const unpacked = path.join(tmp, "app");
  fs.mkdirSync(unpacked);
  if (process.platform === "win32") {
    // Windows has no unzip. Its own tar reads zip archives, but the one on PATH
    // is often the GNU tar from Git, which reads a drive letter as a hostname.
    const bsdtar = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
    execFileSync(bsdtar, ["-xf", zip, "-C", unpacked], { stdio: "inherit" });
  } else {
    execFileSync("unzip", ["-q", zip, "-d", unpacked], { stdio: "inherit" });
  }
  const stamped = fs.readFileSync(path.join(unpacked, "version"), "utf8").trim();
  if (stamped !== version) {
    throw new Error(`fetched electron stamps itself ${stamped}, expected ${version}`);
  }
  if (process.platform === "win32") {
    // The launcher is named pixel on every platform, so the window and the
    // task manager say pixel rather than electron.
    fs.renameSync(path.join(unpacked, "electron.exe"), path.join(unpacked, "pixel.exe"));
  }
  fs.rmSync(dest, { recursive: true, force: true });
  fs.renameSync(unpacked, dest);
  fs.writeFileSync(marker, expected);
  process.stderr.write(
    `pixel: installed ${stock ? "" : "patched "}electron v${version} into ${dest}\n`,
  );
} catch (error) {
  process.stderr.write(`pixel: ${error.message}\n`);
  process.exit(1);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
