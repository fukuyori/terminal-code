# 変更履歴

[English](CHANGELOG.md)

このファイルには、terminal-code Windowsネイティブforkの主な変更を記録します。
`-win.N` より前の番号はベースとなるupstream terminal-codeのリリースを示し、
末尾はそのリリースをベースにしたWindows forkのリビジョンを示します。

## 0.4.2-win.1（未リリース）

このリリースでは、upstream terminal-code `v0.4.2` のソース全体（コミット
`6644166`）をWindowsネイティブブランチへ統合しました。upstreamの `v0.4.0` は
terminal-browserのランタイムを[pixel](https://github.com/zenbu-labs/pixel)と
ウィンドウ用プロセスに置き換えました。Windowsブランチと競合した24ファイルは、
この設計に合わせて解消しています。

### 変更

#### 別途インストールしたterminal-browserに代わりpixelを使用

- todeは、terminal-browserのインストールを探したり、ダウンロードしたり、実行したり
  しなくなりました。ウィンドウは、pixelのパッチ済みElectron（`pixel.exe`）と
  Windows用エンジン（`pixel.node`）、およびそれらを動かすJavaScriptで描画されます。
  いずれもterminal-browser forkのWindows版ビルドから取り込みます。
- インストールには `node_modules\@zenbu-labs\pixel`、`pixel-native-win32-x64`、
  `runtime\` 配下のコンソール型 `node.exe` が含まれます。`bin\tode.cmd` は、この
  `node.exe` で `tode` コマンドを実行します。コンソールを持たないプロセスは
  コンソールへの接続に失敗し、`pixel.exe` はNodeとして動かしてもGUIプログラム
  だからです。
- 使用するpixelはforkのビルドで、版表記は `0.0.20` です。npmの `0.0.23` が
  `0.0.20` に対して持つ3つのコード変更（透過時のページ背景、リサイズ用カーソル名、
  Electronのダウンロード先）は含まれていますが、全体の比較は行っていません。
- インストール内の `PIXEL` ファイルに、取り込み元のterminal-browserのコミット、
  pixelの版、`pixel.node` のハッシュを記録します。ビルド時に、インストールへ
  コピーしたエンジンが元のものと一致することを検査します。
- ビルドスクリプトは、terminal-browserのチェックアウトを `-TerminalBrowser`
  または `TODE_TERMINAL_BROWSER` で受け取ります。`dist-windows.ps1` は
  terminal-browserの検査と同梱を行わなくなり、インストーラーもそれを要求しません。
- `src/runtime/release.ts`、`src/browserglue.ts`、`src/browser/mainscript.ts` と
  それらのテストを削除しました。`src/runtime/fetch.ts` は、エディターサーバーの
  ダウンロードが使うWindowsのターゲット識別子とアーカイブ展開を保持します。

#### ウィンドウごとに1つのウィンドウ用プロセス

- pixelのプロセスは生存中1つのコンソールに接続し続けるため、Windowsでは、
  1つのプロセスが全ウィンドウを担当する代わりに、ウィンドウごとに専用の名前付き
  パイプを持つプロセスを起動します。プロセスはウィンドウが閉じた直後に終了します。
- `tode --shutdown`、`--upgrade`、`--uninstall` は、これらのプロセスをコマンドライン
  から見つけ、エディターサーバーの子プロセスとあわせて停止します（`taskkill /T`）。
  プロセスが残りません。
- ブリッジ拡張は、透過設定の変更をすべてのウィンドウ用プロセスへ伝えます。

#### テーマの選択を維持

- `tode --theme <file>` で選んだテーマファイルが、後から届くターミナルの配色で
  上書きされなくなりました。削除したブラウザー用スクリプトが行っていた確認を、
  ウィンドウ用プロセスが行います。
- `tode --theme` と現在のテーマは、透過設定に従います。

### 追加

- upstreamの `tode --enable-transparency` と `tode --disable-transparency`。
  名前で選んだカラーテーマは自身の背景を描くため、エディター面が透過するのは
  todeの標準テーマのときだけです。
- upstreamのその他の `v0.4.x` の変更：ウィンドウ用プロセスとそのプロトコル、
  pixelのSSH対応を使ったSSHセッション。

### 署名

- `scripts\sign-windows.ps1 -Payload` は、ステージしたインストール内のバイナリ
  （`pixel.exe`、そのdll、`pixel.node`）に署名します。`release-windows.ps1 -Sign` は
  ZIPを作る前に署名し、`installer-windows.ps1 -Sign` は未署名のものが残っていれば
  停止します。

### 既知の制限

- IMEの変換候補ボックスはターミナルのカーソルに従いますが、pixelはそれを最後に
  描画した位置に残すため、キャレットから離れた位置に出ることがあります
  （[terminal-browser#3](https://github.com/fukuyori/terminal-browser/issues/3)）。
- WezTermが `Ctrl+Q` と `Ctrl+Shift+Q` を取ることがあります。回避方法は
  `tode --quit` と `tode --shortcut-setup` です。
- `tode --ssh` はpixelのSSH対応を使う実装になり、Windows上では再確認していません。
- `0.3.4-win.1` から `tode --upgrade` で更新する手順は確認していません。既存の
  terminal-browserのインストールは、単に使用されなくなります。

## 0.3.4-win.1（未リリース）

このリリースでは、upstream terminal-code `v0.3.4` のソース全体（コミット
`1c382930d3bb34297eef7bd83ea9b56dbba2fd16`）をWindowsネイティブブランチへ
統合しました。以前のバージョン表記だけの更新とは異なり、upstreamの各コミットと
ソース変更を実際にマージしています。競合箇所は既存のWindows用プロセス、パス、
エディターサーバー、IPCの抽象化を維持する形で適応しました。

### 追加

#### Windows終了ショートカットの追加

- Windowsの既定の終了キーとして `Ctrl+Shift+Q` を追加しました。従来の
  `Ctrl+Q` も維持しつつ、WezTermのleaderに `Ctrl+Q` を奪われる環境でも、
  ターミナル設定を変更せず終了できます。
- ショートカットウィザード、生成されるbridge拡張機能、ユーザーレベルの
  キーバインド、終了案内が2つの既定キーを一貫して扱うようにしました。
  `Ctrl+Q` を既存の `Ctrl+Shift+Q` へ移動しても重複登録されません。
- `TODE_QUIT_CHORD` を指定した場合は、従来どおり既定値を指定した1つのキーで
  置き換えるため、既存のカスタマイズ済み環境の動作は変わりません。

#### SSH経由のリモート編集

- `tode --ssh <target> [path]` を追加しました。ブラウザーとVS Codeフロントエンドは
  ローカルWindows上に残し、エディターバックエンドだけをリモートUnixホスト上で
  実行します。通常の対話型SSHターミナルと異なり、描画される全フレームとローカルの
  全入力イベントをネットワーク経由で転送する必要がありません。
- `user@host`、`host`、`user@host:port`、OpenSSHのHostエイリアス、引用符付きSSH
  引数を解析できるようにしました。秘密鍵、ジャンプホスト、ポート、設定ファイル
  など、後続の値を必要とするオプションはSSHプロセスの構築時に値と一緒に保持されます。
- terminal-browser用SSHバンドルを追加しました。バンドル内のスクリプトがリモート
  ホスト上のterminal-codeを導入または更新し、リモートプロファイルを準備して
  バックエンドを起動し、そのURLをterminal-browserのSSHプロキシへ返します。
- リモートインストール用にWindows版番号の変換を追加しました。ローカル版が
  `0.3.4-win.1` の場合、upstreamインストーラーサービスに存在しないWindows fork版を
  探すのではなく、Unixホストでは対応するupstream `v0.3.4` を要求します。
- `--install-extension`、`--uninstall-extension`、`--list-extensions`、
  `--shutdown`、`--upgrade` の直接転送を追加しました。これらの管理コマンドは
  システムの `ssh` クライアント経由で実行し、terminal-browserを起動しません。
- SSH接続先の未指定、未対応オプション、複数ワークスペースパス、不正な接続先、
  リモート側にtodeが存在しない場合を明確に検証して報告するようにしました。

#### リモートプロファイルの取り込み

- SSHバンドルに、ローカルのターミナルパレットと利用可能なプロファイルファイルを
  含めます。対象は設定、キーバインド、タスク、スニペット、拡張機能一覧です。
- リモートバンドルが使用する内部コマンド `--serve` を追加しました。`--prepare` は
  サーバーを起動したままにせずプロファイルの取り込みとアセット準備を行います。
  通常のserveモードはエディターバックエンドを起動し、terminal-browserが使用する
  `READY` URLを出力します。
- リモートプロファイル準備には既存のインポート実装を再利用し、別の設定マージ処理を
  重複して持たないようにしました。

#### 拡張機能の一括インストール

- リモートホストへ転送した拡張機能一覧を一括処理する機能を追加しました。
  インストール済みIDとの比較では大文字小文字を区別せず、既存の拡張機能は
  再インストールしません。
- 不足している拡張機能を1回のエディターサーバー呼び出しへまとめます。明示的な
  バージョン接尾辞は維持し、その後terminal-codeテーマ拡張機能を更新します。
  一部に失敗した場合は標準エラーへ報告します。

#### terminal-browserへのアプリケーション登録

- インストール済みtodeでワークスペースを開くと、terminal-browserへ
  `terminal-code` アプリケーションとして登録するようにしました。
- ブラウザー起動時に `--app-name=terminal-code` と
  `--app-id=terminal-code` を渡し、すべてのterminal-codeペインへ安定した
  アプリケーション識別情報を与えます。
- プラットフォーム対応terminal-browserコマンドと実際のWindows `tode.cmd` shimを
  使用して登録します。登録処理はエディター起動から切り離され、登録に失敗しても
  ワークスペースの起動を妨げません。
- Webの使用方法ページにもSSHリモート操作を追加しました。

### Windows統合

#### terminal-browser 0.8.0-win.1

- Windowsランタイムの基準バージョンを `v0.8.0` に更新し、`0.8.0-win.1` のような
  forkリビジョンを互換版として受け入れるようにしました。検証済みWindowsビルドは、
  upstream terminal-code `v0.3.4` が使用する `--ssh`、`--ssh-bundle`、
  `--ssh-bundle-dir`、`--app-name`、`--app-id`、`register-app` の全コマンドと
  オプションを実装しています。
- Windowsでは、引き続き `%LOCALAPPDATA%\Programs\terminal-browser` に個別
  インストールされたブラウザー、または `TODE_TERMINAL_BROWSER_BIN` で指定した
  ビルドを参照します。terminal-codeは同梱Node.jsランタイムとブラウザー固有の
  環境変数を組み合わせて実行コマンドを構築します。
- macOSとLinuxではupstreamのterminal-browser `v0.7.3` を維持します。Unix用
  リリーススクリプトも、プラットフォーム別指定からUnix側のバージョンを正しく
  読み取れるように更新しました。

#### Windowsネイティブ環境への適応

- SSH起動、ブラウザー起動、シャットダウン、アプリケーション登録で、直接実行可能な
  Unixランチャーを前提にせず、既存のコマンド抽象化を使用するようにしました。
- ブラウザープロセスへWindows版terminal-browserの実行に必要な環境を渡し、
  必要な補助プロセスはコンソールウィンドウを表示せず起動します。
- 取り込んだupstreamテストで使う状態パスを、`/tmp` とUnixソケット前提から、
  Windowsの一時ディレクトリと名前付きパイプに対応した状態ディレクトリへ変更しました。

### バージョンと文書

- Windowsリリース版を `0.1.0-win.2` から `0.3.4-win.1` へ更新しました。
- Windowsインストーラー用の4要素ファイルバージョン例を `0.3.4.1` へ更新しました。
- `scripts/build-windows.ps1` を追加しました。ソースをコンパイルし、インストール済み
  環境を変更せず、検証済みリリースpayloadを作成します。
- `scripts/package-windows.ps1` を追加しました。作成済みpayloadを読み取り、
  アップグレード用ZIP、`latest.json`、`manifest.json`、Inno Setupインストーラーを
  作成します。terminal-codeにはネイティブの `tode.exe` がなく、ランチャーは
  `bin/tode.cmd` なので、新しいスクリプトには意図的に `-Sign` を設けていません。
- `docs/version-update-checklist.md` を追加しました。正確なupstreamタグの取得、
  コミットと変更ファイルの確認、競合解消、プラットフォーム別ランタイムの検証、
  バージョン表記箇所、テスト、リリース操作の境界を記載しています。
- READMEにWindows SSHの構成、コマンド例、プロファイルと拡張機能の動作、
  アプリケーション登録、ランタイム要件、現在の制約を詳しく追加しました。
- READMEと変更履歴の日本語版を追加しました。

### 必要条件と制約

- ローカルWindowsでの動作には terminal-browser `0.8.0-win.1` または互換性のある
  `0.8.0-win.*` リビジョンと、kitty graphics protocol対応ターミナルが必要です。
  現在のWindows検証対象はWezTermです。
- SSHモードでは、さらにWindows OpenSSH Clientと `PATH` 上の `tar.exe` が必要です。
  terminal-browserがバンドルのインストールと起動中に複数の接続を作成する場合が
  あるため、鍵認証または `ssh-agent` を推奨します。
- リモートバンドルの対象はUnixホストです。バンドル内スクリプトは `/bin/sh`、
  Unixパス、実行可能モードビット、upstreamのシェルインストーラーを使用します。
- このソース統合作業では、署名済みインストーラー、アーカイブ、タグ、コミット、
  公開リリースを作成していません。

### 実施した検証

- 取得したupstream `v0.3.4` タグとマージヘッドが、どちらも
  `1c382930d3bb34297eef7bd83ea9b56dbba2fd16` を指していることを確認しました。
- ローカルWindows版terminal-browserが `terminal-browser 0.8.0-win.1` を返し、
  terminal-codeが使用するSSHおよびアプリケーション関連の全CLIオプションを
  公開していることを確認しました。
- terminal-codeのWindowsランタイム解決処理を通じてそのブラウザービルドを起動し、
  バージョンが正常に表示されることを確認しました。
- 新しいビルド／パッケージスクリプトを分離した検証用出力ディレクトリで実行しました。
  Inno Setup 6.7.3が `0.3.4.1` インストーラーを作成し、ZIPに全89エントリが含まれ、
  SHA-256が生成されたmanifestと一致することを確認しました。想定どおり署名状態は
  `NotSigned` でした。
- 自動テスト140件すべてとTypeScriptの全型チェックに成功しました。
- ステージ済み差分検査、シェル／PowerShellスクリプト構文検査に成功し、
  未解決マージエントリと未ステージ変更がないことを確認しました。
- 接続先ホストが指定されていないため、実際のSSHホストへのエンドツーエンド接続は
  まだ実施していません。
