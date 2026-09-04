import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CSS_FILE, USER_DATA_DIR, WEB_CONFIG_FILE } from "./codeserver/server";
import { FONT_FALLBACKS, injectedCss } from "./codeserver/inject";
import { parseJsonc, readKey, setKeys } from "./jsonc";
import { DATA_DIR, WINDOWS } from "./runtime/paths";
import { uriPath } from "./runtime/platform";
import { QUIT_CHORDS, QUIT_COMMAND, claimBindings, fallbackBindings, hintBindings, loadDecisions, overrideBindings, quitBindings, quitWhen, rememberQuitChord, decisionsStamp } from "./shortcuts/store";
import { queryTerminal, withFallbacks } from "./terminal/osc";
import type { ParsedReplies, TerminalPalette } from "./terminal/osc";
import { hex } from "./theme/color";
import {
  THEME_NAME,
  generateTheme,
  paletteFingerprint,
  themeFingerprint,
} from "./theme/generate";

export const VSCODE_DIR = path.join(DATA_DIR, "vscode");
export const USER_DIR = path.join(USER_DATA_DIR, "User");
export const EXTENSIONS_DIR = path.join(VSCODE_DIR, "extensions");
export const THEME_EXTENSION_ID = "tode.tode-theme";

function themeExtensionDir(fingerprint: string): string {
  return path.join(EXTENSIONS_DIR, `${THEME_EXTENSION_ID}-${fingerprint}`);
}

function forgetOldThemeExtensions(keep: string): void {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(EXTENSIONS_DIR);
  } catch {
    return;
  }
  const prefix = `${THEME_EXTENSION_ID}-`;
  for (const entry of entries) {
    if (entry.startsWith(prefix) && entry !== keep) {
      fs.rmSync(path.join(EXTENSIONS_DIR, entry), { recursive: true, force: true });
    }
  }
}
// hm
export const PALETTE_CACHE = path.join(DATA_DIR, "palette.json");
// hm
export const LIVE_THEME_FILE = path.join(DATA_DIR, "live-theme.json");

export const FONT_FAMILY = "JetBrains Mono";
const FONT_FILE = "JetBrainsMono-Regular.ttf";

export function assetPath(name: string): string {
  for (let dir = __dirname; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "assets", "fonts", name);
    if (fs.existsSync(candidate)) return candidate;
    if (path.dirname(dir) === dir) throw new Error(`bundled font missing: ${name}`);
  }
}

export const FONT_ASSET = FONT_FILE;

// interesting, we actually install the font at a legimate location?
export function userFontsDir(): string {
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Fonts");
  if (WINDOWS) {
    const local =
      process.env.LOCALAPPDATA && path.isAbsolute(process.env.LOCALAPPDATA)
        ? process.env.LOCALAPPDATA
        : path.join(os.homedir(), "AppData", "Local");
    return path.join(local, "Microsoft", "Windows", "Fonts");
  }
  const dataHome =
    process.env.XDG_DATA_HOME && path.isAbsolute(process.env.XDG_DATA_HOME)
      ? process.env.XDG_DATA_HOME
      : path.join(os.homedir(), ".local", "share");
  return path.join(dataHome, "fonts");
}

/** The name Windows lists a per-user font under. */
const FONT_REGISTRY_KEY = [
  "HKCU",
  "SOFTWARE",
  "Microsoft",
  "Windows NT",
  "CurrentVersion",
  "Fonts",
].join(path.win32.sep);
const FONT_REGISTRY_VALUE = `${FONT_FAMILY} (TrueType)`;

/** Copying a ttf into the per-user font directory is not enough on Windows: the
 * font only becomes available to applications once it is listed in the registry.
 * The workbench does not depend on this — the css injector serves the same file
 * over @font-face — so a failure here is not worth reporting. */
function registerWindowsFont(target: string): void {
  try {
    execFileSync(
      "reg",
      ["add", FONT_REGISTRY_KEY, "/v", FONT_REGISTRY_VALUE, "/t", "REG_SZ", "/d", target, "/f"],
      { stdio: "ignore", windowsHide: true },
    );
  } catch {}
}

export function unregisterWindowsFont(): void {
  if (!WINDOWS) return;
  try {
    execFileSync("reg", ["delete", FONT_REGISTRY_KEY, "/v", FONT_REGISTRY_VALUE, "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
  } catch {}
}

export function ensureFont(): "installed" | "present" {
  const target = path.join(userFontsDir(), FONT_FILE);
  if (fs.existsSync(target)) return "present";
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(assetPath(FONT_FILE), target);
  } catch {
    // an unwritable font directory is survivable: the page gets the font from
    // the injector either way
    return "present";
  }
  if (WINDOWS) registerWindowsFont(target);
  else if (process.platform !== "darwin") {
    try {
      execFileSync("fc-cache", ["-f", path.dirname(target)], { stdio: "ignore" });
    } catch { }
  }
  return "installed";
}

export function cachedPalette(): TerminalPalette | null {
  try {
    return JSON.parse(fs.readFileSync(PALETTE_CACHE, "utf8")) as TerminalPalette;
  } catch {
    return null;
  }
}

function completeAnswer(asked: ParsedReplies | null): boolean {
  return !!asked?.background && !!asked.foreground && asked.ansi.every((slot) => slot !== null);
}

export function resolvePalette(
  asked: ParsedReplies | null,
  cached: TerminalPalette | null,
): { palette: TerminalPalette; source: "terminal" | "cache" | "default" } {
  if (completeAnswer(asked)) return { palette: withFallbacks(asked), source: "terminal" };
  if (asked?.background) {
    const base = cached ?? withFallbacks(null);
    return {
      palette: {
        background: asked.background,
        foreground: asked.foreground ?? base.foreground,
        ansi: base.ansi.map((slot, at) => asked.ansi[at] ?? slot),
      },
      source: cached ? "cache" : "default",
    };
  }
  if (cached) return { palette: cached, source: "cache" };
  return { palette: withFallbacks(null), source: "default" };
}

export async function readPalette(): Promise<{ palette: TerminalPalette; source: "terminal" | "cache" | "default" }> {
  const resolved = resolvePalette(await queryTerminal(), cachedPalette());
  if (resolved.source === "terminal") {
    fs.mkdirSync(path.dirname(PALETTE_CACHE), { recursive: true });
    fs.writeFileSync(PALETTE_CACHE, `${JSON.stringify(resolved.palette, null, 2)}\n`);
  }
  return resolved;
}

function writeIfChanged(file: string, contents: string): boolean {
  try {
    if (fs.readFileSync(file, "utf8") === contents) return false;
  } catch { }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  return true;
}

/**
 * sus
 */
export interface ThemeDocument {
  name?: string;
  type?: string;
  colors?: Record<string, string>;
  tokenColors?: unknown[];
  semanticHighlighting?: boolean;
}

export function installTheme(palette: TerminalPalette): { changed: boolean; fingerprint: string } {
  return installThemeJson(generateTheme(palette), paletteFingerprint(palette));
}

export function installThemeJson(
  theme: ThemeDocument,
  fingerprint: string,
): { changed: boolean; fingerprint: string } {
  const dir = themeExtensionDir(fingerprint);
  const already = fs.existsSync(path.join(dir, "themes", "tode-terminal.json"));
  if (!already) {
    const manifest = {
      name: "tode-theme",
      displayName: "terminal-code terminal theme",
      publisher: "tode",
      version: "1.0.0",
      engines: { vscode: "^1.80.0" },
      categories: ["Themes"],
      contributes: {
        themes: [
          {
            label: THEME_NAME,
            uiTheme: theme.type === "light" ? "vs" : "vs-dark",
            path: "./themes/tode-terminal.json",
          },
        ],
      },
    };
    fs.mkdirSync(path.join(dir, "themes"), { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    fs.writeFileSync(
      path.join(dir, "themes", "tode-terminal.json"),
      `${JSON.stringify(theme, null, 2)}\n`,
    );
  }
  registerThemeExtension(dir);
  forgetOldThemeExtensions(path.basename(dir));
  return { changed: !already, fingerprint };
}

interface ExtensionEntry {
  identifier: { id: string; uuid?: string };
  version: string;
  relativeLocation?: string;
  location?: { path?: string; scheme?: string; $mid?: number };
  metadata?: Record<string, unknown>;
}

function newestThemeExtensionDir(): string | null {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(EXTENSIONS_DIR);
  } catch {
    return null;
  }
  const prefix = `${THEME_EXTENSION_ID}-`;
  const withMtime = entries
    .filter((entry) => entry.startsWith(prefix))
    .map((entry) => {
      const full = path.join(EXTENSIONS_DIR, entry);
      try {
        return { full, mtime: fs.statSync(full).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((entry): entry is { full: string; mtime: number } => entry !== null);
  if (withMtime.length === 0) return null;
  withMtime.sort((a, b) => b.mtime - a.mtime);
  return withMtime[0].full;
}

export function registerThemeExtension(dir?: string): void {
  const themeDir = dir ?? newestThemeExtensionDir();
  if (!themeDir) return;
  const manifest = path.join(EXTENSIONS_DIR, "extensions.json");
  let listed: ExtensionEntry[] = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(manifest, "utf8"));
    if (Array.isArray(parsed)) listed = parsed;
  } catch {
    return;
  }
  const folder = path.basename(themeDir);
  const entry: ExtensionEntry = {
    identifier: { id: THEME_EXTENSION_ID },
    version: "1.0.0",
    relativeLocation: folder,
    location: { $mid: 1, path: uriPath(themeDir), scheme: "file" },
    metadata: { isApplicationScoped: false, isMachineScoped: false, installedTimestamp: 0 },
  };
  const without = listed.filter((item) => item.identifier?.id !== entry.identifier.id);
  fs.writeFileSync(manifest, `${JSON.stringify([...without, entry], null, 2)}\n`);
}

const FONT_STACK = `"${FONT_FAMILY}", ${FONT_FALLBACKS}`;

export const SETTINGS: Record<string, unknown> = {
  "editor.fontFamily": FONT_STACK,
  "terminal.integrated.fontFamily": FONT_STACK,
  "chat.editor.fontFamily": FONT_STACK,
  "debug.console.fontFamily": FONT_STACK,
  "markdown.preview.fontFamily": FONT_STACK,
  "terminal.integrated.enableImages": true,
  "workbench.startupEditor": "none",
  "workbench.secondarySideBar.defaultVisibility": "hidden",
  "chat.commandCenter.enabled": false,
  // wait what
  "workbench.tips.enabled": false,
  "workbench.welcomePage.walkthroughs.openOnInstall": false,
  "window.commandCenter": false,
  // The default title format ends in ${appName} — "code-server". The folder is
  // already on the window above this bar, so the file name is the only part
  // left worth showing. ${dirty} puts a dot in front of unsaved work.
  "window.title": "${dirty}${activeEditorShort}",
  // wait why are we applying this?
  "editor.smoothScrolling": false,
  "workbench.list.smoothScrolling": false,
  // huh?
  "terminal.integrated.smoothScrolling": false,
  "update.mode": "none",
  // the server flag that turns this off is code-server's; the reh-web server
  // takes it as a setting instead, and it is the same answer on both
  "security.workspace.trust.enabled": false,
  "telemetry.telemetryLevel": "off",
  "workbench.enableExperiments": false,
};

export const SEEDED_SETTINGS: Record<string, unknown> = {
  // Seeded, not managed: tode picks its own theme the first time and then stays
  // out of the way. Changing the colour theme in the editor is a thing people
  // do, and rewriting this on every open would undo it a second later — which
  // is exactly what it used to do.
  "workbench.colorTheme": THEME_NAME,
  "workbench.activityBar.location": "top",
  "editor.fontSize": 13,
  "workbench.tree.indent": 12,
  "editor.cursorBlinking": "solid",
  "editor.minimap.enabled": false,
  "scm.defaultViewMode": "tree",
};

export function installCss(palette: TerminalPalette, background?: string): boolean {
  return writeIfChanged(CSS_FILE, injectedCss(background ?? hex(palette.background), FONT_FAMILY));
}

export function setLiveTheme(theme: ThemeDocument): boolean {
  return writeIfChanged(LIVE_THEME_FILE, `${JSON.stringify(theme)}\n`);
}

/** The theme file the user asked for, if they asked for one. Every open would
 * otherwise regenerate the theme from the terminal's colours, which is what
 * `tode --theme <file>` is asking not to happen. */
export const THEME_CHOICE_FILE = path.join(DATA_DIR, "theme-choice.json");

function readThemeChoice(): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(THEME_CHOICE_FILE, "utf8")) as { file?: string };
    return parsed.file || null;
  } catch {
    return null;
  }
}

export function forgetThemeChoice(): boolean {
  if (!readThemeChoice()) return false;
  fs.rmSync(THEME_CHOICE_FILE, { force: true });
  return true;
}

function readThemeDocument(file: string): ThemeDocument | string {
  let source: string;
  try {
    source = fs.readFileSync(file, "utf8");
  } catch {
    return `could not read ${file}`;
  }
  const theme = parseJsonc<ThemeDocument>(source);
  if (!theme || typeof theme !== "object" || (!theme.colors && !theme.tokenColors)) {
    return `${file} is not a vscode theme (expected a json document with colors or tokenColors)`;
  }
  return theme;
}

export function setThemeFile(file: string): string | null {
  const theme = readThemeDocument(file);
  if (typeof theme === "string") return theme;
  installThemeJson(theme, themeFingerprint(theme));
  setLiveTheme(theme);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(
    THEME_CHOICE_FILE,
    `${JSON.stringify({ file: path.resolve(file) }, null, 2)}
`,
  );
  return null;
}

/** What the editor should be wearing right now: the chosen file if there is one
 * and it still reads, and the terminal's own colours otherwise. A file that has
 * gone away is not an error — the terminal is always there to fall back on. */
export function installActiveTheme(palette: TerminalPalette): ThemeDocument {
  const chosen = readThemeChoice();
  if (chosen) {
    const theme = readThemeDocument(chosen);
    if (typeof theme !== "string") {
      installThemeJson(theme, themeFingerprint(theme));
      setLiveTheme(theme);
      return theme;
    }
  }
  const theme = generateTheme(palette);
  installThemeJson(theme, paletteFingerprint(palette));
  setLiveTheme(theme);
  return theme;
}

/** What the page should be painted with before the workbench has drawn: the
 * theme's own editor background, so a chosen theme does not flash the
 * terminal's colour first. */
export function themeBackground(theme: ThemeDocument, palette: TerminalPalette): string {
  const colour = theme.colors?.["editor.background"];
  if (typeof colour === "string" && /^#[0-9a-f]{6}/i.test(colour)) return colour.slice(0, 7);
  return hex(palette.background);
}

export function managedSettings(): Record<string, unknown> {
  return { ...SETTINGS };
}

export function applySettings(source: string): string {
  const absent = Object.fromEntries(
    Object.entries(SEEDED_SETTINGS).filter(([key]) => readKey(source, key) === undefined),
  );
  return setKeys(setKeys(source, absent), SETTINGS);
}

/** Point the workbench back at tode's own theme. `--theme` is an explicit ask
 * for it, and the user may have picked something else in the meantime. */
export function selectTodeTheme(): boolean {
  const file = path.join(USER_DIR, "settings.json");
  let source = "";
  try {
    source = fs.readFileSync(file, "utf8");
  } catch {}
  return writeIfChanged(file, setKeys(source || "{}", { "workbench.colorTheme": THEME_NAME }));
}

export function installSettings(): boolean {
  // The web workbench never reads this file — see installWebDefaults — but the
  // cli does, for --install-extension and for anything run against the profile
  // directly, so it stays the record of what tode asked for.
  const file = path.join(USER_DIR, "settings.json");
  let source = "";
  try {
    source = fs.readFileSync(file, "utf8");
  } catch { }
  const wrote = writeIfChanged(file, applySettings(source || "{}"));
  return installWebDefaults() || wrote;
}

/** What the page is given as its default settings. Everything tode has an
 * opinion about goes in, managed and seeded alike: in the default layer the
 * distinction stops mattering, since a value the user changes in the editor
 * beats a default without tode having to stay out of its way. */
export function webDefaults(): Record<string, unknown> {
  return { ...SEEDED_SETTINGS, ...SETTINGS };
}

export function installWebDefaults(): boolean {
  return writeIfChanged(WEB_CONFIG_FILE, `${JSON.stringify(webDefaults(), null, 2)}
`);
}

export function builtinKeybindings(): Binding[] {
  return [
    ...QUIT_CHORDS.map((key) => ({ key, command: QUIT_COMMAND, when: quitWhen(key) })),
    ...hintBindings(),
  ];
}

export function todeKeybindings(): unknown[] {
  return [
    ...quitBindings(),
    ...hintBindings(),
    ...fallbackBindings().map(({ key, command, when }) =>
      when ? { key, command, when } : { key, command },
    ),
  ];
}

export interface Binding {
  key?: string;
  command?: string;
  when?: string;
}

const KEYBINDINGS_FILE = path.join(USER_DIR, "keybindings.json");
export const KEYBINDINGS_RECORD = path.join(DATA_DIR, "keybindings.tode.json");

function sameBinding(a: Binding, b: Binding): boolean {
  return a.key === b.key && a.command === b.command && (a.when ?? "") === (b.when ?? "");
}

function readBindings(file: string): Binding[] {
  try {
    const parsed = parseJsonc<Binding[]>(fs.readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function holdsStamp(): string {
  const stamp = (file: string) => {
    try {
      return fs.statSync(file).mtimeMs;
    } catch {
      return 0;
    }
  };
  return [
    stamp(KEYBINDINGS_FILE),
    stamp(KEYBINDINGS_RECORD),
    stamp(path.join(EXTENSIONS_DIR, "extensions.json")),
    stamp(EXTENSIONS_DIR),
    decisionsStamp(),
  ].join(":");
}

export function removalMasked(chord: string, command: string): boolean {
  const canon = (value: string) =>
    value.toLowerCase().split("+").map((part) => part.trim()).sort().join("+");
  const target = `${canon(chord)}:${command}`;
  const negative = (entry: Binding) =>
    !!entry.key &&
    !!entry.command?.startsWith("-") &&
    `${canon(entry.key)}:${entry.command.slice(1)}` === target;
  return (
    readBindings(KEYBINDINGS_FILE).some(negative) ||
    [...overrideBindings(), ...claimBindings()].some(negative)
  );
}

export function foreignBindings(): Binding[] {
  const mine = [...(todeKeybindings() as Binding[]), ...overrideBindings(), ...claimBindings()];
  const previouslyMine = readBindings(KEYBINDINGS_RECORD);
  return readBindings(KEYBINDINGS_FILE).filter(
    (entry) =>
      !previouslyMine.some((old) => sameBinding(old, entry)) &&
      !mine.some((current) => sameBinding(current, entry)),
  );
}

export function installKeybindings(): boolean {
  rememberQuitChord();
  return writeBindings(todeKeybindings() as Binding[], foreignBindings());
}

function quitWinsBindings(theirs: Binding[]): Binding[] {
  const choices = loadDecisions()?.choices ?? {};
  const canon = (chord: string) => chord.toLowerCase().split("+").sort().join("+");
  return QUIT_CHORDS.flatMap((chord) => {
    if (choices[`import:${chord}`] || choices[`claim:${chord}`]) return [];
    const shadowed = theirs.some(
      (entry) =>
        !!entry.key &&
        !!entry.command &&
        !entry.command.startsWith("-") &&
        canon(entry.key) === canon(chord) &&
        entry.command !== QUIT_COMMAND,
    );
    return shadowed ? [{ key: chord, command: QUIT_COMMAND, when: quitWhen(chord) }] : [];
  });
}

function writeBindings(mine: Binding[], theirs: Binding[]): boolean {
  const winners = [...overrideBindings(), ...claimBindings(), ...quitWinsBindings(theirs)];
  fs.mkdirSync(USER_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(KEYBINDINGS_RECORD), { recursive: true });
  fs.writeFileSync(KEYBINDINGS_RECORD, `${JSON.stringify([...mine, ...winners], null, 2)}\n`);
  return writeIfChanged(
    KEYBINDINGS_FILE,
    `// \n${JSON.stringify([...mine, ...theirs, ...winners], null, 2)}\n`,
  );
}

export function mergeKeybindings(theirs: Binding[]): number {
  const existing = foreignBindings();
  const added = theirs.filter((entry) => !existing.some((have) => sameBinding(have, entry)));
  writeBindings(todeKeybindings() as Binding[], [...existing, ...added]);
  return added.length;
}
