# Version update checklist

Use this checklist when advancing the Windows fork to a new upstream release.
The Windows version combines the upstream version and the Windows fork
revision, for example `0.4.2-win.1`.

## Upstream integration

- [ ] Fetch the exact upstream release tag without moving or overwriting the
      Windows branch.
- [ ] Verify the fetched tag's commit and merge base.
- [ ] Review every upstream commit and changed file since the current merge
      base.
- [ ] Merge the upstream release without creating a commit automatically.
- [ ] Resolve conflicts while preserving both the upstream behavior and the
      Windows-native implementation.
- [ ] Verify the source and an actual Windows build of every newly pinned
      runtime dependency, including all CLI features used by the new release.
- [ ] Before publishing, verify that the matching Windows runtime installer is
      available to users or deliberately included in the release.
- [ ] Actions: this fork's workflows only build and test, and nothing is
      released from CI (`windows.yml` runs on `windows-native`, `posix-build.yml`
      by hand, both with read-only permissions). Upstream's `release.yml`, which
      deploys to Cloudflare, publishes to R2 and creates GitHub releases, is
      deleted here: the merge reports it as a modify/delete conflict, so keep it
      deleted and copy any change to its build steps into `posix-build.yml` by
      hand. Releases are made by the maintainer with `build-release.ps1 -Sign`,
      `build-installer.ps1 -Sign` and `publish-windows.ps1`.
- [ ] Sync pixel. Compare the `@zenbu-labs/pixel` version in the merged
      `package.json` with the copy in `pixel/` (`docs/pixel-origin.md` records
      its source commit and version label). If upstream moved to a newer
      pixel:
      1. bring the terminal-browser Windows fork up to that pixel first (merge
         upstream terminal-browser there, keeping its Windows support, and
         build it);
      2. take a snapshot of the fork's `pixel/` from a clean commit and
         replace `pixel/` with it, re-applying any local change listed in
         `docs/pixel-origin.md` (the procedure is in that file);
      3. update the source commit, date and list of local changes there;
      4. run `scripts\build-pixel.ps1`, then the tests, and open the editor.
      If pixel did not change, say so in the CHANGELOG. An issue found in
      pixel while testing is reproduced and fixed in `pixel/` first, then
      reported to the fork so the two do not drift apart.


For the 0.4.2 integration, review these upstream code surfaces:

- `src/app/protocol.ts`, `src/app/daemon.ts`, `src/app/control.ts` (the window
  process: Windows runs one per window, over a named pipe)
- `src/launch.ts`, `src/runtime/launcher.ts`, `src/runtime/fetch.ts`
- `src/profile.ts` (theme and transparency), `src/bridge.ts`, `src/bridge/extension.ts`
- `src/ssh.ts`, `src/uninstall.ts`, `src/upgrade.ts`
- `package.json` (the `@zenbu-labs/pixel` version), `scripts/dist.sh` (how the
  install is vendored, mirrored by `scripts/stage-windows.ps1`)

For the 0.3.4 integration, review these upstream code surfaces:

- `src/ssh.ts`
- `src/main.ts`
- `src/launch.ts`
- `src/runtime/release.ts`
- `src/browserglue.ts`
- `web/app/components/usage.tsx`
- `README.md`

## Windows version surfaces

- [ ] `scripts/stage-windows.ps1`: update `$TodeWindowsVersion`.
- [ ] `scripts/build-release.ps1` and `scripts/build-installer.ps1`: verify the
      staged version, ZIP and manifest names, and numeric Inno Setup version.
- [ ] `README.md` and `README.ja.md`: update the Windows version example,
      upstream base, and new-feature documentation in both languages.
- [ ] `CHANGELOG.md` and `CHANGELOG.ja.md`: add the Windows release entry,
      including imported upstream features, native adaptations, requirements,
      and limitations in both languages.
- [ ] `scripts/build-installer.ps1`: update the four-part Windows file
      version example.
- [ ] pixel: the Windows build is made from the copy kept in `pixel/` (see
      `docs/pixel-origin.md`; there is no pin in the source any more). If the
      terminal-browser fork's pixel has changed, sync the copy as described there
      first. Then run `scripts\build-pixel.ps1`, check the `PIXEL` file the stage
      writes (pixel version, terminal-browser commit, hash of `pixel/`'s contents,
      `pixel.node` hash, terminal-code commit), and that `package.json`'s `@zenbu-labs/pixel` version is
      the one upstream asks for. Record any difference between the two in the
      CHANGELOG.
- [ ] Publishing: `publish-windows.ps1` only publishes what `build-release.ps1`
      and `build-installer.ps1` made, checked against `release.json` in
      `out\windows-release` (version, ZIP hash, installer hash, signed). If the
      record or a file is missing or differs, rebuild with the two scripts.
- [ ] Signing: `build-release.ps1 -Sign` signs the payload's binaries before
      the ZIP, and `build-installer.ps1 -Sign` refuses unsigned ones. Both are
      run by the maintainer, never in CI or by the assistant.

The root `package.json` and `package-lock.json` versions are private npm
package metadata, not the Windows release version. `VERSION`, release
manifests, archive names, and installer names are generated by the release
scripts and must not be committed.

## Verification

- [ ] Search for stale references to the previous Windows version.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm test`.
- [ ] Verify the staged version value without creating release packages.
- [ ] Review the final diff and working tree for unrelated changes.
- [ ] Validate Windows-specific behavior affected by upstream conflicts.

Do not create packages, commits, tags, or pushes unless the current request
explicitly asks for them.
