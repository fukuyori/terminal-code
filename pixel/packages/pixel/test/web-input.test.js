const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const api = {};
new Function("exports", "require", fs.readFileSync(path.join(__dirname, "../dist/web/input.js"), "utf8"))(
  api, name => {
    assert.equal(name, "electron");
    return { clipboard: { writeText() { assert.fail("committed text must not use the clipboard"); } } };
  },
);

const committed = text => ({ key: "unknown", text, kind: "press", mods: {} });
const settle = () => new Promise(resolve => setImmediate(resolve));

test("text insertion finishes before the next commit or key is dispatched", async () => {
  const calls = [], pending = [];
  const contents = {
    insertText(text) {
      calls.push(text);
      return new Promise(resolve => pending.push(resolve));
    },
    sendInputEvent(event) { calls.push(event.keyCode); },
  };
  const input = new api.PageInput({ contents: () => contents, focus() {} });
  input.key(committed("日本"));
  input.key(committed("語入力テスト"));
  input.key({ key: "backspace", kind: "press", mods: {} });
  assert.deepEqual(calls, ["日本"]);
  pending.shift()();
  await settle();
  assert.deepEqual(calls, ["日本", "語入力テスト"]);
  pending.shift()();
  await settle();
  assert.deepEqual(calls, ["日本", "語入力テスト", "backspace"]);
  input.key(committed("再開"));
  assert.equal(calls.at(-1), "再開");
  pending.shift()();
  await settle();
});

test("committed text waits for focus and a failed insertion does not block later keys", async () => {
  const calls = [];
  let focused;
  const focus = new Promise(resolve => { focused = resolve; });
  const contents = {
    insertText(text) {
      calls.push(text);
      return calls.length === 1 ? Promise.reject(new Error("closed target")) : Promise.resolve();
    },
  };
  const input = new api.PageInput({ contents: () => contents, focus: () => focus });
  input.key(committed("日本"));
  input.key(committed("再開"));
  assert.deepEqual(calls, []);
  focused();
  await settle();
  assert.deepEqual(calls, ["日本", "再開"]);
});
