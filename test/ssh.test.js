const assert = require("node:assert/strict");
const { test } = require("node:test");

const { upstreamSshVersion } = require("../dist/ssh.js");
const { versionMatches } = require("../dist/runtime/platform.js");

test("a Windows fork version maps to the matching upstream version", () => {
  assert.equal(upstreamSshVersion("0.3.4-win.1"), "v0.3.4");
  assert.equal(upstreamSshVersion("v0.3.4-win.2"), "v0.3.4");
});

test("upstream and development versions pass through unchanged", () => {
  assert.equal(upstreamSshVersion("v0.3.4"), "v0.3.4");
  assert.equal(upstreamSshVersion("dev"), "dev");
});

test("Windows runs the window in pixel's own electron, which is a .exe", {
  skip: process.platform !== "win32",
}, () => {
  const { electronBinary } = require("../dist/runtime/launcher.js");
  assert.match(electronBinary(), /[\\/]pixel\.exe$/);
});
