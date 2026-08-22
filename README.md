# terminal-code

VS Code inside your terminal — and, in this fork, natively on Windows.

https://github.com/user-attachments/assets/4ba0d434-896a-4ab3-9c91-5d351dacee08

This fork of [zenbu-labs/terminal-code](https://github.com/zenbu-labs/terminal-code)
adds a Windows x64 build that needs no WSL. It is tested in PowerShell 7 inside
[WezTerm](https://wezterm.org), next to the Windows build of
[terminal-browser](https://github.com/fukuyori/terminal-browser), which is what
draws the editor into the pane. Windows support is experimental; the
[Windows](#windows) section below has the details and what is not there yet.

### Install on Windows

1. Install [terminal-browser for Windows](https://github.com/fukuyori/terminal-browser/releases)
   — the `terminal-browser-<version>-windows-x64.exe` installer — and a terminal
   that speaks the [kitty graphics protocol](https://sw.kovidgoyal.net/kitty/graphics-protocol/).
   WezTerm is the one this is tested in.
2. Install tode from the [releases page](https://github.com/fukuyori/terminal-code/releases):
   run `tode-<version>-windows-x64.exe`. It is signed, installs per-user under
   `%LOCALAPPDATA%\Programs\tode` without elevation, and offers to add `tode`
   to your user PATH.
3. Open a new terminal and run `tode`.

The first open fetches VSCodium's `reh-web` server — the same OSS vscode server
code-server wraps, published for `win32-x64` — into
`%LOCALAPPDATA%\tode\data\vscodium-server`. Extensions come from Open VSX.

Later releases arrive through tode itself:

```powershell
tode --upgrade --check   # is there a newer build?
tode --upgrade           # take it
```

### Using it

```powershell
tode                     # open the current folder
tode <folder>            # open a folder
tode <file>              # open a file, in the window you are in if there is one
tode -g <file:line:col>  # open at a position
tode --review            # open on the source control panel
```

Inside a tode window, `tode <file>` reaches that same window through a named
pipe, so the shell you get in the integrated terminal works the way `code` does.

**Quitting.** `Ctrl+Q` quits. If your terminal owns that chord — WezTerm's
`config.leader` often does — run `tode --shortcut-setup`: the wizard finds
every chord the editor needs that the terminal holds and frees or moves them,
WezTerm included. Or name another quit chord by hand and the next open
remembers it:

```powershell
$env:TODE_QUIT_CHORD = "ctrl+shift+q"
tode
```

`tode --quit` closes the open windows from any shell, and `tode --reset-terminal`
puts a pane back if a browser was ever killed outright.

**Colours.** By default the editor follows your terminal's palette. To wear a
theme instead:

```powershell
tode --theme "Monokai"      # any installed color theme, by name
tode --theme mytheme.json   # or a vscode theme file
tode --theme                # back to the terminal's own colours
```

The choice sticks across opens, and picking a theme inside the editor sticks
the same way.

**Settings and extensions.** `tode --import` brings settings, keybindings,
snippets and extensions over from a vscode-compatible editor already on the
machine; `tode --install-extension <id>` installs one from Open VSX. The full
command list is under [Usage](#usage).

### Building from the checkout

For working on tode itself, a dev install replaces the released one:

```powershell
npm install
npm run dist:windows
```

That stages the build into `%LOCALAPPDATA%\Programs\tode`, writes
`bin\tode.cmd`, and adds that `bin` directory to the user PATH. A build is
named after the upstream version this fork builds on plus its own revision,
the way terminal-browser's Windows builds are: `0.1.0-win.2` is the second
Windows build on upstream `0.1.0`. The current one is the `$TodeWindowsVersion`
default at the top of `scripts\stage-windows.ps1`, shared by the dev install
and the release scripts — edit that line to cut a new one, or pass `-Version`
for a one-off. It ends up in `VERSION`, which is what `tode --version` reports.
Cutting a release is described under [Windows](#windows).

### What this fork changes

- code-server has no Windows build and never has, so Windows runs VSCodium's
  `reh-web` server: the same OSS vscode server code-server wraps, published for
  `win32-x64`
- Paths under `%LOCALAPPDATA%`, a `.cmd` launcher, and background processes
  given a console of their own with no window, so closing a pane does not take
  the editor server with it
- Windows named pipes for talking to open windows, and vscode uris built the
  way vscode itself compares them
- tode's settings carried into the workbench in the document it serves, since
  a workbench in a browser never reads them off disk; webviews and resources
  served through that same document's origin, which is what makes the markdown
  preview scroll and themes load
- `tode --quit` to close a window without a chord, and `tode --reset-terminal`
  to put a pane back after a browser was killed outright
- The shortcut wizard drives WezTerm on Windows, through a config wrapper the
  `WEZTERM_CONFIG_FILE` user environment variable points at — the user's Lua is
  never edited. Other terminals still get a clear "not supported" and step aside
- A release channel of its own: signed installers on GitHub releases, which
  `tode --upgrade` follows

### Install on macOS & Linux

Upstream's installer, unchanged:

```bash
curl -fsSl https://tode.sh/install | bash
```

### Usage
```
Usage: tode [path...] [options]
       tode --<command>

  tode                  Open the folder in the current working directory
  tode <folder>         Open the specified folder
  tode <file>           Open the specified file


Options:
  -g, --goto <f:l:c>    Open a file at a line and column
  -a, --add <folder>    Add a folder to the active workspace
  -n, --new-window      Open a new pane even for a file
  -w, --wait            Wait until the file is closed again
  -d, --diff <a> <b>    Compare two files
  -r, --reuse-window    Open folder in this window rather than a new pane
  --install-extension   Install an extension by id or vsix path
  --uninstall-extension Remove an extension
  --list-extensions     List installed extensions
  --split <direction>   Open in a new pane: right, left, down, up
  --size <fraction>     The % a new split will take up (0.2 to 0.95)
  --timing              Report how long each stage of this open took
  --review              Open on the source control panel

Commands, each as the first argument:
  --shortcut-setup      Resolve shortcut conflicts between terminal-code and the current terminal
  --timing              Profile terminal-code launch
  --import [editor]     Bring settings, keybindings, snippets and extensions
                        over from vscode compatible editors
  --theme [file|name]   Set editor theme from a vscode theme json, or pick an
                        installed color theme by name ("Monokai"). It sticks:
                        every open after it keeps that theme instead of
                        regenerating one from the terminal. `--theme` with no
                        argument goes back to the terminal's own colours
  --skill               An agent skill to assist with modifying terminal-code
  --upgrade [--check]   Upgrade terminal-code to the latest version
  --shutdown            Stop all terminal-code activities
  --uninstall [--yes]   Remove all terminal-code data from this machine

```



### Shortcuts

Your terminal and terminal-code will likely conflict on important shortcuts, meaning sometimes terminal-code will never even receive your key press. To resolve
shortcut conflicts you can run `tode --shortcut-setup`, and you will be placed into an interactive wizard that lets you change terminal or terminal-code shortcuts
so they no longer conflict

### How does it work?

terminal-code combines [terminal-browser](https://github.com/zenbu-labs/terminal-browser) (a browser in the terminal) and [code-server](https://github.com/coder/code-server) (VS Code in the browser) to bring VS Code to the terminal. You should look into these projects for more details!


### Windows

Windows support is experimental, and this is what it is made of:

- **The browser.** terminal-browser's [Windows
  build](https://github.com/fukuyori/terminal-browser/releases) draws the pane.
  tode finds it wherever its installer put it
  (`%LOCALAPPDATA%\Programs\terminal-browser`) and runs it from there, with the
  `node.exe` that package ships — nothing is copied or downloaded. You still need
  a terminal that speaks the [kitty graphics
  protocol](https://sw.kovidgoyal.net/kitty/graphics-protocol/); WezTerm is the
  one this has been tested in.
- **The editor server.** code-server has no Windows build — its releases are
  linux and macos only, and the npm package's postinstall just fetches one of
  those. So on Windows tode runs [VSCodium's `reh-web`
  server](https://github.com/VSCodium/vscodium/releases) instead: the same OSS
  vscode server code-server itself wraps, published for `win32-x64`. It is
  fetched on the first open, into `%LOCALAPPDATA%\tode\data\vscodium-server`.
  Extensions come from Open VSX, which is what that build points at; set the
  `VSCODE_GALLERY_SERVICE_URL` / `VSCODE_GALLERY_ITEM_URL` variables to use
  another marketplace.
- **Where things live.** Windows has no XDG split, so the three homes sit under
  `%LOCALAPPDATA%\tode` as `data`, `state` and `cache`. Setting `XDG_DATA_HOME`
  and friends still wins, on Windows as everywhere else.
- **Settings.** The workbench in a browser keeps its user settings in the
  browser, not in the profile directory on disk, so the `settings.json` tode
  writes is read by the cli and by nothing else. What tode wants is handed to
  the page as `configurationDefaults` in the document the injector serves, which
  lands in the default layer — so tode's answers apply and anything changed in
  the editor still wins over them.
- **Talking to open windows.** A window listens on a named pipe rather than a
  unix socket, and advertises it with a small `.pipe` file in
  `%LOCALAPPDATA%\tode\state\ipc`, so `tode <file>` from inside a window still
  reaches the window it is in.

The colour theme has two layers here. The terminal's colours arrive as
`workbench.colorCustomizations`, which the bridge writes over the active theme
while the workbench is wearing tode's own — that is how a window follows the
terminal live, and the workbench reports `--vscode-editor-background` as the
terminal's own background. Actual theme *selection* works too, by name:
`tode --theme "Monokai"` switches the open windows and every open after keeps
it, and picking a theme in the editor makes the bridge hand the terminal's
colours back and remember that choice instead. `tode --theme` with no argument
goes back to the terminal's own colours.

Two repairs make the selection stick, both worth knowing about. The workbench
fetched theme jsons from the server's own port — cross-origin from the page
the injector serves, refused without CORS headers — so the injector hands the
page its own host as the remote authority and everything comes back through
it. And this workbench never keeps its theme state: its theme service boots on
an unloaded placeholder and writes that over the chosen setting, so the choice
lives in `%LOCALAPPDATA%\tode\data\color-theme.json` and the bridge keeps
enforcing it.

**Shortcuts.** `tode --shortcut-setup` drives WezTerm on Windows. WezTerm's
config is a Lua program with no include directive, so the wizard never edits
it: it writes a wrapper (`tode-wezterm.lua`, next to your `wezterm.lua`) that
loads the real config and appends tode's overrides after it, where later
entries win, and points the `WEZTERM_CONFIG_FILE` user environment variable at
that wrapper. Restart WezTerm after applying — it reads that variable at
startup. The one chord that usually matters is `Ctrl+Q`, which quits tode and
which WezTerm's `config.leader` often owns; the wizard can free the leader or
carry it to another chord, keeping its timeout. `tode --shortcut-setup --undo`
removes the wrapper and puts the variable back the way it was. Terminals other
than WezTerm have no Windows backend yet — there the wizard says so and steps
aside, and `TODE_QUIT_CHORD` still names the quit chord by hand:

```powershell
$env:TODE_QUIT_CHORD = "ctrl+shift+q"
tode
```

If a pane is ever killed outright rather than quitting — the browser force
stopped, the process tree torn down — the terminal is left the way that pane
was using it: on the alternate screen, no cursor, mouse reporting on, the last
frame still drawn. `tode --reset-terminal` writes the sequence the browser
would have written on its way out, and hands the pane back without closing it.

`tode --quit` closes the open windows without a chord at all, from any shell.
It is also the way to tell the two failures apart: if it reports no window
listening, the bridge extension is not running and no chord would have reached
it either.

Not there yet:

- `tode --upgrade` follows this fork's [GitHub
  releases](https://github.com/fukuyori/terminal-code/releases): the `windows`
  channel reads `latest.json` off the newest release there, and
  `--upgrade --version <v>` reads the `manifest.json` inside the `v<v>` tag.
  A dev install from the checkout is on the same channel, so `tode --upgrade`
  from one replaces it with the newest release.

  Cutting a release from a checkout is three steps, each its own script:

  ```powershell
  npm run release:windows                 # 1. stage + zip + manifests
  scripts\installer-windows.ps1 -Sign     # 2. Inno Setup installer, signed
  scripts\publish-windows.ps1             # 3. gh release create v<version>
  ```

  Step 2 needs Inno Setup 6 and, for `-Sign`, `CODESIGN_CERT` set to the
  signing certificate's subject name; without `-Sign` it builds unsigned and
  step 3 refuses it unless told `-AllowUnsigned`. Step 3 also runs the
  artifacts through the local Windows Defender engine first — and through
  VirusTotal when `VT_API_KEY` is set, which uploads the installer there —
  and a detection stops the release; `-ScanOnly` runs just those checks. The
  version all three agree on is the default at the top of
  `scripts\stage-windows.ps1` — the same line a dev install reports.

If you would rather not run any of this, the Linux build inside
[WSL](https://learn.microsoft.com/en-us/windows/wsl/install) is still an option.
