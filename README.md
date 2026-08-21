# terminal-code


VS Code inside your terminal



https://github.com/user-attachments/assets/4ba0d434-896a-4ab3-9c91-5d351dacee08


### Windows support (experimental)

This fork adds a native Windows x64 build — no WSL. It has been tested in PowerShell 7 with
WezTerm, next to the Windows build of
[terminal-browser](https://github.com/fukuyori/terminal-browser), which is what draws the pane.

Press `Ctrl+Q` to quit. If the terminal owns that chord — WezTerm's leader often does — name
another one with `TODE_QUIT_CHORD` and the next open remembers it.

Windows-specific changes in this fork include:

- code-server has no Windows build and never has, so Windows runs VSCodium's `reh-web` server:
  the same OSS vscode server code-server wraps, published for `win32-x64`
- Paths under `%LOCALAPPDATA%`, a `.cmd` launcher, and background processes given a console of
  their own with no window, so closing a pane does not take the editor server with it
- Windows named pipes for talking to open windows, and vscode uris built the way vscode itself
  compares them
- tode's settings carried into the workbench in the document it serves, since a workbench in a
  browser never reads them off disk
- `tode --quit` to close a window without a chord, and `tode --reset-terminal` to put a pane
  back after a browser was killed outright
- The shortcut wizard has no Windows backend yet, and says so rather than failing

See [Windows](#windows) below for the details and for what is not there yet.

### Install (macOS & Linux):

```bash
curl -fsSl https://tode.sh/install | bash
```

### Install (Windows, experimental)

There is no published Windows release yet, so a Windows install is built from
this checkout. See [Windows](#windows) below for what is different there and
what is not supported yet.

1. Install [terminal-browser for Windows](https://github.com/fukuyori/terminal-browser/releases)
   (the `terminal-browser-<version>-windows-x64.exe` installer) and a terminal
   that speaks the kitty graphics protocol — [WezTerm](https://wezterm.org) is
   the one this has been tested in.
2. Build and install tode:

```powershell
npm install
npm run dist:windows
```

That stages the build into `%LOCALAPPDATA%\Programs\tode`, writes
`bin\tode.cmd`, and adds that `bin` directory to the user PATH. Open a new
terminal and run `tode`.

A build is named after the upstream version this fork builds on plus its own
revision, the way terminal-browser's Windows builds are: `0.1.0-win.2` would be
the second Windows build on upstream `0.1.0`. The current one is the `-Version`
default at the top of `scripts\dist-windows.ps1` — edit that line to cut a new
one, or pass `-Version` for a one-off. It ends up in `VERSION`, which is what
`tode --version` reports.

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
  --theme [file]        Set editor theme from a vscode theme json. It sticks:
                        every open after it keeps that theme instead of
                        regenerating one from the terminal. `--theme` with no
                        file goes back to the terminal's own colours
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

The colour theme works differently here than the name suggests. tode does not
get the workbench to *select* its theme — no setting reaches the theme service
on this server, `configurationDefaults` included, and a built-in theme named
there does not take either. What does reach it is
`workbench.colorCustomizations`, which the bridge writes over whatever theme is
active, and that is where the terminal's colours come from: the workbench
reports `--vscode-editor-background` as the terminal's own background. Picking
a theme in the editor makes the bridge hand those colours back, so the theme
you picked is what shows.

Not there yet:

- `tode --shortcut-setup` has no Windows backend. Both of the ones that exist
  drive ghostty and kitty through their own config files and binaries. On
  Windows the wizard says so and steps aside; nothing else about tode depends on
  it, and the editor keybindings are installed either way.

  The one chord that matters is the one that quits, `Ctrl+Q`, and a terminal may
  already own it — WezTerm's `config.leader` often does. Without a wizard to
  negotiate that, name the chord yourself and the next open remembers it:

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
  listening, the bridge extension is not running and no chord would have
  reached it either.
- `tode --upgrade` has nothing to upgrade to: there is no Windows release
  channel. Re-run `npm run dist:windows` from the checkout instead.

If you would rather not run any of this, the Linux build inside
[WSL](https://learn.microsoft.com/en-us/windows/wsl/install) is still an option.
