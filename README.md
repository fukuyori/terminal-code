# terminal-code

[日本語](README.ja.md)

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
   `0.8.0-win.1` — or another `0.8.0-win.*` revision — using the
   `terminal-browser-<version>-windows-x64.exe` installer. You also need a
   terminal that speaks the [kitty graphics protocol](https://sw.kovidgoyal.net/kitty/graphics-protocol/).
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

**Quitting.** On Windows, both `Ctrl+Q` and `Ctrl+Shift+Q` quit, so the latter
remains available when WezTerm owns `Ctrl+Q` — for example through
`config.leader`. Run `tode --shortcut-setup` to resolve other conflicts: the wizard finds
every chord the editor needs that the terminal holds and frees or moves them,
WezTerm included. Or name another quit chord by hand and the next open
remembers it:

```powershell
$env:TODE_QUIT_CHORD = "ctrl+alt+q"
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

### New on Windows in 0.3.4-win.1

This release merges the complete upstream `v0.3.4` source into the Windows
branch. The Windows-specific integration is described below; the full release
record is in [CHANGELOG.md](CHANGELOG.md).

#### Remote workspaces over SSH

Windows can now keep terminal-browser and the rendered VS Code interface on
the local machine while running only the editor server on a remote Unix host:

```powershell
tode --ssh dev@build-box
tode --ssh build-box ~/src/project
tode --ssh "dev@build-box -p 2222" ~/src/project
```

The first command opens the remote home directory, the second opens a remote
path, and the third shows how SSH options can be passed as one quoted value.
Entries from the user's OpenSSH configuration can be used as host aliases.
`user@host:port` is also accepted and is translated to the matching SSH port
option.

The local side creates a small deployment bundle containing the terminal
palette, settings, keybindings, snippets, tasks, and an extension list.
terminal-browser `0.8.0-win.1` copies that bundle to the remote machine, makes
sure upstream terminal-code `v0.3.4` is installed, prepares its profile, starts
the remote `--serve` backend, and proxies its network traffic back to the local
browser. Chromium, drawing, keyboard handling, and the terminal graphics
protocol therefore stay on Windows instead of crossing the SSH connection.

Management commands that do not need a browser are forwarded directly through
the system `ssh` command. This includes extension installation, extension
removal, extension listing, shutdown, and upgrade operations. For example:

```powershell
tode --ssh build-box --list-extensions
tode --ssh build-box --install-extension rust-lang.rust-analyzer
```

The remote bundle currently targets a Unix host because its setup and startup
entries use POSIX shell tools and paths. Windows needs OpenSSH Client and
`tar.exe` on `PATH`. Bundle preparation can create multiple SSH connections,
so key authentication or `ssh-agent` is recommended.

#### Profile bootstrap and extension batching

Remote startup imports the local profile before opening the workspace. Existing
remote settings are merged through the normal import path; keybindings,
snippets, and tasks are handled by the same import implementation used by
`tode --import`. Extensions are compared case-insensitively against the remote
installation, and only missing entries are sent to the editor server in one
batch. Version-qualified entries such as `publisher.extension@1.2.3` remain
qualified. A partial installation failure is reported without hiding the
extensions that succeeded.

#### terminal-browser application integration

Opening an installed copy of tode now registers it with terminal-browser under
the stable application id `terminal-code`. Browser panes are opened with the
same application name and id, allowing terminal-browser to identify them as
one application and expose terminal-code through its application discovery and
new-tab UI. Registration is skipped when there is no installed `tode.cmd`, so
running source files directly does not register a broken launcher.

#### Windows runtime compatibility

The Windows runtime pin is now terminal-browser `v0.8.0`; a fork version such
as `0.8.0-win.1` is recognized as that compatible base. Windows continues to
run the separately installed browser in
`%LOCALAPPDATA%\Programs\terminal-browser` without copying its Electron tree
into every terminal-code installation. macOS and Linux retain upstream's
`v0.7.3` pin.

### Building from the checkout

For working on tode itself, a dev install replaces the released one:

```powershell
npm install
npm run dist:windows
```

That stages the build into `%LOCALAPPDATA%\Programs\tode`, writes
`bin\tode.cmd`, and adds that `bin` directory to the user PATH. A build is
named after the upstream version this fork builds on plus its own revision,
the way terminal-browser's Windows builds are: `0.3.4-win.1` is the first
Windows build on upstream `0.3.4`. The current one is the `$TodeWindowsVersion`
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
curl -fsSL https://tode.sh/install | bash
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
  --ssh <user@host>     Run terminal-code on an ssh server

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
  --serve [path]        Start code server and print its url
  --skill               An agent skill to assist with modifying terminal-code
  --upgrade [--check]   Upgrade terminal-code to the latest version
  --shutdown            Stop all terminal-code activities
  --uninstall [--yes]   Remove all terminal-code data from this machine

```

### How does it work?

terminal-code combines [terminal-browser](https://github.com/zenbu-labs/terminal-browser) (a browser in the terminal) and [code-server](https://github.com/coder/code-server) (VS Code in the browser) to bring VS Code to the terminal. You should look into these projects for more details!



### Shortcuts

Your terminal and terminal-code will likely conflict on important shortcuts, meaning sometimes terminal-code will never even receive your key press. To resolve
shortcut conflicts you can run `tode --shortcut-setup`, and you will be placed into an interactive wizard that lets you change terminal or terminal-code shortcuts
so they no longer conflict



### SSH

The recommended way to use terminal-code over ssh is running `tode --ssh <ssh arguments>` on your local machine.

The alternative is running `tode` directly on the machine you are shh'd into. This will work, but
requires:
- every single frame drawn by vscode to be sent over the network
- all user input to be sent over the network before vscode can react
- misses out some [extra optimizations](https://sw.kovidgoyal.net/kitty/graphics-protocol/#local-client)

`tode --ssh` improves on this by running only the backend of vscode on the remote machine. The frontend is still running locally on your device, so vscode is able to respond to interactions ~instantly. Any network requests will get proxied over the ssh connection.

On Windows this requires terminal-browser `0.8.0-win.1`, plus OpenSSH Client
and `tar.exe` on `PATH`. SSH host aliases are supported. Key authentication or
`ssh-agent` is recommended because preparing the remote bundle may open more
than one SSH connection. The remote bundle currently supports Unix hosts.

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
startup. `Ctrl+Q` often matters because WezTerm's `config.leader` may own it;
Windows therefore also binds `Ctrl+Shift+Q` to quit by default. The wizard can
free the leader or carry it to another chord, keeping its timeout.
`tode --shortcut-setup --undo`
removes the wrapper and puts the variable back the way it was. Terminals other
than WezTerm have no Windows backend yet — there the wizard says so and steps
aside, and `TODE_QUIT_CHORD` still names the quit chord by hand:

```powershell
$env:TODE_QUIT_CHORD = "ctrl+alt+q"
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

  Building and packaging from a checkout uses two scripts. The first compiles
  and stages the payload; the second creates the upgrade ZIP, manifests, and
  Inno Setup installer:

  ```powershell
  npm run build:windows                   # 1. compile + stage payload
  npm run package:windows                 # 2. ZIP + manifests + Inno Setup
  ```

  `package:windows` requires Inno Setup. terminal-code has no native
  `tode.exe`; the installed entry point is `bin\tode.cmd`, so these scripts do
  not provide a `-Sign` option. Inno Setup includes its standard uninstaller.
  Both scripts use the version at the top of `scripts\stage-windows.ps1` — the
  same value a dev install reports.

  Publishing is a separate, explicitly invoked operation:

  ```powershell
  npm run publish:windows                 # gh release create v<version>
  ```

  The publishing script runs the artifacts through the local Windows Defender
  engine first and, when `VT_API_KEY` is set, uploads the installer to
  VirusTotal. A detection stops publication; `-ScanOnly` runs only those
  checks. Because the generated files are unsigned, publishing requires the
  existing `-AllowUnsigned` opt-in.

If you would rather not run any of this, the Linux build inside
[WSL](https://learn.microsoft.com/en-us/windows/wsl/install) is still an option.
