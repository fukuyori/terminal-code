# Changelog

[日本語](CHANGELOG.ja.md)

This file records notable changes to the Windows-native fork of terminal-code.
The version before `-win.N` identifies the upstream terminal-code release; the
suffix identifies the Windows fork revision based on that release.

## 0.4.2-win.1 (unreleased)

This release integrates the complete upstream terminal-code `v0.4.2` source at
commit `6644166` into the Windows-native branch. Upstream's `v0.4.0` replaced
the terminal-browser runtime with [pixel](https://github.com/zenbu-labs/pixel)
and a window process; the 24 files that conflicted with the Windows branch were
resolved onto that design.

### Changed

#### pixel replaces the separately installed terminal-browser

- tode no longer looks for, downloads or runs a terminal-browser install. The
  window is drawn by pixel's patched Electron (`pixel.exe`) and its Windows
  engine (`pixel.node`), both taken from the terminal-browser fork's own
  Windows build, together with the JavaScript that drives them.
- The install carries `node_modules\@zenbu-labs\pixel`, `pixel-native-win32-x64`,
  and a console `node.exe` under `runtime\`. `bin\tode.cmd` runs the `tode`
  command on that `node.exe`: attaching to a console fails for a process that
  has none, and `pixel.exe` is a GUI program even when it runs as node.
- The pixel used is the fork's build, labelled `0.0.20`. It carries the three
  code changes that npm's `0.0.23` has over `0.0.20` (the transparent page
  background, the resize cursor names, the Electron download location); the two
  were not compared in full.
- A `PIXEL` file in the install records which terminal-browser commit and pixel
  version the build came from, and the hash of `pixel.node`. The build checks
  that the engine copied into the install matches the one it came from.
- The build scripts take the terminal-browser checkout with `-TerminalBrowser`
  or `TODE_TERMINAL_BROWSER`. `dist-windows.ps1` no longer checks for or
  vendors terminal-browser, and the installer no longer asks for it.
- Removed `src/runtime/release.ts`, `src/browserglue.ts`,
  `src/browser/mainscript.ts` and their tests; `src/runtime/fetch.ts` keeps the
  Windows target triple and archive extraction the download of the editor
  server uses.

#### One window process per window

- A pixel process attaches to one console for its life, so on Windows each
  window starts a process of its own, under a named pipe of its own, instead of
  one process serving every window. The process exits shortly after its window
  closes.
- `tode --shutdown`, `--upgrade` and `--uninstall` find these processes by
  their command line and stop them together with the editor server's child
  processes (`taskkill /T`), so nothing is left behind.
- The bridge extension tells every window process about a transparency change.

#### Theme choices are kept

- A theme file chosen with `tode --theme <file>` is no longer overruled by the
  terminal's colours arriving later; the check that the removed browser script
  made now lives in the window process.
- `tode --theme` and the active theme follow the transparency setting.

### Added

- `tode --enable-transparency` and `tode --disable-transparency`, from
  upstream. A named color theme paints its own background, so the editor surface
  is transparent only with tode's own theme.
- Upstream's other `v0.4.x` changes: the window process and its protocol, and
  the SSH session built on pixel's SSH support.

### Signing

- `scripts\sign-windows.ps1 -Payload` signs the binaries inside the staged
  install (`pixel.exe`, its dlls, `pixel.node`). `release-windows.ps1 -Sign`
  does it before the ZIP is made, and `installer-windows.ps1 -Sign` stops if any
  are still unsigned.

### Known limitations

- The IME conversion box follows the terminal's cursor, which pixel leaves at
  the last place it drew, so the box can appear away from the caret
  ([terminal-browser#3](https://github.com/fukuyori/terminal-browser/issues/3)).
- WezTerm may hold `Ctrl+Q` and `Ctrl+Shift+Q`. `tode --quit` and
  `tode --shortcut-setup` are the ways around it.
- `tode --ssh` now uses pixel's SSH support and was not re-run on Windows.
- Upgrading from `0.3.4-win.1` through `tode --upgrade` was not run; an
  existing terminal-browser install is simply no longer used.

## 0.3.4-win.1 (unreleased)

This release integrates the complete upstream terminal-code `v0.3.4` source at
commit `1c382930d3bb34297eef7bd83ea9b56dbba2fd16` into the Windows-native branch.
It replaces the previous version-label-only attempt: the upstream commits and
source changes are now part of the merge, with conflicts adapted to the
existing Windows process, path, editor-server, and IPC abstractions.

### Added

#### Additional Windows quit shortcut

- Added `Ctrl+Shift+Q` as a second default quit shortcut on Windows. `Ctrl+Q`
  remains available, while users whose WezTerm leader consumes it can exit
  without changing terminal configuration.
- The shortcut wizard, generated bridge extension, user-level keybindings, and
  quit hint now treat both default chords consistently. Moving `Ctrl+Q` onto
  the existing `Ctrl+Shift+Q` fallback does not create duplicate bindings.
- Setting `TODE_QUIT_CHORD` still explicitly replaces the defaults with the
  selected chord, preserving existing customized installations.

#### Remote editing over SSH

- Added `tode --ssh <target> [path]`. The browser and VS Code frontend remain on
  the local Windows machine, while the editor backend runs on a remote Unix
  host. This avoids sending every rendered frame and every local input event
  through a conventional interactive SSH terminal.
- Added SSH target parsing for `user@host`, `host`, `user@host:port`, OpenSSH
  host aliases, and quoted SSH command arguments. Options that consume a value,
  including identity file, jump host, port, and configuration file options,
  are kept with their values when the SSH process is constructed.
- Added a terminal-browser SSH bundle. The bundle contains scripts that install
  or update terminal-code on the remote host, prepare the remote editor profile,
  start the backend, and return its URL through terminal-browser's SSH proxy.
- Added Windows-version translation for remote installation. A local version
  such as `0.3.4-win.1` requests upstream `v0.3.4` on the Unix host instead of
  looking for a Windows-fork version on the upstream installer service.
- Added direct forwarding for `--install-extension`, `--uninstall-extension`,
  `--list-extensions`, `--shutdown`, and `--upgrade`. These management commands
  run through the system `ssh` client and do not start terminal-browser.
- Added clear validation for a missing SSH target, unsupported command options,
  multiple workspace paths, malformed destinations, and missing remote tode
  installations.

#### Remote profile import

- The SSH bundle carries the local terminal palette and the available profile
  files: settings, keybindings, tasks, snippets, and the extension inventory.
- Added an internal `--serve` command used by the remote bundle. `--prepare`
  imports the profile and prepares assets without leaving a server running;
  normal serve mode starts the editor backend and prints a `READY` URL for
  terminal-browser.
- Remote profile preparation reuses the existing import implementation instead
  of maintaining a second settings-merging path.

#### Batch extension installation

- Added batch processing for the extension list transferred to a remote host.
  Installed identifiers are compared case-insensitively and are not installed
  again.
- Missing extensions are passed to the editor server in one invocation. Explicit
  version suffixes are retained, the terminal-code theme extension is refreshed
  afterward, and partial failure is reported to standard error.

#### terminal-browser application registration

- Installed copies now register `tode` with terminal-browser as the
  `terminal-code` application when a workspace is opened.
- Browser opens include `--app-name=terminal-code` and
  `--app-id=terminal-code`, giving all terminal-code panes a stable identity in
  terminal-browser.
- Registration uses the platform-aware terminal-browser command and the actual
  Windows `tode.cmd` shim. It is detached from the editor startup path and a
  registration error does not prevent a workspace from opening.
- The web usage page now advertises remote SSH operation.

### Windows integration

#### terminal-browser 0.8.0-win.1

- The Windows runtime pin is `v0.8.0`, which accepts fork revisions such as
  `0.8.0-win.1`. The verified Windows build implements all terminal-browser
  commands required by the upstream terminal-code `v0.3.4` features:
  `--ssh`, `--ssh-bundle`, `--ssh-bundle-dir`, `--app-name`, `--app-id`, and
  `register-app`.
- Windows continues to resolve the separately installed browser under
  `%LOCALAPPDATA%\Programs\terminal-browser`, or a build selected through
  `TODE_TERMINAL_BROWSER_BIN`. terminal-code reconstructs the browser command
  with the packaged Node.js runtime and the browser-specific environment.
- macOS and Linux retain upstream's terminal-browser `v0.7.3` pin. The Unix
  release script was updated to extract that side of the platform-dependent pin
  correctly.

#### Native Windows adaptations

- SSH launching, browser launching, shutdown, and application registration use
  the existing command abstraction rather than assuming a directly executable
  Unix launcher.
- Browser processes receive the runtime environment needed by the Windows
  terminal-browser distribution and are started with hidden helper windows where
  appropriate.
- State paths used by the imported upstream tests now use a Windows temporary
  directory and named-pipe-compatible state locations instead of assuming
  `/tmp` and Unix sockets.

### Version and documentation

- Advanced the Windows release version from `0.1.0-win.2` to `0.3.4-win.1`.
- Updated the four-part installer file-version example to `0.3.4.1`.
- Added `scripts/build-windows.ps1`, which compiles the source and creates a
  validated release payload without packaging or changing the installed copy.
- Added `scripts/package-windows.ps1`, which reads that payload and creates the
  upgrade ZIP, `latest.json`, `manifest.json`, and an Inno Setup installer.
  The new scripts intentionally have no `-Sign` option because terminal-code
  has no native `tode.exe`; the launcher is `bin/tode.cmd`.
- Added `docs/version-update-checklist.md`, covering exact upstream tag
  retrieval, commit and changed-file review, conflict resolution, platform
  runtime verification, version surfaces, tests, and release boundaries.
- Expanded the README with the Windows SSH architecture, command examples,
  profile and extension behavior, application registration, runtime
  requirements, and current limitations.
- Added Japanese editions of the README and changelog.

### Requirements and limitations

- Local Windows operation requires terminal-browser `0.8.0-win.1` or another
  compatible `0.8.0-win.*` revision and a terminal implementing the kitty
  graphics protocol. The current Windows validation target is WezTerm.
- SSH mode additionally requires Windows OpenSSH Client and `tar.exe` on
  `PATH`. Since terminal-browser can open multiple connections while installing
  and starting a bundle, key authentication or `ssh-agent` is recommended.
- The remote bundle targets a Unix host. Its scripts use `/bin/sh`, Unix paths,
  executable mode bits, and the upstream shell installer.
- No signed installer, archive, tag, commit, or published release is produced by
  this source integration.

### Verification performed

- Confirmed the fetched upstream `v0.3.4` tag and merge head both resolve to
  `1c382930d3bb34297eef7bd83ea9b56dbba2fd16`.
- Confirmed the local Windows terminal-browser build reports
  `terminal-browser 0.8.0-win.1` and exposes every SSH and application CLI flag
  used by terminal-code.
- Started that browser build through terminal-code's Windows runtime resolver
  and confirmed successful version output.
- Ran the new build and package scripts against an isolated output directory.
  Inno Setup 6.7.3 produced the `0.3.4.1` installer, the ZIP contained all 89
  staged entries, and its SHA-256 matched the generated manifest. The expected
  signature status was `NotSigned`.
- Passed all 140 automated tests and the complete TypeScript type check.
- Passed staged diff checks and shell/PowerShell script syntax checks, with no
  unresolved merge entries or unstaged changes at the time of verification.
- An end-to-end connection to a real SSH host has not yet been run because no
  target host was supplied.
