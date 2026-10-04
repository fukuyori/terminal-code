const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  parseSshTarget,
  resolveSshTarget,
  socksProxyRules,
  sshCommandArgs,
  sshTunnelArgs,
  validateBundleDir,
  validateSshTarget,
} = require("../dist/ssh");

test("ssh targets split into destination and port", () => {
  assert.deepEqual(parseSshTarget("dev@build-box"), { destination: "dev@build-box", sshPort: null });
  assert.deepEqual(parseSshTarget("build-box:2222"), { destination: "build-box", sshPort: "2222" });
  assert.throws(() => parseSshTarget("not a host"));
});

test("a full ssh command keeps its flags as host arguments", () => {
  const resolved = resolveSshTarget("ssh -i ~/.ssh/id -p 2200 dev@box");
  assert.equal(resolved.destination, "dev@box");
  assert.deepEqual(resolved.hostArgs, ["-i", "~/.ssh/id", "-p", "2200"]);
  assert.throws(() => resolveSshTarget("ssh one two"));
});

test("a target with flags and a port keeps both", () => {
  assert.deepEqual(resolveSshTarget("ssh -J jump -i key dev@build-box:2222"), {
    destination: "dev@build-box",
    hostArgs: ["-J", "jump", "-i", "key", "-p", "2222"],
    aliasCommand: null,
  });
  assert.doesNotThrow(() => validateSshTarget("-F config build-box"));
  assert.throws(() => validateSshTarget("first second"), /both first and second/);
});

test("without a control socket ssh stays in the foreground", () => {
  assert.deepEqual(sshTunnelArgs("build-box", ["-p", "2222"], 43123, null), [
    "-N",
    "-D",
    "127.0.0.1:43123",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    "-p",
    "2222",
    "build-box",
  ]);
});

test("remote commands reuse host arguments without ControlMaster", () => {
  const tunnel = {
    destination: "build-box",
    hostArgs: ["-J", "jump", "-p", "2222"],
    socksPort: 43123,
    controlPath: null,
    localFilesNeedChmod: true,
    stop() {},
  };
  assert.deepEqual(sshCommandArgs(tunnel, "true", true), [
    "-tt",
    "-J",
    "jump",
    "-p",
    "2222",
    "build-box",
    "true",
  ]);
});

// chmod cannot grant an executable bit on Windows, so the file never becomes
// the executable this checks for.
const posixOnly = { skip: process.platform === "win32" };

test("a bundle needs an executable start script", posixOnly, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-"));
  assert.throws(() => validateBundleDir(dir, "linux"));
  fs.writeFileSync(path.join(dir, "start"), "#!/bin/sh\n", { mode: 0o644 });
  assert.throws(() => validateBundleDir(dir, "linux"), /start is not executable/);
  fs.chmodSync(path.join(dir, "start"), 0o755);
  validateBundleDir(dir, "linux");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a bundle written on Windows carries no executable bit to check", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-win-"));
  try {
    fs.writeFileSync(path.join(dir, "start"), "#!/bin/sh\necho READY http://localhost:3000\n", {
      mode: 0o644,
    });
    assert.doesNotThrow(() => validateBundleDir(dir, "win32"));
    assert.throws(() => validateBundleDir(dir, "linux"), /start is not executable/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
