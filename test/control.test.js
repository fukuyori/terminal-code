const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

// the state dir is fixed when the module loads, so point it somewhere
// disposable before anything under dist/ is required
const STATE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "tode-control-"));
process.env.XDG_STATE_HOME = STATE_HOME;
const DAEMON_DIR = path.join(STATE_HOME, "tode", "daemon");
fs.mkdirSync(DAEMON_DIR, { recursive: true });

// and a throwaway install root, so the process scan only ever sees daemons
// started by this test and never the developer's real window
const INSTALL_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "tode-install-"));
process.env.TODE_INSTALL_ROOT = INSTALL_ROOT;
const BOOTSTRAP = path.join(INSTALL_ROOT, "node_modules", "@zenbu-labs", "pixel", "dist", "bootstrap.js");
const DAEMON_ENTRY = path.join(INSTALL_ROOT, "dist", "app", "daemon.js");
fs.mkdirSync(path.dirname(BOOTSTRAP), { recursive: true });
fs.mkdirSync(path.dirname(DAEMON_ENTRY), { recursive: true });
fs.writeFileSync(BOOTSTRAP, "require(process.argv[2]);\n");

const { shutdownDaemons, openWindows } = require("../dist/app/control.js");
const { daemonAddress } = require("../dist/app/protocol.js");

// A stand-in window process: listens on the socket, and either answers like
// the real daemon does or sits there wedged.
function fakeDaemon(version, behaviour) {
  // a unix socket, or on Windows a named pipe: the address is the daemon's to say
  const socket = daemonAddress(version);
  const script = `
    const behaviour = process.env.FAKE_DAEMON;
    const net = require("node:net");
    const server = net.createServer((c) => {
      c.on("data", (chunk) => {
        const req = JSON.parse(chunk.toString().trim());
        if (behaviour === "wedged") return;
        if (req.cmd === "status") { c.end(JSON.stringify({ ok: true, pid: process.pid, windows: 2 }) + "\\n"); return; }
        if (req.cmd === "shutdown") {
          c.end(JSON.stringify({ ok: true, pid: process.pid, windows: 2 }) + "\\n");
          setTimeout(() => process.exit(0), 50);
        }
      });
    });
    server.listen(${JSON.stringify(socket)}, () => process.stdout.write("ready\\n"));
  `;
  fs.writeFileSync(DAEMON_ENTRY, script);
  const child = spawn(process.execPath, [BOOTSTRAP, DAEMON_ENTRY], {
    stdio: ["ignore", "pipe", "inherit"],
    env: { ...process.env, FAKE_DAEMON: behaviour },
  });
  fs.writeFileSync(path.join(DAEMON_DIR, `${version}.pid`), String(child.pid));
  return new Promise((resolve) => {
    child.stdout.once("data", () => resolve(child));
  });
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("a daemon that answers is asked to stop, and its windows are counted", async () => {
  const child = await fakeDaemon("v1.0.0", "polite");
  assert.deepEqual(await openWindows(), { count: 2, unknown: false });
  const stopped = await shutdownDaemons();
  assert.deepEqual(stopped, { daemons: 1, windows: 2, killed: 0 });
  await settle(200);
  assert.equal(alive(child.pid), false);
  assert.deepEqual(fs.readdirSync(DAEMON_DIR), []);
});

test("a daemon that will not answer is killed, so an upgrade never waits on it", async () => {
  const child = await fakeDaemon("v1.0.1", "wedged");
  const stopped = await shutdownDaemons();
  assert.deepEqual(stopped, { daemons: 1, windows: 0, killed: 1 });
  assert.equal(alive(child.pid), false);
  assert.deepEqual(fs.readdirSync(DAEMON_DIR), []);
});

test("a socket and pid left by a process that is gone are swept without fuss", async () => {
  fs.writeFileSync(path.join(DAEMON_DIR, "v0.9.0.sock"), "");
  fs.writeFileSync(path.join(DAEMON_DIR, "v0.9.0.pid"), "999999");
  const stopped = await shutdownDaemons();
  assert.deepEqual(stopped, { daemons: 0, windows: 0, killed: 0 });
  assert.deepEqual(fs.readdirSync(DAEMON_DIR), []);
});
