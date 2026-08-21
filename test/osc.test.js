const assert = require("node:assert");
const { test } = require("node:test");
const { PassThrough } = require("node:stream");

/** On Windows there is no /dev/tty to open a second handle on, so the palette
 * query borrows the console tode was started in. The browser is spawned with
 * that same console inherited, so the query has to hand it back: a stdin left
 * flowing here goes on eating the bytes meant for the pane, and every mouse
 * report and key press lands in tode instead of the editor.
 *
 * The stubs stand in for a console: node reports readableFlowing === null on a
 * stdin nothing has read yet, which is the state the query starts from and the
 * state it has to leave behind. */
function withFakeConsole(run) {
  const input = new PassThrough();
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (value) => {
    input.isRaw = value;
    return input;
  };
  const stdin = Object.getOwnPropertyDescriptor(process, "stdin");
  const stdout = Object.getOwnPropertyDescriptor(process, "stdout");
  const written = [];
  Object.defineProperty(process, "stdin", { value: input, configurable: true });
  Object.defineProperty(process, "stdout", {
    value: { isTTY: true, write: (chunk) => written.push(chunk) },
    configurable: true,
  });
  const restore = () => {
    Object.defineProperty(process, "stdin", stdin);
    Object.defineProperty(process, "stdout", stdout);
  };
  return Promise.resolve(run(input, written)).finally(restore);
}

const windowsOnly = process.platform === "win32" ? undefined : "the console path is Windows only";

test("the palette query gives the console back to the pane", { skip: windowsOnly }, async () => {
  const { queryTerminal } = require("../dist/terminal/osc.js");
  await withFakeConsole(async (input, written) => {
    const answered = queryTerminal(30, 300);
    // the terminal answers the colours and closes with the device attributes
    input.write("\x1b]11;rgb:0d0d/0f0f/1313\x07\x1b[?62;c");
    const parsed = await answered;

    assert.ok(written.join("").includes("\x1b]11;?"), "the query goes out on stdout");
    assert.deepEqual(parsed.background, [13, 15, 19], "the answer is read back");
    assert.equal(input.isRaw, false, "raw mode is handed back");
    assert.notEqual(input.readableFlowing, true, "stdin must not still be draining into tode");
    assert.equal(input.listenerCount("data"), 0, "no listener is left behind");
  });
});

test("a terminal that never answers still gives the console back", { skip: windowsOnly }, async () => {
  const { queryTerminal } = require("../dist/terminal/osc.js");
  await withFakeConsole(async (input) => {
    assert.equal(await queryTerminal(30, 200), null);
    assert.equal(input.isRaw, false);
    assert.notEqual(input.readableFlowing, true);
  });
});
