# Where the copy of pixel in `pixel/` comes from

`pixel/` is a snapshot of the `pixel/` directory of the terminal-browser
Windows fork, kept here so terminal-code's Windows build does not depend on a
checkout of another repository, and so a problem in pixel can be reproduced,
measured and fixed from this repository alone.

| | |
|---|---|
| Source repository | https://github.com/fukuyori/terminal-browser (the Windows fork) |
| Source branch | `windows-v0.13.4` |
| Source commit | `d1b9edbb0ac4a5455833759b1e5770a147466fd6` (2026-10-03) |
| Last commit that touched `pixel/` | `a8019327a70276a6b7bd0c5b9c309745610128f0` ("Merge upstream v0.13.4 into the Windows fork") |
| Taken with | `git archive d1b9edb pixel` (committed content only, no working-tree changes) |
| pixel version label | `0.0.20` |
| License | MIT, Zenbu Labs, Inc. (`pixel/LICENSE`) |

pixel itself comes from https://github.com/zenbu-labs/pixel and, since `0.0.21`,
from the `pixel/` directory of https://github.com/zenbu-labs/terminal-browser.
The Windows support in the copy (console attachment, named pipes, the Windows
engine, SSH on Windows) was added in the fork.

## Changes made here

The snapshot is unmodified, so that a sync is a plain diff against the source.
None yet. List every change below, with the reason and the issue it relates to,
so the next sync can tell a local change from the source's.

## Left out of the snapshot, and added to it

This repository's `.gitignore` leaves out three files of the source's 238, none
of which the build uses, so a diff against a fresh snapshot shows them as
missing: `pixel/.vscode/settings.json` (editor settings) and
`pixel/examples/tui-host/app.stderr.log` and
`pixel/examples/tui-host-ts/app.stderr.log` (logs committed by mistake in the
source).

`pixel/packages/pixel/package-lock.json` is not in the source (it uses a pnpm
workspace at the repository root, which is not copied). It is created by
`npm install` in `scripts/build-pixel.ps1` and committed here so the build
installs the same dependencies each time.

## How an install names its pixel

The `PIXEL` file in an install records the version, the source commit above, a
SHA-256 over the contents of `pixel/`, the hash of `pixel.node`, and the
terminal-code commit. The contents hash is made from the blob id git would give
each file under `pixel/` (tracked or not, ignored files left out), listed in
path order, so it is the same before and after the files are committed and on
any checkout; a build does not need a commit first. `scripts/stage-windows.ps1`
(`Get-TodePixelSource`) computes it.

## What is built from it

`scripts/build-pixel.ps1` builds, inside `pixel/`:

- `pixel/packages/pixel/dist` — the TypeScript package (`tsc`)
- `pixel/packages/native/win32-x64/pixel.node` — the engine (`cargo build --release`)
- `pixel/packages/pixel/electron/dist` — the Electron that pixel runs in, fetched by
  pixel's own `postinstall.mjs` (about 370 MB; never committed)

`scripts/stage-windows.ps1` copies those into the install.

## Syncing with the terminal-browser fork

1. Take the new snapshot from a clean commit:
   `git -C <terminal-browser> archive <commit> pixel | tar -xf - -C <empty directory>`
   and compare it with `pixel/` (`git diff --no-index`).
2. Re-apply the local changes listed above, or drop the ones the source now has.
3. Update the table above (commit, date) and the list of changes.
4. Run `scripts/build-pixel.ps1` and the tests, and check the editor opens.
