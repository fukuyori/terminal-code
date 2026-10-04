const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

// the state dir and install root are fixed when the module loads
process.env.XDG_STATE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "tode-protocol-"));
process.env.TODE_INSTALL_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "tode-protocol-install-"));

const { DAEMON_DIR, PROCESS_PER_WINDOW, daemonAddress, windowPipe } = require("../dist/app/protocol.js");

test("a window process is shared everywhere but Windows, where each window has its own", () => {
  assert.equal(PROCESS_PER_WINDOW, process.platform === "win32");
});

test("an address is a socket file in the daemon directory, or a named pipe on Windows", () => {
  const address = daemonAddress("v1.0.0");
  if (process.platform === "win32") {
    assert.match(address, /^\\\\\.\\pipe\\tode-[0-9a-f]{8}-v1\.0\.0$/);
  } else {
    assert.equal(address, path.join(DAEMON_DIR, "v1.0.0.sock"));
  }
});

test("each window process gets a pipe of its own, and a second install does not share it", () => {
  assert.notEqual(windowPipe("a"), windowPipe("b"));
  assert.equal(windowPipe("a"), windowPipe("a"));
});
