import type { OpenRequest } from "../ipc";
import type { BridgeCtx } from "./ctx";

/** The deliberately small part of vscode's API that the bridge uses. Keeping
 * it structural means the generated extension remains dependency-free without
 * giving up typechecking while it is authored here. */
interface Disposable {
  dispose(): void;
}

interface Uri {
  with(change: { scheme?: string; path?: string }): Uri;
  toString(): string;
}

interface BridgeTheme extends Record<string, unknown> {
  colors?: Record<string, string>;
  tokenColors?: unknown[];
}

interface BridgeRequest extends Omit<OpenRequest, "theme"> {
  theme?: BridgeTheme;
}

interface VscodeApi {
  ConfigurationTarget: { Global: unknown };
  TextEditorRevealType: { InCenter: unknown };
  Position: new (line: number, column: number) => unknown;
  Selection: new (anchor: unknown, active: unknown) => unknown;
  Range: new (start: unknown, end: unknown) => unknown;
  Uri: {
    file(target: string): Uri;
    from(parts: { scheme: string; authority: string; path: string }): Uri;
    parse(target: string): Uri;
  };
  commands: {
    registerCommand(command: string, callback: () => unknown): Disposable;
    executeCommand(command: string, ...args: unknown[]): Promise<unknown>;
  };
  env: {
    remoteAuthority?: string;
    openExternal(target: Uri): PromiseLike<boolean>;
  };
  /** optional: absent in the trimmed test harness, and the resolver then
   * trusts the given name */
  extensions?: {
    all: Array<{
      packageJSON?: { contributes?: { themes?: Array<{ label?: string; id?: string }> } };
    }>;
  };
  window: {
    showErrorMessage(
      message: string,
      options: { modal: boolean },
      ...items: string[]
    ): PromiseLike<string | undefined>;
    showTextDocument(
      document: { uri: Uri },
      options: { preview: boolean },
    ): Promise<{
      selection: unknown;
      revealRange(range: unknown, revealType: unknown): void;
    }>;
    tabGroups: {
      all: Array<{
        tabs: Array<{ input?: { uri?: Uri; modified?: Uri } }>;
      }>;
      onDidChangeTabs(listener: () => void): Disposable;
    };
  };
  workspace: {
    getConfiguration(): {
      get(key: string): unknown;
      inspect(key: string): { globalValue?: unknown } | undefined;
      update(key: string, value: unknown, target: unknown): unknown;
    };
    onDidChangeConfiguration(listener: (event: { affectsConfiguration(key: string): boolean }) => void): Disposable;
    workspaceFolders?: readonly { uri: Uri }[];
    openTextDocument(uri: Uri): Promise<{ uri: Uri }>;
    updateWorkspaceFolders(start: number, deleteCount: number, ...folders: Array<{ uri: Uri }>): boolean;
  };
}

interface ExtensionContext {
  subscriptions: Disposable[];
  environmentVariableCollection: { replace(name: string, value: string): void };
}

export function bridgeMain(ctx: BridgeCtx): void {
  const fs = require("fs") as typeof import("node:fs");
  const net = require("net") as typeof import("node:net");
  const path = require("path") as typeof import("node:path");
  const vscode = require("vscode") as VscodeApi;

  const LIVE_THEME_FILE = ctx.liveThemeFile;
  const QUIT_HINT = ctx.quitHint;
  const STARTUP_OPEN_FILE = ctx.startupOpenFile;
  const COLOR_THEME_FILE = ctx.colorThemeFile;

  const VIEW_COMMANDS: Record<string, string> = { scm: "workbench.view.scm" };

  function focusView(view: string): void {
    const command = VIEW_COMMANDS[view];
    if (command) void vscode.commands.executeCommand(command);
  }

  function applyStartupOpen(): void {
    let parsed: (Partial<BridgeRequest> & { at?: number }) | null;
    try {
      parsed = JSON.parse(fs.readFileSync(STARTUP_OPEN_FILE, "utf8"));
    } catch {
      return;
    }
    try {
      fs.rmSync(STARTUP_OPEN_FILE, { force: true });
    } catch {}
    if (!parsed || Date.now() - (parsed.at || 0) > 120000) return;
    void open({ files: [], folders: [], add: false, ...parsed, wait: false }, () => {});
  }

  const NL = String.fromCharCode(10);

  function quitTode(): void {
    void vscode.env.openExternal(vscode.Uri.parse("terminal-browser://quit"));
  }

  /** Whether tode's colours are the ones in charge.
   *
   * tode paints by writing colorCustomizations over whatever theme is active,
   * which is how a window follows the terminal without a reload. That is only
   * right while the workbench is wearing tode's own theme: the moment someone
   * picks another one, those customizations would paint over their choice and
   * it would look like the theme never changed. */
  function chosenTheme(): unknown {
    // inspect, not get: get resolves through the default layer and so never
    // says whether anyone actually picked anything
    const inspected = vscode.workspace.getConfiguration().inspect("workbench.colorTheme");
    return inspected ? inspected.globalValue : undefined;
  }

  function todeOwnsTheme(): boolean {
    const chosen = chosenTheme();
    return chosen === undefined || chosen === ctx.themeName;
  }

  /** Take tode's colours back off, so the theme the user picked is what shows. */
  function releaseTheme(): void {
    const cfg = vscode.workspace.getConfiguration();
    const target = vscode.ConfigurationTarget.Global;
    if (cfg.get("workbench.colorCustomizations") !== undefined) {
      cfg.update("workbench.colorCustomizations", undefined, target);
    }
    if (cfg.get("editor.tokenColorCustomizations") !== undefined) {
      cfg.update("editor.tokenColorCustomizations", undefined, target);
    }
  }

  function applyThemeDocument(theme: BridgeTheme | null | undefined): void {
    if (!theme || typeof theme !== "object") return;
    if (!todeOwnsTheme()) return;
    const cfg = vscode.workspace.getConfiguration();
    const target = vscode.ConfigurationTarget.Global;
    if (theme.colors) {
      cfg.update("workbench.colorCustomizations", theme.colors, target);
    }
    if (theme.tokenColors) {
      cfg.update("editor.tokenColorCustomizations", { textMateRules: theme.tokenColors }, target);
    }
  }

  /** The label the workbench knows the wanted theme by. Contributed labels and
   * ids match case-insensitively, so a typed name lands on the real spelling;
   * where the extension list cannot be read, the name is trusted as given. */
  function resolveThemeLabel(name: string): string | null {
    const list = vscode.extensions?.all;
    if (!list) return name;
    const wanted = name.toLowerCase();
    let sawAny = false;
    for (const extension of list) {
      for (const theme of extension.packageJSON?.contributes?.themes ?? []) {
        sawAny = true;
        if (theme.id && theme.id.toLowerCase() === wanted) return theme.id;
        if (theme.label && theme.label.toLowerCase() === wanted) return theme.label;
      }
    }
    return sawAny ? null : name;
  }

  /** The theme this workbench is meant to wear, kept in a file on tode's side.
   *
   * The browser workbench does not manage to keep this itself: its theme
   * service boots on an unloaded placeholder (settingsId "__vs" and friends)
   * and writes that placeholder into the settings, over whatever was chosen —
   * its own persisted theme state never survives these windows either. So the
   * record lives with tode, the bridge restores it whenever the placeholder
   * lands, and a theme the user picks in the editor becomes the new record. */
  function chosenColorTheme(): string | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(COLOR_THEME_FILE, "utf8")) as { name?: string };
      return parsed?.name || null;
    } catch {
      return null;
    }
  }

  function recordColorTheme(name: string): void {
    try {
      fs.mkdirSync(path.dirname(COLOR_THEME_FILE), { recursive: true });
      fs.writeFileSync(COLOR_THEME_FILE, `${JSON.stringify({ name })}${NL}`);
    } catch {}
  }

  /** Select a color theme by name, the way the theme picker does: written to
   * the global layer in the browser. The ownership watcher sees the change and
   * hands tode's colorCustomizations back, so the picked theme is what shows. */
  function applyColorTheme(name: string): boolean {
    const label = resolveThemeLabel(name);
    if (label === null) {
      void vscode.window.showErrorMessage(
        `terminal-code: no color theme named "${name}" is installed`,
        { modal: false },
      );
      return false;
    }
    void vscode.workspace
      .getConfiguration()
      .update("workbench.colorTheme", label, vscode.ConfigurationTarget.Global);
    recordColorTheme(label);
    return true;
  }

  /** Keep the chosen theme in charge of the setting.
   *
   * At activation the record is the deliberate channel and wins; with no
   * record, a real value already in the setting becomes the record, and an
   * empty setting gets tode's own theme, the first-run claim. From then on the
   * placeholder clobber is corrected as it lands — it arrives moments after
   * activation — and a real theme someone picks becomes the new record. The
   * reassert cap keeps a theme that never resolves from turning into a loop. */
  function guardColorTheme(): Disposable {
    let reasserts = 0;
    // resolved so a hand-typed record lands on the label's real spelling; an
    // unresolvable one is written as it is rather than warned about every boot
    const select = (name: string) =>
      void vscode.workspace
        .getConfiguration()
        .update(
          "workbench.colorTheme",
          resolveThemeLabel(name) ?? name,
          vscode.ConfigurationTarget.Global,
        );
    const chosen = chosenColorTheme();
    const current = chosenTheme();
    if (chosen) {
      if (current !== chosen) select(chosen);
    } else if (typeof current === "string" && !current.startsWith("__")) {
      recordColorTheme(current);
    } else if (current === undefined) {
      recordColorTheme(ctx.themeName);
      select(ctx.themeName);
    }
    return vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("workbench.colorTheme")) return;
      const value = chosenTheme();
      if (typeof value !== "string" || !value) return;
      if (value.startsWith("__")) {
        const wanted = chosenColorTheme();
        if (wanted && reasserts < 5) {
          reasserts += 1;
          select(wanted);
        }
        return;
      }
      recordColorTheme(value);
    });
  }

  function applyLiveTheme(): void {
    if (!todeOwnsTheme()) return;
    let theme: BridgeTheme;
    try {
      theme = JSON.parse(fs.readFileSync(LIVE_THEME_FILE, "utf8"));
    } catch {
      return;
    }
    applyThemeDocument(theme);
  }

  /** Follow the workbench's colour theme as the user changes it: hand the
   * colours back when they pick their own, take them up again if they come back
   * to tode's. Only a change of side does anything, so the config writes this
   * makes cannot feed themselves. */
  function watchThemeOwnership(): () => void {
    let owned = todeOwnsTheme();
    const subscription = vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("workbench.colorTheme")) return;
      const now = todeOwnsTheme();
      if (now === owned) return;
      owned = now;
      if (now) applyLiveTheme();
      else releaseTheme();
    });
    if (!owned) releaseTheme();
    return () => subscription.dispose();
  }

  function persistLiveTheme(theme: BridgeTheme): void {
    try {
      fs.mkdirSync(path.dirname(LIVE_THEME_FILE), { recursive: true });
      fs.writeFileSync(`${LIVE_THEME_FILE}.tmp`, JSON.stringify(theme) + NL);
      fs.renameSync(`${LIVE_THEME_FILE}.tmp`, LIVE_THEME_FILE);
    } catch {}
  }

  function watchLiveTheme(): () => void {
    applyLiveTheme();
    const dir = path.dirname(LIVE_THEME_FILE);
    const name = path.basename(LIVE_THEME_FILE);
    let timer: NodeJS.Timeout | null = null;
    let watcher: import("node:fs").FSWatcher | null = null;
    try {
      fs.mkdirSync(dir, { recursive: true });
      watcher = fs.watch(dir, { persistent: false }, (_event, filename) => {
        if (filename && filename !== name) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(applyLiveTheme, 30);
      });
    } catch {}
    return () => {
      if (timer) clearTimeout(timer);
      if (watcher) watcher.close();
    };
  }

  /** Where this window listens, and the file that tells the rest of tode about
   * it. A named pipe has no directory entry of its own, so on Windows the entry
   * is a plain file naming the pipe; on posix the entry is the socket. */
  function ipcEndpoint(): { address: string; advertised: string } {
    const dir = ctx.ipcDir;
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {}
    const name = `w${process.pid}-${Date.now()}`;
    if (process.platform === "win32") {
      const advertised = path.join(dir, `${name}.pipe`);
      const address = ["\\\\", ".", "\\", "pipe", "\\", "tode-", name].join("");
      fs.writeFileSync(advertised, address);
      return { address, advertised };
    }
    const address = path.join(dir, `${name}.sock`);
    return { address, advertised: address };
  }

  /** The path half of a vscode uri is always posix, with the drive letter
   * behind a leading slash: C:\src is /C:/src. Uri.file does this itself; the
   * two paths below build a uri by hand and have to do it too. */
  function uriPath(target: string): string {
    if (process.platform !== "win32") return target;
    const posix = target.split("\\").join("/");
    return posix.charAt(0) === "/" ? posix : `/${posix}`;
  }

  function workspaceUri(target: string): Uri {
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) return folders[0].uri.with({ path: uriPath(target) });
    if (vscode.env.remoteAuthority) {
      return vscode.Uri.from({
        scheme: "vscode-remote",
        authority: vscode.env.remoteAuthority,
        path: uriPath(target),
      });
    }
    return vscode.Uri.file(target);
  }

  function sameUri(a: Uri, b: Uri): boolean {
    return a.toString() === b.toString();
  }

  function alreadyOpen(uri: Uri): boolean {
    const folders = vscode.workspace.workspaceFolders || [];
    return folders.some((folder) => sameUri(folder.uri, uri));
  }

  async function open(request: BridgeRequest, acknowledge: () => void): Promise<void> {
    if (request.quit) {
      // answered first: the window is about to go, and the caller is waiting
      acknowledge();
      quitTode();
      return;
    }
    if (request.colorTheme) {
      acknowledge();
      applyColorTheme(request.colorTheme);
      return;
    }
    if (request.theme) {
      if (!todeOwnsTheme()) return;
      applyThemeDocument(request.theme);
      persistLiveTheme(request.theme);
      return;
    }
    if (request.view) focusView(request.view);
    if (request.diff && request.diff.length === 2) {
      const left = vscode.Uri.file(request.diff[0]);
      const right = vscode.Uri.file(request.diff[1]);
      await vscode.commands.executeCommand("vscode.diff", left, right);
    }
    const opened: string[] = [];
    for (const file of request.files || []) {
      // like vim: a file that does not exist yet opens as a buffer bound to
      // its path — the untitled scheme keeps the path as the save target
      const uri = fs.existsSync(file.path)
        ? vscode.Uri.file(file.path)
        : vscode.Uri.file(file.path).with({ scheme: "untitled" });
      const document = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(document, { preview: false });
      opened.push(document.uri.toString());
      if (file.line) {
        const line = Math.max(0, file.line - 1);
        const column = Math.max(0, (file.column || 1) - 1);
        const at = new vscode.Position(line, column);
        editor.selection = new vscode.Selection(at, at);
        editor.revealRange(new vscode.Range(at, at), vscode.TextEditorRevealType.InCenter);
      }
    }

    const wanted = (request.folders || []).map(workspaceUri).filter((uri) => {
      return !alreadyOpen(uri);
    });

    if (wanted.length === 0) {
      if (request.wait && opened.length > 0) await untilClosed(opened);
      acknowledge();
      return;
    }

    acknowledge();
    for (const uri of wanted) {
      if (request.add) {
        const at = (vscode.workspace.workspaceFolders || []).length;
        vscode.workspace.updateWorkspaceFolders(at, 0, { uri });
      } else {
        await vscode.commands.executeCommand("vscode.openFolder", uri, { forceNewWindow: false });
      }
    }
  }

  function untilClosed(uris: string[]): Promise<void> {
    const waiting = uris.slice();
    const anyStillOpen = () => {
      const open: Record<string, boolean> = {};
      for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
          const input = tab.input;
          if (input?.uri) open[input.uri.toString()] = true;
          if (input?.modified) open[input.modified.toString()] = true;
        }
      }
      return waiting.some((uri) => open[uri]);
    };
    if (!anyStillOpen()) return Promise.resolve();
    return new Promise((resolve) => {
      const subscription = vscode.window.tabGroups.onDidChangeTabs(() => {
        if (anyStillOpen()) return;
        subscription.dispose();
        resolve();
      });
    });
  }

  function activate(context: ExtensionContext): void {
    context.subscriptions.push(vscode.commands.registerCommand("tode.quit", quitTode));

    let confirmShowing = false;
    context.subscriptions.push(
      vscode.commands.registerCommand("tode.confirmQuit", () => {
        if (confirmShowing) return;
        confirmShowing = true;
        vscode.window
          .showErrorMessage("Do you want to quit terminal-code?", { modal: true }, "Quit")
          .then(
            (picked) => {
              confirmShowing = false;
              if (picked === "Quit") quitTode();
            },
            () => {
              confirmShowing = false;
            },
          );
      }),
    );

    // er don't know if we want this think about it
    let hintShowing = false;
    context.subscriptions.push(
      vscode.commands.registerCommand("tode.quitHint", () => {
        if (hintShowing) return;
        hintShowing = true;
        const done = () => {
          hintShowing = false;
        };
        vscode.window.showErrorMessage(QUIT_HINT, { modal: true }).then(done, done);
      }),
    );

    // huh?
    applyStartupOpen();

    context.subscriptions.push(guardColorTheme());
    const stopWatchingSettings = watchLiveTheme();
    context.subscriptions.push({ dispose: stopWatchingSettings });
    const stopWatchingOwnership = watchThemeOwnership();
    context.subscriptions.push({ dispose: stopWatchingOwnership });

    const endpoint = ipcEndpoint();
    const sock = endpoint.address;
    const server = net.createServer((connection) => {
      let buffer = "";
      connection.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        const newline = buffer.indexOf(NL);
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        buffer = "";
        let request: BridgeRequest;
        try {
          request = JSON.parse(line);
        } catch {
          connection.end(JSON.stringify({ ok: false, error: "bad request" }) + NL);
          return;
        }
        let answered = false;
        const acknowledge = () => {
          if (answered) return;
          answered = true;
          connection.end(JSON.stringify({ ok: true }) + NL);
        };
        Promise.resolve(open(request, acknowledge)).then(acknowledge, (error: unknown) => {
          if (answered) return;
          answered = true;
          connection.end(JSON.stringify({ ok: false, error: String(error) }) + NL);
        });
      });
      connection.on("error", () => {});
    });
    server.on("error", () => {});
    server.listen(sock, () => {
      context.environmentVariableCollection.replace("TODE_IPC", sock);
    });
    context.subscriptions.push({
      dispose: () => {
        try {
          server.close();
        } catch {}
        try {
          fs.rmSync(endpoint.advertised, { force: true });
        } catch {}
      },
    });
  }

  module.exports.activate = activate;
  module.exports.deactivate = () => {};
}
