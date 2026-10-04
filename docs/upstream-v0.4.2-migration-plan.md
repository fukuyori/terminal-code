# upstream v0.4.2 → windows-native 移行計画

作成日: 2026-10-03 / 状態: 計画のみ(コードは未変更)

## 0. 方針(決定事項)

| 項目 | 決定 |
|---|---|
| 取り込み方式 | **案 A: 全面取り込み**(pixel + daemon を採用する) |
| Windows 用 pixel | **`D:\home\source\rust\terminal-browser\pixel`**(fukuyori/terminal-browser、Windows フォーク)を使う |
| 配布 | **同梱**。upstream の配布物も `node_modules/@zenbu-labs/pixel` と Electron を同梱している。Windows 版も同じ位置にフォークのビルド物を入れる |
| 作業の中心 | **tode 側**(`launcher.ts`、起動 `.cmd`、named pipe、競合解消、同梱スクリプト) |
| pixel の不足が見つかった場合は | **`fukuyori/terminal-browser` に issue を出す**。tode 側で pixel を直接改造しない |
| 旧 `D:\home\source\rust\pixel`(v0.0.15 + Windows 7 件) | 履歴参照用。依存先にしない |

pixel の不足が見つかった場合は、`fukuyori/terminal-browser` に issue を出す(§4 Phase 3)。

## 進捗(2026-10-04)

作業ブランチ `merge/upstream-v0.4.2`(`git merge main --no-commit`、未コミット)。

| 項目 | 状態 |
|---|---|
| 競合 24 件の解消 | 完了 |
| `npx tsc --noEmit` | 通過(pixel の `electron.d.ts` は postinstall を走らせていないため `node_modules` に手で補っている) |
| `npm run build` / 全テスト | 通過(140 件) |
| Windows 版 daemon(案 A: 1 ウィンドウ 1 プロセス) | 実装済み(`app/protocol.ts` の named pipe、`daemon.ts`、`control.ts`、`launch.ts`) |
| テーマ選択の保護(`THEME_CHOICE_FILE`)の移植 | 実装済み(`daemon.ts` の `broadcastTheme`、`applyTransparency`) |
| pixel の同梱(`stage-windows.ps1`) | 実装済み。`npm ci --omit=dev --ignore-scripts` の後に `node_modules\@zenbu-labs\pixel` を terminal-browser の Windows ビルドに差し替え、`pixel-native-win32-x64` を追加し、`PIXEL`(出所とハッシュ)を記録。`bin\tode.cmd` は同梱の `pixel.exe` を Node として起動する |
| ビルドスクリプト | `build-windows.ps1` / `release-windows.ps1` / `dist-windows.ps1` に `-TerminalBrowser`(または環境変数 `TODE_TERMINAL_BROWSER`)を追加。`dist-windows.ps1` の terminal-browser 検査と `-VendorBrowser` は削除 |
| 署名(Phase 4.5) | `sign-windows.ps1 -Payload` を追加(payload の exe / dll / node)。`release-windows.ps1 -Sign` が zip の前に署名し、`installer-windows.ps1 -Sign` は未署名の payload があれば失敗する。`tode.iss` の terminal-browser 検査は削除 |
| ステージの検証 | `build-windows.ps1` で `out\windows-release\tode` を作成し、`tode --help` が同梱 `pixel.exe` で動くことを確認。ウィンドウ用プロセスを隔離環境で単体起動し、pipe と pid の作成、`status` の応答、`shutdown` での終了とファイル削除を確認 |
| 実機での起動確認(Phase 3、自動操作による部分) | 完了。隔離環境で WezTerm を別プロセスで起動し、ウィンドウ用プロセスの起動と描画、初回画面(インポート、ショートカット)、VSCodium ワークベンチの読み込み、ブリッジ拡張の登録、`--enable-transparency` / `--disable-transparency`、`--quit`、`--shutdown` を確認(DevTools ポート経由)。**画面の見た目、入力、IME、テーマ色、透過の見た目は未確認(目視が必要)** |
| 判明して直した問題 | (1) `AttachConsole(pid)` は pid がコンソールを持たないと失敗する(`os error 6`)。`pixel.exe` は GUI サブシステムで、Node として動かしてもコンソールが無いため、CLI は同梱の `runtime\node.exe`(コンソール型)で動かす。(2) サーバー停止でプロセスが残る(VSCodium の子プロセス)。Windows の `kill` を `taskkill /T /F` に変更 |
| 既知の制限(対応しない) | IME の変換候補が、ページのキャレットではなく端末カーソルの位置に出る(VSCodium では位置が動く)。terminal-browser の issue #3 に記録し、Ghostty 側で扱うことになった。tode のマージの完了条件には含めない |
| README / CHANGELOG / 版番号 | **未実施** |

## 1. 現状(調査結果)

| 項目 | 内容 |
|---|---|
| upstream | `zenbu-labs/terminal-code` |
| 取り込み済み | v0.3.4(`7a9767b`、merge コミット `987dbb1`) |
| 取り込み対象 | v0.4.2(`6644166`) = ローカル `main` の HEAD |
| 間のコミット | 10 件(v0.4.0 = `557d0af` "Add transparency, migrate to pixel (#35)"、v0.4.1 = `59e4226`、v0.4.2 = `6644166`) |
| upstream 差分 | 41 ファイル、+1691 / −1170 |
| windows-native の独自差分 | `main` 比 58 ファイル、18 コミット(`11d43fa` run on windows natively 以降) |
| git remote | `origin`(fukuyori/terminal-code)のみ。`main` は upstream 追従専用でコミットしない。ローカル `main` は v0.4.2(`6644166`)で、`origin/main`(`0d94818`)より 31 コミット先行(upstream 分が未 push)。取り込みはローカル `main` から行うので **upstream remote の追加は不要** |
| 試験マージ(`git merge-tree`) | **24 ファイルで競合**(内容競合 20、modify/delete 4)(§1.2) |

### 1.1 v0.4.0 の本質: 実行基盤の差し替え

upstream は「terminal-browser(Chromium tarball を取得して起動)」から
**`@zenbu-labs/pixel`(npm 依存の Electron)+ 常駐 daemon** へ移行した。

| 領域 | upstream v0.4.2 | windows-native(現状) |
|---|---|---|
| ブラウザ基盤 | `@zenbu-labs/pixel`(`src/runtime/launcher.ts`) | terminal-browser v0.8.0 を取得(`src/runtime/release.ts`、`platform.ts`) |
| ウィンドウ制御 | `src/app/daemon.ts` / `control.ts` / `protocol.ts`(Unix socket) | `src/browser/mainscript.ts` / `browserglue.ts` |
| 取得/展開 | `src/runtime/fetch.ts`(darwin/linux のみの triple) | `release.ts` + `platform.ts`(win32 対応、bsdtar 指定など) |
| テスト | `control.test.js`, `transparency.test.js` | `browserglue.test.js` ほか |
| 新機能 | 透過(transparency)対応 | — |

upstream が削除したもの: `src/browserglue.ts`, `src/browser/{api.d.ts,ctx.ts→app/messages.ts,mainscript.ts}`,
`src/runtime/release.ts`, `test/browserglue.test.js`。
windows-native はこれらを**変更して使っている**ため、modify/delete 競合になる。

### 1.2 競合ファイル一覧(試験マージ結果)

- modify/delete: `src/browser/mainscript.ts`, `src/browserglue.ts`, `src/runtime/release.ts`, `test/browserglue.test.js`
- 内容競合: `README.md`, `package.json`, `scripts/release.sh`, `src/app/messages.ts`, `src/bridge.ts`,
  `src/bridge/ctx.ts`, `src/bridge/extension.ts`, `src/codeserver/server.ts`, `src/codeserver/vendored.ts`,
  `src/ipc.ts`, `src/launch.ts`, `src/main.ts`, `src/profile.ts`, `src/runtime/paths.ts`,
  `src/shortcuts/wizard.ts`, `src/skill.ts`, `src/ssh.ts`, `src/uninstall.ts`, `src/upgrade.ts`,
  `test/livesync.test.js`
- 自動マージ成功(要レビュー): `scripts/dist.sh`, `src/codeserver/inject.ts` など

### 1.3 upstream の配布の仕組み(`scripts/dist.sh`、`install.sh` で確認)

- 開発時は `package.json` の `@zenbu-labs/pixel@0.0.23` を npm から入れる。
- 配布物の作成時は `npm ci --omit=dev --ignore-scripts` で配布物の中に `node_modules` を作り、
  Electron を `node_modules/@zenbu-labs/pixel/electron/dist/` にコピーする。
- 利用者側の `install.sh` は tarball(pixel と Electron を含む)をダウンロードして展開するだけで、npm は使わない。
- 起動 shim は同梱した `electron/dist/pixel` を `ELECTRON_RUN_AS_NODE=1` で実行する。

## 2. 調査結果: pixel

調査元(2026-10-03、すべて読み取りのみ): `D:\home\source\rust\terminal-browser`(`windows-v0.13.4`、`d1b9edb`。pixel は `pixel/packages/pixel` のソースと `dist`)、
`D:\home\source\rust\pixel`、npm の `@zenbu-labs/pixel` 0.0.20 / 0.0.23(`npm pack` で取得して比較)、GitHub `zenbu-labs/pixel`(一時クローン)。
このリポジトリだけでは確認できない内容なので、実装時に再確認する。

### 2.1 `terminal-browser\pixel`(Windows フォーク、ブランチ `windows-v0.13.4`、版 `0.13.4-win.1`、2026-10-03)

- pixel は同リポジトリ内 `pixel/` にある。`package.json` の版は 0.0.20 だが、**中身は npm 0.0.23 相当**(§2.2)。
- Windows 用の実体がビルド済みで存在する: `packages/native/win32-x64/pixel.node`、`electron/dist/pixel.exe`。
  `postinstall.mjs` に win32-x64 の経路があり、標準 Electron を `pixel.exe` に改名する。`bin.ts` にも `pixel.exe` の分岐がある。
- Windows 機能: ConPTY 入力/リサイズ、Windows named pipe による daemon / session IPC、`attachWindowsConsole(pid)`、SSH proxy。
- 配布は Inno Setup インストーラー/ZIP。payload は Electron・Node.js・`pixel.node`・`agent-browser` を同梱する。

### 2.2 npm 0.0.20 と 0.0.23 の比較(2026-10-03、ライセンスは MIT、Electron は両方 44.2.0)

- 0.0.21 以降は pixel 単体の GitHub ではなく、**terminal-browser リポジトリの `pixel/` から公開**されている(0.0.23 の repository 欄)。
  pixel 単体の GitHub は v0.0.20 で止まっている。
- 実質的な差は 3 点のみ(他はエラー文言の `[placeholder copy: ...]` 除去):
  1. `webview.js`: `browserWindowOptions.transparent` のとき背景色を塗らない(tode の透過が依存)。
  2. `cursor.js`: `col-resize` / `row-resize` を `ew-resize` / `ns-resize` に変換。
  3. `postinstall.mjs`: パッチ済み Electron の取得先に terminal-browser の Releases を追加。
- **この 3 点は `terminal-browser\pixel` のソースと `dist` に入っている**(`webview.js`・`cursor.js` は npm 0.0.23 と一致)。
  `dist` の差は Windows 対応部分のみ(追加: `host/frame.js`、`terminal/windows-console.js`。
  変更: `bin.js`、`bootstrap.js`、`host/guest.js`、`host/server.js`、`instances.js`、`root.js`、`ssh/index.js`、`terminal/*`、`web/input.js`)。
  `root.js` の差が `[placeholder copy]` の文言か Windows 向けの変更かは未区別。
- npm の 0.0.23 は optionalDependencies に **win32 のネイティブパッケージが無い**(darwin / linux のみ)。
  → npm の `@zenbu-labs/pixel` をそのまま入れても Windows では動かない。**フォークのビルド物を使う理由はこれ**。

### 2.3 旧 `rust\pixel`(参考)

- ブランチ `windows-v0.11.1`(`5bb53b9`)は upstream pixel v0.0.15 に Windows 用コミット 7 件(43 ファイル)を載せたもの。
- `terminal-browser\pixel` はその後継。依存先にはしない。

### 2.4 未検証事項(「不足」ではなく、tode から実行して確認していない点)

1. `@zenbu-labs/pixel/electron` の `app` / `ipcMain` が Windows の `pixel.exe` 上で `daemon.ts` の使い方どおり動くか。
2. `WebView` / `createRoot` が Windows の ConPTY 上で tode の使い方どおり動くか。
3. tode の daemon に `attachWindowsConsole`(コンソール接続)が必要か。
4. `root.js` の差(上記)の内容。

これらは Phase 3 の実機検証で確認する。**pixel の不足が見つかった場合は `fukuyori/terminal-browser` に issue を出す**(§4 Phase 3)。

## 3. 作業上のリスク

1. **daemon の IPC**: `daemonSocket()` は `*.sock`(Unix domain socket)。Windows の Node `net` は
   named pipe 形式(`\\.\pipe\...`)を要求するため、パス生成の置き換えが要る可能性がある。※推測です。
   フォークの terminal-browser に named pipe の実装があるので参考にできる。
2. **windows-native 独自資産との重複**: ConPTY / wezterm backend / OSC / SSH など upstream に無い機能は
   `src/launch.ts`・`src/main.ts` に絡んでおり、daemon 化と同じ箇所を触る。
3. **`launcher.ts`**: `electronBinary()` は `dist/pixel` 固定。Windows では `pixel.exe`。
4. **ライセンス**: pixel は MIT。Electron の同梱・再配布条件は配布前に確認する。

## 4. 作業手順

作業は専用ブランチで行い、windows-native へは検証後にまとめて入れる。

### Phase 0: 準備(コード変更なし)
- [ ] `main` は upstream の追従専用で、**ここにはコミットしない**。`main` の作業ツリーにある `.gitignore` の変更(`out/` の追加のみ)は、
      windows-native に同じ行が既にあるため不要。`main` では扱わず、作業は windows-native から切るブランチで行う。
- [ ] 未追跡の `docs/`(この計画書)は windows-native 側でコミットする(時期は利用者の指示による)。
- [ ] 同梱方式(決定): tode のビルドでは pixel をビルドせず、terminal-browser のビルド済みの `pixel/` を環境変数でパス指定して取り込む。
      取り込む物は `pixel` の `dist`、`package.json`、`packages/native/win32-x64`(`pixel.node`)、`electron/dist`(`pixel.exe`)。
      配置先は `node_modules/@zenbu-labs/pixel`(upstream と同じ位置)。`terminal-browser\scripts\build-windows.ps1` の同梱処理を参考にする。
- [ ] 取り込み時に、出所の terminal-browser のコミットと pixel の版を配布物内のファイルに記録し、
      `dist` と `pixel.node` が同じビルドであることを検査する(不一致なら失敗させる)。
- [ ] 別ターミナルで検証する(共有 server / browser daemon を作業中セッションで試さない)。

### Phase 1: 作業ブランチ作成と merge
- [ ] `git switch windows-native && git switch -c merge/upstream-v0.4.2`
- [ ] `git merge main`(main = v0.4.2、前回 `987dbb1` と同じ流儀)。
- [ ] 競合ファイルを次の方針で解消する。

| 群 | ファイル | 方針 |
|---|---|---|
| 基盤 | `runtime/release.ts`(削除), `browserglue.ts`(削除), `browser/mainscript.ts`(削除), `runtime/paths.ts` | upstream の削除を受け入れる。Windows 固有部(win32 triple、`platform.ts` の tar/copy 処理)は `launcher.ts` / `fetch.ts` 側へ移植。`platform.ts` は必要なものだけ残す |
| daemon | `app/*`, `ipc.ts`, `bridge*`, `main.ts`, `launch.ts` | upstream 構成を土台にし、windows-native の ConPTY/起動処理を載せ直す。socket パスは Windows 用に分岐(named pipe) |
| テーマ/透過 | `profile.ts`, `codeserver/*`, `theme/generate.ts` | 両方の変更を併合。透過は Windows での挙動を実機確認 |
| CLI | `ssh.ts`, `skill.ts`, `uninstall.ts`, `upgrade.ts`, `shortcuts/wizard.ts` | upstream の変更を取り込み、Windows 分岐(wezterm backend、`-win` 版数、アンインストーラー)を維持 |
| 配布 | `package.json`, `package-lock.json`, `scripts/*`, `.github/workflows/release.yml` | `package-lock.json` は手で解消せず、`package.json` 確定後に再生成。Windows 用 `*.ps1` とインストーラー定義は維持。pixel はフォークのビルド物を同梱する処理を追加 |
| 文書 | `README.md`, `README.ja.md`, `CHANGELOG*.md` | upstream の追記(+2 行)を反映し、日英両方を更新 |

### Phase 2: 動作できる状態にする
- [ ] **Windows 用 daemon の設計(判断待ち)**: pixel は 1 プロセスにつき 1 コンソールにしか接続できない(`attachWindowsConsole`)。
      upstream の daemon は 1 プロセスで複数ウィンドウを持つため、Windows ではそのままでは成立しない。
      案 A: ウィンドウごとにプロセスを起動する(tode 側のみ、推奨)/ 案 B: pixel 側で複数コンソール対応(terminal-browser に issue)。
- [ ] `src/app/protocol.ts` / `daemon.ts` / `launch.ts`: daemon の接続先を named pipe にする(`.sock` は Windows で listen できない)。
- [ ] `src/app/control.ts`: `ps -axo` と `SIGTERM`/`SIGKILL` に依存している。Windows ではプロセス一覧(コマンドライン付き)の取得と
      停止方法を置き換える。取得に失敗したときに PID ファイルだけ消してプロセスを残さないこと(upgrade / uninstall が使う)。
- [ ] `src/app/daemon.ts`: 旧 `browser/mainscript.ts` にあった `THEME_CHOICE_FILE` の保護を移植する。
      `--theme <file>` を選んでいる間は、端末色の通知(`broadcastTheme`)と透過切り替え(`applyTransparency` の `installTheme`)が
      選択を上書きしないこと。あわせて端末色通知の宛先は `.sock` 固定をやめ、`listEndpoints` と
      `ECONNREFUSED`/`ENOENT`/`EPIPE` での掃除にする。
- [ ] 旧 `test/browserglue.test.js` が検証していた内容(端末色の通知がテーマになって各ウィンドウに届くこと)を、
      新構成のテストとして書き直す。
- [ ] `launcher.ts` の Windows 対応(`pixel.exe`)と、起動 `.cmd` の作成。upstream の shim(`dist.sh`)は
      `ELECTRON_RUN_AS_NODE=1` を設定して `pixel` で `dist/main.js` を実行する。Windows の `.cmd` でも同等の設定と、
      実際の起動経路(`pixel.exe` を Node として起動できること)を実機で確認する。
- [ ] `npm install` → `npm run typecheck` → `npm test`(ConPTY 関連のテストを実行する場合は PowerShell から)。
- [ ] 削除された `browserglue.test.js` に相当する検証を、新構成(`control.test.js` 等)側で補う。
- [ ] 失敗の原因が推測で解決しない場合は、ログを取得して特定する。

### Phase 3: Windows 実機検証(別ターミナル)
- [ ] 起動 / 終了(Ctrl+Shift+Q を含む)、テーマ適用、透過、SSH、ショートカットウィザード(wezterm)、upgrade、uninstall。
- [ ] §2.4 の未検証事項 1〜4 を確認する。
- [ ] 常駐 daemon の多重起動・残留(upstream `cd12382` "more reliably cleanup daemons" 相当)が Windows でも起きないこと。
- [ ] **pixel の不足が見つかった場合**: `fukuyori/terminal-browser` に issue を出す。
      issue には、再現手順、期待する動作と実際の動作、使用した pixel のコミット(`terminal-browser` の `windows-v0.13.4` 等)、
      ログを含める。tode 側では pixel を直接改造せず、issue の修正が入った版を取り込み直す。

### Phase 4: バージョン更新と文書
- [ ] Windows 版の版番号の付け方を決める(例: `0.4.2-win.1`。前回は `v0.3.4-win.1`)。
- [ ] `docs/version-update-checklist.md` に従い Windows 版数(`stage-windows.ps1` の `$TodeWindowsVersion` 等)、
      README/CHANGELOG(日英)を更新。
- [ ] 同梱する pixel の出所(terminal-browser のコミット / 版)を記録し、チェックリストの対象面
      (`src/app/*`, `src/runtime/launcher.ts` など)に追記する。

### Phase 4.5: 署名対象の見直し
- [ ] 現在の `scripts/sign-windows.ps1` は「payload にネイティブバイナリはない」前提で、署名対象はインストーラー(とアンインストーラー)のみ。
      pixel 同梱後は payload に `pixel.exe` と `pixel.node` が入るため、`-Sign` の対象に含めるかを決め、スクリプトを更新する。
      署名は環境変数 `CODESIGN_CERT` を使う。配布物の作成と署名は利用者が行う。

### Phase 5: 反映
- [ ] 差分レビュー後、利用者が `merge/upstream-v0.4.2` を windows-native へ取り込む(コミット/プッシュは利用者の指示で実施)。
- [ ] 配布物(ZIP・インストーラー)は利用者が `-Sign` 付きで作成する。Claude は作成しない。

## 5. ロールバック

- 作業は別ブランチのため、問題があればブランチを破棄すれば windows-native は無傷。
- 反映後に問題が出た場合は、merge コミットを revert、または既存タグ `v0.3.4-win.1` を基点に戻す。

## 6. 未確定事項

- この文書をコミットする時期(windows-native の作業ツリーにある未追跡ファイル。コミットは利用者の指示で行う)。

## 7. 決定済みの事項

- 案 A(全面取り込み)。pixel は同梱し、同梱方式は「ビルド済みの `terminal-browser\pixel` を取り込む」。
- `main` は upstream 追従専用でコミットしない。この文書は windows-native 側に置く。
- pixel の不足が見つかった場合は、`fukuyori/terminal-browser` に issue を出す。
