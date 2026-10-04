const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { test } = require("node:test");

const { Surface } = require("../dist/react/surface.js");
const source = path.join(__dirname, "../dist/host/frame.js");

function presenter(platform) {
  const exports = {};
  vm.runInNewContext(fs.readFileSync(source, "utf8"), {
    exports, require: createRequire(source), process: { platform },
  }, { filename: source });
  return exports.presentGuestFrame;
}

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pixel-guest-frame-"));
  t.after(() => {
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith("pixel-guest-frame-"));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return path.join(dir, "frame.bgra");
}

test("Windows guest frames reach a bitmap-only engine before acknowledgement, including resize", (t) => {
  const file = scratch(t);
  const present = presenter("win32");
  const received = [];
  const surface = new Surface({
    updateSurface(id, bytes, width, height) {
      assert.equal(id, 7);
      assert.equal(bytes.length, width * height * 4);
      received.push(Buffer.from(bytes));
    },
  }, 7);
  let acks = 0;
  for (const [width, height] of [[4, 2], [2, 1], [5, 3]]) {
    const pixels = Buffer.alloc(width * height * 4, acks + 1);
    fs.writeFileSync(file, pixels);
    present(surface, {
      path: file, width, height,
      ack() {
        assert.equal(received.length, ++acks);
        assert.deepEqual(received.at(-1), pixels);
        fs.writeFileSync(file, Buffer.alloc(pixels.length));
      },
    });
    assert.deepEqual(received.at(-1), pixels);
  }
  assert.equal(acks, 3);
});

test("Unix keeps the frame open until the shared-memory surface is released", (t) => {
  const file = scratch(t);
  fs.writeFileSync(file, Buffer.alloc(32));
  let acks = 0;
  let submitted;
  presenter("linux")({ present(frame) { submitted = frame; } }, {
    path: file, width: 4, height: 2, ack() { acks++; },
  });
  assert.equal(acks, 0);
  assert.equal(submitted.shm.stride, 16);
  assert.equal(fs.fstatSync(submitted.shm.fd).size, 32);
  submitted.released();
  submitted.released();
  assert.equal(acks, 1);
  assert.throws(() => fs.fstatSync(submitted.shm.fd), { code: "EBADF" });
});

for (const platform of ["win32", "linux"]) {
  test(`${platform} acknowledges unreadable frames and can present the next one`, (t) => {
    const file = scratch(t);
    const present = presenter(platform);
    let acks = 0;
    const frame = { path: file, width: 4, height: 2, ack() { acks++; } };
    const surface = { present(value) { value.released?.(); } };
    assert.throws(() => present(surface, frame), { code: "ENOENT" });
    assert.equal(acks, 1);
    fs.writeFileSync(file, Buffer.alloc(32));
    present(surface, frame);
    assert.equal(acks, 2);
  });

  test(`${platform} closes the frame and acknowledges once when submission fails`, (t) => {
    const file = scratch(t);
    fs.writeFileSync(file, Buffer.alloc(32));
    const open = fs.openSync;
    let opened;
    t.mock.method(fs, "openSync", (...args) => (opened = open(...args)));
    let acks = 0;
    const present = presenter(platform);
    assert.throws(() => present({ present() { throw new Error("submission failed"); } }, {
      path: file, width: 4, height: 2, ack() { acks++; },
    }), /submission failed/);
    assert.equal(acks, 1);
    assert.throws(() => fs.fstatSync(opened), { code: "EBADF" });
  });
}
