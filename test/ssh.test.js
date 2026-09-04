const assert = require("node:assert/strict");
const { test } = require("node:test");

const { upstreamSshVersion } = require("../dist/ssh.js");
const { PINNED_VERSION } = require("../dist/runtime/release.js");
const { versionMatches } = require("../dist/runtime/platform.js");

test("a Windows fork version maps to the matching upstream version", () => {
  assert.equal(upstreamSshVersion("0.3.4-win.1"), "v0.3.4");
  assert.equal(upstreamSshVersion("v0.3.4-win.2"), "v0.3.4");
});

test("upstream and development versions pass through unchanged", () => {
  assert.equal(upstreamSshVersion("v0.3.4"), "v0.3.4");
  assert.equal(upstreamSshVersion("dev"), "dev");
});

test("Windows uses the browser release that provides SSH and app registration", {
  skip: process.platform !== "win32",
}, () => {
  assert.equal(PINNED_VERSION, "v0.8.0");
  assert.equal(versionMatches("0.8.0-win.1", PINNED_VERSION), true);
});
