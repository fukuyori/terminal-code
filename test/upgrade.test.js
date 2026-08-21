const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

// Everything paths.ts derives is pinned to a scratch tree before dist is
// required, so nothing below can touch a real install or its state.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "tode-upgrade-test-"));
process.env.TODE_INSTALL_ROOT = path.join(scratch, "install");
process.env.XDG_STATE_HOME = path.join(scratch, "state");

const { targetTriple } = require("../dist/runtime/release.js");

function tarBinary() {
  if (process.platform !== "win32") return "tar";
  const system = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
  return fs.existsSync(system) ? system : "tar";
}

/** A release tarball holding the layout swapIn checks for. No bin/ on
 * purpose: the shim lives at the real default install root, which this test
 * must never write to. */
function makeTarball(version) {
  const build = path.join(scratch, `build-${version}`);
  fs.mkdirSync(path.join(build, "tode", "dist"), { recursive: true });
  fs.writeFileSync(path.join(build, "tode", "dist", "main.js"), `// tode ${version}\n`);
  fs.writeFileSync(path.join(build, "tode", "VERSION"), `${version}\n`);
  fs.writeFileSync(path.join(build, "tode", "CHANNEL"), "windows\n");
  const file = `tode-${version}-${targetTriple()}.tar.gz`;
  execFileSync(tarBinary(), ["-czf", path.join(scratch, file), "-C", build, "tode"]);
  const bytes = fs.readFileSync(path.join(scratch, file));
  const sha256 = require("node:crypto").createHash("sha256").update(bytes).digest("hex");
  return { file, bytes, sha256 };
}

function fakeInstall(version) {
  const root = process.env.TODE_INSTALL_ROOT;
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.writeFileSync(path.join(root, "dist", "main.js"), `// tode ${version}\n`);
  fs.writeFileSync(path.join(root, "VERSION"), `${version}\n`);
  fs.writeFileSync(path.join(root, "CHANNEL"), "windows\n");
}

/** Serves the two URL shapes the windows channel uses on GitHub:
 * /latest/download/latest.json and /download/v<version>/<file>. */
function serveRelease(version, tarball) {
  const manifest = (origin) =>
    JSON.stringify({
      version,
      channel: "windows",
      platforms: {
        [targetTriple()]: {
          file: tarball.file,
          sha256: tarball.sha256,
          size: tarball.bytes.length,
          url: `${origin}/download/v${version}/${tarball.file}`,
        },
      },
    });
  const server = http.createServer((request, response) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    if (request.url === "/latest/download/latest.json" || request.url === `/download/v${version}/manifest.json`) {
      response.end(manifest(origin));
    } else if (request.url === `/download/v${version}/${tarball.file}`) {
      response.end(tarball.bytes);
    } else {
      response.statusCode = 404;
      response.end();
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      process.env.TODE_WINDOWS_RELEASE_ORIGIN = `http://127.0.0.1:${server.address().port}`;
      resolve(server);
    });
  });
}

test("the windows channel checks, then upgrades from a github-shaped release", async () => {
  const tarball = makeTarball("9.9.9-win.2");
  const server = await serveRelease("9.9.9-win.2", tarball);
  try {
    const { upgrade } = require("../dist/upgrade.js");
    fakeInstall("9.9.9-win.1");

    const seen = await upgrade({ check: true });
    assert.equal(seen.kind, "available");
    assert.equal(seen.build.version, "9.9.9-win.2");

    const done = await upgrade({});
    assert.equal(done.kind, "upgraded");
    assert.equal(done.from, "9.9.9-win.1");
    const root = process.env.TODE_INSTALL_ROOT;
    assert.equal(fs.readFileSync(path.join(root, "VERSION"), "utf8").trim(), "9.9.9-win.2");
    assert.match(fs.readFileSync(path.join(root, "dist", "main.js"), "utf8"), /9\.9\.9-win\.2/);
    assert.ok(!fs.existsSync(`${root}.old`), "the previous install is cleaned up");

    const receipt = JSON.parse(
      fs.readFileSync(path.join(process.env.XDG_STATE_HOME, "tode", "install.json"), "utf8"),
    );
    assert.equal(receipt.version, "9.9.9-win.2");

    const current = await upgrade({});
    assert.equal(current.kind, "current");
  } finally {
    server.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
