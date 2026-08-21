const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const {
  LEADER_ACTION,
  WRAPPER_NAME,
  allConflicts,
  freedChords,
  fromWezterm,
  parseLeader,
  parseLuaKeys,
  removeFreed,
  setEnvOpsForTest,
  toWezterm,
  wrapperContents,
  writeFreed,
} = require("../dist/shortcuts/backends/wezterm.js");

const SHOW_KEYS_LUA = [
  "local wezterm = require 'wezterm'",
  "local act = wezterm.action",
  "",
  "return {",
  "  keys = {",
  "    { key = 'Tab', mods = 'CTRL', action = act.ActivateTabRelative(1) },",
  "    { key = '\\\"', mods = 'ALT|CTRL', action = act.SplitVertical{ domain =  'CurrentPaneDomain' } },",
  "    { key = 'w', mods = 'SHIFT|CTRL', action = act.CloseCurrentTab{ confirm = true } },",
  "    { key = 'c', mods = 'SHIFT|CTRL', action = act.CopyTo 'Clipboard' },",
  "    { key = 'phys:Space', mods = 'SHIFT|CTRL', action = act.QuickSelect },",
  "    { key = 'PageUp', mods = 'SHIFT', action = act.ScrollByPage(-1) },",
  "    { key = 'LeftArrow', mods = 'SHIFT|CTRL', action = act.ActivatePaneDirection 'Left' },",
  "    { key = '-', mods = 'LEADER', action = act.SplitVertical{ domain =  'CurrentPaneDomain' } },",
  "    { key = 'F11', action = act.ToggleFullScreen },",
  "  },",
  "  key_tables = {",
  "    copy_mode = {",
  "      { key = 'Tab', mods = 'NONE', action = act.CopyMode 'MoveForwardWord' },",
  "    },",
  "  },",
  "}",
].join("\n");

const SHOW_KEYS_PLAIN = [
  "Leader: Char('q') CTRL 2s",
  "Default key table",
  "-----------------",
  "",
  "\tCTRL                 Tab                ->   ActivateTabRelative(1)",
].join("\n");

test("show-keys --lua parses into keys, stopping at the key tables", () => {
  const keys = parseLuaKeys(SHOW_KEYS_LUA);
  assert.equal(keys.length, 9, "everything before key_tables, nothing after");
  assert.deepEqual(keys[0], { key: "Tab", mods: ["CTRL"], action: "act.ActivateTabRelative(1)" });
  assert.deepEqual(keys[1].key, '"', "escaped quotes unescape");
  assert.deepEqual(keys[8], { key: "F11", mods: [], action: "act.ToggleFullScreen" });
  assert.equal(keys[2].action, "act.CloseCurrentTab{ confirm = true }");
});

test("the leader line parses into a chord and its timeout", () => {
  assert.deepEqual(parseLeader(SHOW_KEYS_PLAIN), { chord: "ctrl+q", timeoutMs: 2000 });
  assert.equal(parseLeader("Default key table\n---\n"), null);
  assert.deepEqual(parseLeader("Leader: Char('a') SHIFT | CTRL 1500ms"), {
    chord: "ctrl+shift+a",
    timeoutMs: 1500,
  });
});

test("wezterm keys and editor chords translate both ways", () => {
  assert.equal(fromWezterm("Tab", ["CTRL"]), "ctrl+tab");
  assert.equal(fromWezterm("LeftArrow", ["SHIFT", "CTRL"]), "ctrl+shift+left");
  assert.equal(fromWezterm("phys:Space", ["SHIFT", "CTRL"]), "ctrl+shift+space");
  assert.equal(fromWezterm("F11", []), "f11");
  assert.equal(fromWezterm("q", ["SUPER"]), "cmd+q");
  assert.equal(fromWezterm("W", ["CTRL"]), "ctrl+shift+w", "the case carries the folded shift");
  assert.equal(fromWezterm("-", ["LEADER"]), null, "leader-guarded binds are not chords");
  assert.equal(fromWezterm("Copy", []), null, "media keys have no editor chord");

  assert.deepEqual(toWezterm("ctrl+shift+left"), { key: "LeftArrow", mods: "CTRL|SHIFT" });
  assert.deepEqual(toWezterm("ctrl+space"), { key: "phys:Space", mods: "CTRL" });
  assert.deepEqual(toWezterm("ctrl+shift+q"), { key: "q", mods: "CTRL|SHIFT" });
  // every spelling fromWezterm accepts must round-trip back
  for (const [key, mods, chord] of [
    ["PageUp", ["SHIFT"], "shift+pageup"],
    ["Enter", ["ALT"], "alt+enter"],
    ["UpArrow", ["CTRL"], "ctrl+up"],
  ]) {
    assert.equal(fromWezterm(key, mods), chord);
    const back = toWezterm(chord);
    assert.equal(fromWezterm(back.key, back.mods.split("|").filter(Boolean)), chord);
  }
});

test("the wrapper loads the user config first and appends tode's overrides", () => {
  const contents = wrapperContents({
    userConfig: "C:/Users/x/.config/wezterm/wezterm.lua",
    moves: [
      { trigger: "ctrl+q", to: "ctrl+shift+q", action: LEADER_ACTION },
      { trigger: "ctrl+shift+w", to: "ctrl+alt+w", action: "act.CloseCurrentTab{ confirm = true }" },
      { trigger: "ctrl+shift+space" },
    ],
    leaderChord: "ctrl+q",
    leaderTimeoutMs: 2000,
    envWas: null,
  });
  assert.match(contents, /^-- written by tode --shortcut-setup/);
  assert.match(contents, /-- tode:user C:\/Users\/x\/\.config\/wezterm\/wezterm\.lua/);
  assert.match(contents, /-- tode:freed ctrl\+q/);
  assert.match(contents, /-- tode:leader ctrl\+q 2000/);
  assert.match(contents, /local chunk = loadfile\(user\)/);
  // every freed chord falls through to the terminal
  assert.match(contents, /\{ key = 'q', mods = 'CTRL', action = act\.DisableDefaultAssignment \}/);
  assert.match(contents, /\{ key = 'phys:Space', mods = 'CTRL\|SHIFT', action = act\.DisableDefaultAssignment \}/);
  // a carried action lands on its new chord with the exact expression
  assert.match(contents, /\{ key = 'w', mods = 'CTRL\|ALT', action = act\.CloseCurrentTab\{ confirm = true \} \}/);
  // the leader moves, keeping the user's timeout when it can be read
  assert.match(contents, /config\.leader = \{ key = 'q', mods = 'CTRL\|SHIFT', timeout_milliseconds = \(leader and leader\.timeout_milliseconds\) or 2000 \}/);
  assert.match(contents, /return config\s*$/);
});

test("freeing the leader without a target clears it", () => {
  const contents = wrapperContents({
    userConfig: "C:/u/wezterm.lua",
    moves: [{ trigger: "ctrl+q" }],
    leaderChord: "ctrl+q",
    leaderTimeoutMs: 2000,
    envWas: null,
  });
  assert.match(contents, /config\.leader = nil/);
  assert.doesNotMatch(contents, /timeout_milliseconds/);
});

test("writeFreed points the env var at the wrapper, and undo restores what was there", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tode-wezterm-"));
  const user = path.join(dir, "wezterm.lua");
  fs.writeFileSync(user, "return {}\n");
  const wrapper = path.join(dir, WRAPPER_NAME);
  const env = { value: "C:\\custom\\own-config.lua" };
  setEnvOpsForTest({
    get: () => env.value,
    set: (value) => {
      env.value = value;
    },
    clear: () => {
      env.value = null;
    },
  });
  try {
    const written = writeFreed(user, [{ trigger: "ctrl+q" }], { chord: "ctrl+q", timeoutMs: 2000 });
    assert.equal(written, wrapper);
    assert.equal(env.value, wrapper, "the env var now names the wrapper");
    assert.deepEqual([...freedChords(wrapper)], ["ctrl+q"]);
    const contents = fs.readFileSync(wrapper, "utf8");
    assert.match(contents, /-- tode:env-was C:\\custom\\own-config\.lua/);

    // a rewrite keeps the recorded original, not the wrapper itself
    writeFreed(user, [{ trigger: "ctrl+q" }, { trigger: "ctrl+shift+w" }], null);
    assert.match(fs.readFileSync(wrapper, "utf8"), /-- tode:env-was C:\\custom\\own-config\.lua/);
    assert.match(
      fs.readFileSync(wrapper, "utf8"),
      /-- tode:leader ctrl\+q 2000/,
      "the leader survives rewrites where the live scan cannot see it any more",
    );

    // no moves left: the wrapper goes and the env var goes back
    writeFreed(user, [], null);
    assert.equal(fs.existsSync(wrapper), false);
    assert.equal(env.value, "C:\\custom\\own-config.lua");
    assert.equal(removeFreed(wrapper), false, "nothing left for undo to do");
    assert.equal(fs.readFileSync(user, "utf8"), "return {}\n", "the user's config is untouched");
  } finally {
    setEnvOpsForTest(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("undo clears the env var when nothing preceded tode", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tode-wezterm-"));
  const user = path.join(dir, "wezterm.lua");
  fs.writeFileSync(user, "return {}\n");
  const wrapper = path.join(dir, WRAPPER_NAME);
  const env = { value: null };
  setEnvOpsForTest({
    get: () => env.value,
    set: (value) => {
      env.value = value;
    },
    clear: () => {
      env.value = null;
    },
  });
  try {
    writeFreed(user, [{ trigger: "ctrl+q" }], null);
    assert.equal(env.value, wrapper);
    assert.equal(removeFreed(wrapper), true);
    assert.equal(env.value, null);
    assert.equal(fs.existsSync(wrapper), false);
  } finally {
    setEnvOpsForTest(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the scan surfaces the leader and real binds, and skips the harmless", () => {
  const binds = {
    keys: parseLuaKeys(SHOW_KEYS_LUA),
    leader: { chord: "ctrl+q", timeoutMs: 2000 },
  };
  const holds = (chord) =>
    ({
      "ctrl+q": [{ command: "tode.confirmQuit", describes: "quit terminal-code" }],
      "ctrl+tab": [{ command: "workbench.action.nextEditor" }],
      "ctrl+shift+w": [{ command: "workbench.action.closeWindow" }],
      "ctrl+shift+c": [{ command: "terminal.copy" }],
      "ctrl+shift+space": [{ command: "editor.triggerParameterHints" }],
    })[chord] ?? [];
  const conflicts = allConflicts(binds, new Set(), holds, () => null);
  const byId = new Map(conflicts.map((conflict) => [conflict.editorId, conflict]));

  const leader = byId.get("ctrl+q");
  assert.ok(leader, "the leader chord is a conflict");
  assert.equal(leader.current, LEADER_ACTION);
  assert.match(leader.inTerminal, /leader prefix/);

  assert.ok(byId.has("ctrl+tab"));
  assert.equal(byId.get("ctrl+shift+w").current, "act.CloseCurrentTab{ confirm = true }");
  assert.ok(byId.has("ctrl+shift+space"), "QuickSelect is a real conflict");
  assert.ok(!byId.has("ctrl+shift+c"), "clipboard actions are harmless");

  // a freed chord that is gone from the live table still shows, without action
  const freed = allConflicts(
    { keys: [], leader: null },
    new Set(["ctrl+shift+w"]),
    holds,
    () => "act.CloseCurrentTab{ confirm = true }",
  );
  assert.equal(freed.length, 1);
  assert.equal(freed[0].current, "act.CloseCurrentTab{ confirm = true }");
});
