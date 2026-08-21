import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { holdsStamp } from "../../profile";
import { makeEditorHolds } from "../holds";
import type { EditorHold, FreedMove, ProviderConflict, ShortcutProvider } from "../provider";
import { loadDecisions } from "../store";
import { canonicalChord } from "../vscode-keymap";
import { words } from "../words";

/** WezTerm has no include directive and its config is a Lua program, so this
 * backend never edits the user's file. It writes a wrapper next to it —
 * tode-wezterm.lua, which loads the real config and appends tode's overrides
 * after it, where later entries win — and points the WEZTERM_CONFIG_FILE user
 * environment variable at the wrapper. Undo restores the variable and removes
 * the wrapper; the user's Lua is never touched either way. */

export function isWezterm(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TERM_PROGRAM === "WezTerm" || !!env.WEZTERM_PANE || !!env.WEZTERM_EXECUTABLE;
}

export function weztermBinary(): string | null {
  const dir = process.env.WEZTERM_EXECUTABLE_DIR;
  if (dir) {
    const exe = path.join(dir, process.platform === "win32" ? "wezterm.exe" : "wezterm");
    if (fs.existsSync(exe)) return exe;
  }
  try {
    const finder = process.platform === "win32" ? "where" : "which";
    const found = execFileSync(finder, ["wezterm"], { encoding: "utf8" })
      .split(/\r?\n/)[0]
      .trim();
    return found || null;
  } catch {
    return null;
  }
}

export interface WeztermKey {
  key: string;
  mods: string[];
  /** The action exactly as `show-keys --lua` spells it — a Lua expression over
   * `act`, reusable verbatim when a move carries the action to another chord. */
  action: string;
}

/** Reads `wezterm show-keys --lua`. Entries under key_tables only fire inside
 * those modes (copy_mode, search_mode), so parsing stops where they start. */
export function parseLuaKeys(output: string): WeztermKey[] {
  const entries: WeztermKey[] = [];
  for (const line of output.split("\n")) {
    if (/^\s*key_tables\s*=/.test(line)) break;
    const match = /^\s*\{ key = '((?:\\.|[^'\\])*)'(?:, mods = '([A-Z|]+)')?, action = (.*?) \},?\s*$/.exec(
      line,
    );
    if (!match) continue;
    entries.push({
      key: match[1].replace(/\\(.)/g, "$1"),
      mods: match[2] ? match[2].split("|") : [],
      action: match[3],
    });
  }
  return entries;
}

/** The leader is not a keys entry; only the plain `show-keys` names it, as a
 * Rust debug line: `Leader: Char('q') CTRL 2s`. */
export function parseLeader(plain: string): { chord: string; timeoutMs: number } | null {
  const line = plain.split("\n").find((entry) => entry.startsWith("Leader:"));
  if (!line) return null;
  const rest = line.slice("Leader:".length).trim();
  const duration = /\s(\d+(?:\.\d+)?)(ms|s)\s*$/.exec(rest);
  const timeoutMs = duration
    ? Math.round(Number(duration[1]) * (duration[2] === "s" ? 1000 : 1))
    : 1000;
  const body = (duration ? rest.slice(0, duration.index) : rest).trim();
  const named = /^(Char\('(\\.|[^'])'\)|Function\((\d+)\)|[A-Za-z]+)/.exec(body);
  if (!named) return null;
  const key =
    named[2] !== undefined
      ? named[2].replace(/^\\/, "")
      : named[3] !== undefined
        ? `F${named[3]}`
        : named[1];
  const mods = body
    .slice(named[0].length)
    .split(/[\s|]+/)
    .filter(Boolean);
  const chord = fromWezterm(key, mods);
  return chord ? { chord, timeoutMs } : null;
}

/** WezTerm key names the editor spells differently. Media keys map to null:
 * they have no editor chord at all. */
const FROM_KEYS: Record<string, string | null> = {
  Tab: "tab",
  Enter: "enter",
  Escape: "escape",
  Backspace: "backspace",
  Delete: "delete",
  Home: "home",
  End: "end",
  PageUp: "pageup",
  PageDown: "pagedown",
  LeftArrow: "left",
  RightArrow: "right",
  UpArrow: "up",
  DownArrow: "down",
  Space: "space",
  Insert: null,
  Copy: null,
  Paste: null,
};

const FROM_MODS: Record<string, string> = {
  CTRL: "ctrl",
  SHIFT: "shift",
  ALT: "alt",
  SUPER: "cmd",
  CMD: "cmd",
  WIN: "cmd",
};

export function fromWezterm(key: string, mods: string[]): string | null {
  const bare = key.startsWith("phys:") ? key.slice("phys:".length) : key;
  let mapped: string | null;
  let impliedShift = false;
  if (bare in FROM_KEYS) mapped = FROM_KEYS[bare];
  else if (/^F\d{1,2}$/.test(bare)) mapped = bare.toLowerCase();
  else if (bare.length === 1) {
    // wezterm folds shift into the character: CTRL|SHIFT+w is listed as an
    // uppercase W with CTRL alone, so the case carries the modifier
    if (/^[A-Z]$/.test(bare)) impliedShift = true;
    mapped = bare === " " ? "space" : bare.toLowerCase();
  } else mapped = null;
  if (!mapped) return null;
  const parts: string[] = impliedShift ? ["shift"] : [];
  for (const mod of mods) {
    const translated = FROM_MODS[mod];
    // LEADER-guarded binds only fire after the leader and never shadow a
    // chord; anything else unknown is not a chord the editor could hold
    if (!translated) return null;
    parts.push(translated);
  }
  return canonicalChord([...parts, mapped].join("+"));
}

const TO_KEYS: Record<string, string> = {
  tab: "Tab",
  enter: "Enter",
  escape: "Escape",
  backspace: "Backspace",
  delete: "Delete",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  left: "LeftArrow",
  right: "RightArrow",
  up: "UpArrow",
  down: "DownArrow",
  space: "phys:Space",
};

/** Editor chord to the key/mods a written entry uses. This must invert every
 * spelling fromWezterm accepts, or a move writes a key wezterm cannot parse. */
export function toWezterm(chord: string): { key: string; mods: string } {
  const parts = chord.split("+");
  const key = parts.pop()!;
  const MOD: Record<string, string> = { ctrl: "CTRL", shift: "SHIFT", alt: "ALT", cmd: "SUPER" };
  return {
    key: TO_KEYS[key] ?? (/^f\d{1,2}$/.test(key) ? key.toUpperCase() : key),
    mods: parts.map((part) => MOD[part]).filter(Boolean).join("|"),
  };
}

/** The pseudo-action a leader conflict carries, since the leader is a prefix,
 * not an action expression. */
export const LEADER_ACTION = "leader";

export const WRAPPER_NAME = "tode-wezterm.lua";
const HEADER = "-- written by tode --shortcut-setup — frees the chords the editor needs from WezTerm";

/** A path as a Lua string: forward slashes, which Lua and Windows both read. */
function luaPath(text: string): string {
  return `'${text.replace(/\\/g, "/").replace(/'/g, "\\'")}'`;
}

/** Verbatim text as a Lua string — a key name may be a quote or a backslash. */
function luaText(text: string): string {
  return `'${text.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function luaKeyEntry(key: string, mods: string, action: string): string {
  const spelledMods = mods ? `, mods = '${mods}'` : "";
  return `table.insert(config.keys, { key = ${luaText(key)}${spelledMods}, action = ${action} })`;
}

export interface WrapperInput {
  userConfig: string;
  moves: FreedMove[];
  /** The chord the leader sits on, when there is one — a move freeing that
   * chord clears or carries the leader itself. */
  leaderChord: string | null;
  leaderTimeoutMs: number;
  /** A WEZTERM_CONFIG_FILE the user had set themselves before tode pointed it
   * at the wrapper, so undo can put it back. */
  envWas: string | null;
}

export function wrapperContents(input: WrapperInput): string {
  const lines: string[] = [
    HEADER,
    "-- WEZTERM_CONFIG_FILE points here; the real config below is loaded first and",
    "-- tode's overrides are appended after it, so they win. `tode --shortcut-setup",
    "-- --undo` restores the variable and removes this file. Do not edit: it is",
    "-- rewritten on every apply.",
    `-- tode:user ${input.userConfig}`,
    ...(input.envWas ? [`-- tode:env-was ${input.envWas}`] : []),
    ...(input.leaderChord ? [`-- tode:leader ${input.leaderChord} ${input.leaderTimeoutMs}`] : []),
    ...input.moves.map((move) => `-- tode:freed ${move.trigger}`),
    "local wezterm = require 'wezterm'",
    "local act = wezterm.action",
    `local user = ${luaPath(input.userConfig)}`,
    "local config = {}",
    "local chunk = loadfile(user)",
    "if chunk then",
    "  wezterm.add_to_config_reload_watch_list(user)",
    "  config = chunk() or {}",
    "end",
    "config.keys = config.keys or {}",
  ];
  let leaderMove: FreedMove | null = null;
  for (const move of input.moves) {
    const freed = toWezterm(move.trigger);
    // an explicit DisableDefaultAssignment lets the chord fall through to the
    // program in the terminal, and appended after the user's keys it wins over
    // an earlier binding of the same chord
    lines.push(luaKeyEntry(freed.key, freed.mods, "act.DisableDefaultAssignment"));
    if (move.trigger === input.leaderChord) leaderMove = move;
    if (move.to && move.action && move.action !== LEADER_ACTION) {
      const target = toWezterm(move.to);
      lines.push(luaKeyEntry(target.key, target.mods, move.action));
    }
  }
  if (leaderMove) {
    lines.push("local leader = config.leader");
    if (leaderMove.to && leaderMove.action === LEADER_ACTION) {
      const target = toWezterm(leaderMove.to);
      const spelledMods = target.mods ? `mods = '${target.mods}', ` : "";
      lines.push(
        `config.leader = { key = ${luaText(target.key)}, ${spelledMods}timeout_milliseconds = (leader and leader.timeout_milliseconds) or ${input.leaderTimeoutMs} }`,
      );
    } else {
      lines.push("config.leader = nil");
    }
  }
  lines.push("return config");
  return `${lines.join("\n")}\n`;
}

function marker(wrapperFile: string, name: string): string | null {
  try {
    const contents = fs.readFileSync(wrapperFile, "utf8");
    const found = new RegExp(`^-- tode:${name} (.+)$`, "m").exec(contents);
    return found ? found[1].trim() : null;
  } catch {
    return null;
  }
}

export function freedChords(wrapperFile: string): Set<string> {
  try {
    const contents = fs.readFileSync(wrapperFile, "utf8");
    return new Set(
      [...contents.matchAll(/^-- tode:freed (.+)$/gm)].map((found) => found[1].trim()),
    );
  } catch {
    return new Set();
  }
}

/** The config wezterm actually loads, wrapper aside. The running wezterm
 * exports WEZTERM_CONFIG_FILE to its children, which makes it the best truth —
 * unless it already names the wrapper, whose marker then remembers the real
 * one. */
export function userConfigFile(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.WEZTERM_CONFIG_FILE;
  if (fromEnv && path.isAbsolute(fromEnv)) {
    if (path.basename(fromEnv).toLowerCase() !== WRAPPER_NAME) return fromEnv;
    const recorded = marker(fromEnv, "user");
    if (recorded) return recorded;
  }
  const home = os.homedir();
  const xdg = path.join(home, ".config", "wezterm", "wezterm.lua");
  if (fs.existsSync(xdg)) return xdg;
  const dotfile = path.join(home, ".wezterm.lua");
  if (fs.existsSync(dotfile)) return dotfile;
  return xdg;
}

export function wrapperFileFor(userConfig: string): string {
  return path.join(path.dirname(userConfig), WRAPPER_NAME);
}

/** The persistent WEZTERM_CONFIG_FILE, at the user level of the registry.
 * SetEnvironmentVariable broadcasts the change, so anything Explorer starts
 * afterwards sees it; running programs need a restart either way. */
interface EnvOps {
  get(): string | null;
  set(value: string): void;
  clear(): void;
}

function powershell(command: string): string {
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "utf8",
    windowsHide: true,
  });
}

const registryEnv: EnvOps = {
  get() {
    try {
      const value = powershell(
        "[Environment]::GetEnvironmentVariable('WEZTERM_CONFIG_FILE','User')",
      ).trim();
      return value || null;
    } catch {
      return null;
    }
  },
  set(value: string) {
    powershell(
      `[Environment]::SetEnvironmentVariable('WEZTERM_CONFIG_FILE','${value.replace(/'/g, "''")}','User')`,
    );
  },
  clear() {
    powershell("[Environment]::SetEnvironmentVariable('WEZTERM_CONFIG_FILE',$null,'User')");
  },
};

let envOps: EnvOps = registryEnv;
export function setEnvOpsForTest(ops: EnvOps | null): void {
  envOps = ops ?? registryEnv;
}

export function writeFreed(userConfig: string, moves: FreedMove[], leader: { chord: string; timeoutMs: number } | null): string {
  const wrapperFile = wrapperFileFor(userConfig);
  if (moves.length === 0) {
    removeFreed(wrapperFile);
    return wrapperFile;
  }
  // the leader the live scan cannot see any more (the active wrapper already
  // cleared it) is still the one the user config sets — the old marker carries
  // its chord across rewrites
  const recordedLeader = marker(wrapperFile, "leader");
  const [recordedChord, recordedTimeout] = recordedLeader?.split(/\s+/) ?? [];
  const envWas = marker(wrapperFile, "env-was") ?? envWasNow(wrapperFile);
  fs.writeFileSync(
    wrapperFile,
    wrapperContents({
      userConfig,
      moves,
      leaderChord: leader?.chord ?? recordedChord ?? null,
      leaderTimeoutMs: leader?.timeoutMs ?? (recordedTimeout ? Number(recordedTimeout) : 1000),
      envWas,
    }),
  );
  const current = envOps.get();
  if (path.resolve(current ?? "") !== path.resolve(wrapperFile)) envOps.set(wrapperFile);
  return wrapperFile;
}

function envWasNow(wrapperFile: string): string | null {
  const current = envOps.get();
  if (!current) return null;
  return path.resolve(current) === path.resolve(wrapperFile) ? null : current;
}

export function removeFreed(wrapperFile: string): boolean {
  let changed = false;
  const envWas = marker(wrapperFile, "env-was");
  if (fs.existsSync(wrapperFile)) {
    fs.rmSync(wrapperFile, { force: true });
    changed = true;
  }
  const current = envOps.get();
  if (current && path.resolve(current) === path.resolve(wrapperFile)) {
    if (envWas) envOps.set(envWas);
    else envOps.clear();
    changed = true;
  }
  return changed;
}

let showKeysSource: (() => { lua: string; plain: string }) | null = null;
export function setShowKeysForTest(source: (() => { lua: string; plain: string }) | null): void {
  showKeysSource = source;
  effectiveCache = null;
  scanCache = null;
}

let effectiveCache: { keys: WeztermKey[]; leader: { chord: string; timeoutMs: number } | null } | null = null;

function effective(): { keys: WeztermKey[]; leader: { chord: string; timeoutMs: number } | null } {
  if (effectiveCache) return effectiveCache;
  const source = showKeysSource
    ? showKeysSource()
    : (() => {
        const binary = weztermBinary()!;
        return {
          lua: execFileSync(binary, ["show-keys", "--lua"], { encoding: "utf8", windowsHide: true }),
          plain: execFileSync(binary, ["show-keys"], { encoding: "utf8", windowsHide: true }),
        };
      })();
  effectiveCache = { keys: parseLuaKeys(source.lua), leader: parseLeader(source.plain) };
  return effectiveCache;
}

/** Actions that never block an editor chord in a way worth trading away:
 * clipboard, scrolling, search, and the entries tode itself writes. */
const HARMLESS_ACTION =
  /^act\.(CopyTo|PasteFrom|Paste\b|ScrollBy|ScrollTo|Search\b|ClearSelection|DisableDefaultAssignment|Nop\b)/;

function decidedAction(chord: string): string | null {
  const choices = loadDecisions()?.choices ?? {};
  const direct = choices[chord]?.action;
  if (direct) return direct;
  for (const [id, decision] of Object.entries(choices)) {
    const owns = id === `claim:${chord}` || id.startsWith(`claim:${chord}:`);
    if (owns && decision.owner === "terminal" && decision.action) {
      return decision.action;
    }
  }
  return null;
}

export function describeAction(action: string): string {
  if (action === LEADER_ACTION) return "the leader prefix";
  const named = /^act\.(\w+)/.exec(action);
  return named ? words(named[1]) : words(action);
}

export function allConflicts(
  binds: { keys: WeztermKey[]; leader: { chord: string; timeoutMs: number } | null },
  freed: Set<string>,
  holds: (chord: string) => EditorHold[] = makeEditorHolds(),
  past: (chord: string) => string | null = decidedAction,
): ProviderConflict[] {
  const seen = new Set<string>();
  const conflicts: ProviderConflict[] = [];

  const consider = (chord: string | null, action: string | null) => {
    if (!chord || seen.has(chord)) return;
    if (action !== null && action !== LEADER_ACTION && HARMLESS_ACTION.test(action)) return;
    const held = holds(chord);
    if (held.length === 0) return;
    const [primary, ...others] = held;
    seen.add(chord);
    const ran = action ?? past(chord);
    const means = primary.describes ?? words(primary.command);
    const leaderish = ran === LEADER_ACTION;
    const doing = ran ? describeAction(ran) : "what it ran before";
    conflicts.push({
      editorId: chord,
      trigger: chord,
      current: ran,
      editor: { means, command: primary.command, guard: primary.guard },
      others,
      short: doing,
      inTerminal: leaderish
        ? `arms WezTerm's leader prefix, so ${means} never reaches the editor`
        : `runs ${doing} in WezTerm, so ${means} never reaches the editor`,
      freed: `${doing} goes`,
      tradeoff: leaderish
        ? "WezTerm's leader prefix moves or stops working"
        : `WezTerm's ${doing} stops working`,
    });
  };

  // the leader first: it shadows any keys entry on the same chord
  if (binds.leader) consider(binds.leader.chord, LEADER_ACTION);
  for (const entry of binds.keys) {
    if (entry.mods.includes("LEADER")) continue;
    const chord = fromWezterm(entry.key, entry.mods);
    consider(chord, chord && freed.has(chord) ? null : entry.action);
  }
  for (const chord of freed) consider(chord, null);
  return conflicts;
}

let scanCache: { stamp: string; conflicts: ProviderConflict[] } | null = null;

export const weztermProvider: ShortcutProvider = {
  id: "wezterm",
  name: "WezTerm",
  detect: isWezterm,
  ready() {
    return weztermBinary()
      ? null
      : "the wezterm cli is not on PATH, so its keybinds cannot be read";
  },
  scan(): ProviderConflict[] {
    const stamp = holdsStamp();
    if (scanCache?.stamp !== stamp) {
      const wrapperFile = wrapperFileFor(userConfigFile());
      scanCache = { stamp, conflicts: allConflicts(effective(), freedChords(wrapperFile)) };
    }
    return scanCache.conflicts;
  },
  takenAs(chord: string): string | null {
    const binds = effective();
    if (binds.leader?.chord === chord) return LEADER_ACTION;
    for (const entry of binds.keys) {
      if (entry.mods.includes("LEADER") || HARMLESS_ACTION.test(entry.action)) continue;
      if (fromWezterm(entry.key, entry.mods) === chord) return entry.action;
    }
    return null;
  },
  // editor chords are the trigger syntax here: the wrapper is generated from
  // parsed parts, so there is no second spelling to translate into
  trigger: (chord: string) => chord,
  describe: describeAction,
  apply(moves: FreedMove[]): string {
    const leader = effective().leader;
    effectiveCache = null;
    scanCache = null;
    return writeFreed(userConfigFile(), moves, leader);
  },
  onApplied(): boolean {
    // wezterm reloads the config file it is running from when it changes; that
    // is the wrapper only once WEZTERM_CONFIG_FILE pointed there at launch
    const loaded = process.env.WEZTERM_CONFIG_FILE;
    return !!loaded && path.basename(loaded).toLowerCase() === WRAPPER_NAME;
  },
  undo(): boolean {
    effectiveCache = null;
    scanCache = null;
    return removeFreed(wrapperFileFor(userConfigFile()));
  },
  reloadHint(): string {
    return "restart WezTerm for this to take effect — it reads WEZTERM_CONFIG_FILE at startup";
  },
};
