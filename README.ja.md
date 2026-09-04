# terminal-code

[English](README.md)

ターミナル内で動く VS Code。この fork では WSL を使わず、Windows 上でもネイティブに動作します。

https://github.com/user-attachments/assets/4ba0d434-896a-4ab3-9c91-5d351dacee08

このリポジトリは [zenbu-labs/terminal-code](https://github.com/zenbu-labs/terminal-code)
の fork で、Windows x64 ネイティブ版を追加しています。[WezTerm](https://wezterm.org)
上の PowerShell 7 と、エディターをペイン内に描画する
[terminal-browser Windows版](https://github.com/fukuyori/terminal-browser)を組み合わせて
検証しています。Windows対応は実験的です。構成と現在の制約は
[Windows](#windows)を参照してください。

### Windowsへのインストール

1. [terminal-browser for Windows](https://github.com/fukuyori/terminal-browser/releases)
   `0.8.0-win.1`、または互換性のある別の `0.8.0-win.*` リビジョンを
   `terminal-browser-<version>-windows-x64.exe` でインストールします。あわせて
   [kitty graphics protocol](https://sw.kovidgoyal.net/kitty/graphics-protocol/)
   対応ターミナルが必要です。現在の検証対象は WezTerm です。
2. [terminal-codeのリリースページ](https://github.com/fukuyori/terminal-code/releases)
   から `tode-<version>-windows-x64.exe` を実行します。署名済みインストーラーは
   管理者権限を使わず `%LOCALAPPDATA%\Programs\tode` にユーザー単位で
   インストールし、`tode` をユーザーの `PATH` に追加できます。
3. 新しいターミナルを開き、`tode` を実行します。

初回起動時には、code-serverがラップしているものと同じOSS版VS Codeサーバーである
VSCodiumの `reh-web`（`win32-x64`版）を
`%LOCALAPPDATA%\tode\data\vscodium-server` に取得します。拡張機能は Open VSX
からインストールされます。

以降の更新はtode自身から取得できます。

```powershell
tode --upgrade --check   # 新しいビルドがあるか確認
tode --upgrade           # 更新を適用
```

### 基本的な使い方

```powershell
tode                     # 現在のフォルダーを開く
tode <folder>            # 指定フォルダーを開く
tode <file>              # ファイルを開く。既存ウィンドウがあれば再利用する
tode -g <file:line:col>  # 指定位置を開く
tode --review            # ソース管理パネルを開く
```

todeウィンドウ内では、`tode <file>` が名前付きパイプ経由で同じウィンドウに届きます。
そのため、統合ターミナル内のシェルからも `code` コマンドと同様に利用できます。

**終了。** Windowsでは `Ctrl+Q` と `Ctrl+Shift+Q` のどちらでも終了します。
WezTermの `config.leader` などが `Ctrl+Q` を使用していても、`Ctrl+Shift+Q` を
代わりに使用できます。それ以外の衝突は `tode --shortcut-setup` を実行してください。
ウィザードがエディターに必要なキーとの衝突を検出し、WezTermを含むターミナル側の
割り当てを解放または移動します。終了キーを直接指定することもできます。

```powershell
$env:TODE_QUIT_CHORD = "ctrl+alt+q"
tode
```

`tode --quit` は任意のシェルから開いているウィンドウを閉じます。
ブラウザーが強制終了されてペインが復元されなかった場合は
`tode --reset-terminal` を実行します。

**配色。** 既定ではエディターがターミナルのパレットに追従します。別のテーマを
使用する場合は次のように指定します。

```powershell
tode --theme "Monokai"      # インストール済みテーマを名前で選択
tode --theme mytheme.json   # VS Codeテーマファイルを指定
tode --theme                # ターミナルの配色に戻す
```

選択内容は次回以降も維持されます。エディター内で選んだテーマも同様に保存されます。

**設定と拡張機能。** `tode --import` は、このコンピューターにあるVS Code互換
エディターから設定、キーバインド、スニペット、拡張機能を取り込みます。
`tode --install-extension <id>` は Open VSX から拡張機能をインストールします。
全コマンドは[コマンド一覧](#コマンド一覧)を参照してください。

### 0.3.4-win.1でWindowsに追加された機能

このリリースでは、upstream `v0.3.4` のソース全体をWindowsブランチへ
マージしています。Windows固有の統合内容を以下に示します。リリース変更の全記録は
[CHANGELOG.ja.md](CHANGELOG.ja.md)を参照してください。

#### SSH経由のリモートワークスペース

terminal-browserと描画済みVS Code UIをローカルWindows上に残し、エディターサーバー
だけをリモートUnixホスト上で動かせるようになりました。

```powershell
tode --ssh dev@build-box
tode --ssh build-box ~/src/project
tode --ssh "dev@build-box -p 2222" ~/src/project
```

1つ目はリモートのホームディレクトリ、2つ目は指定したリモートパスを開きます。
3つ目のように、SSHオプション全体を1つの引用符付き引数として指定できます。
OpenSSH設定のHostエイリアスと `user@host:port` 形式にも対応しています。

ローカル側は、ターミナルパレット、設定、キーバインド、スニペット、タスク、
拡張機能一覧を含む小さな配布バンドルを作成します。terminal-browser
`0.8.0-win.1` がそのバンドルをリモートへコピーし、upstream terminal-code
`v0.3.4` の導入確認、プロファイル準備、リモート `--serve` バックエンドの起動、
ネットワーク通信のローカルブラウザーへのプロキシを行います。Chromium、描画、
キーボード処理、ターミナルグラフィックスプロトコルはWindows側に残るため、
通常の対話型SSHのように画面全体をネットワーク転送する必要がありません。

ブラウザーを必要としない管理コマンドは、システムの `ssh` コマンドへ直接
転送されます。対象は拡張機能のインストール、削除、一覧表示、シャットダウン、
アップグレードです。

```powershell
tode --ssh build-box --list-extensions
tode --ssh build-box --install-extension rust-lang.rust-analyzer
```

リモートバンドルのセットアップと起動処理はPOSIXシェルとUnixパスを使用するため、
現在のリモート対象はUnixホストです。Windows側の `PATH` には OpenSSH Client と
`tar.exe` が必要です。バンドル準備中に複数のSSH接続が作成される場合があるため、
鍵認証または `ssh-agent` の利用を推奨します。

#### プロファイル準備と拡張機能の一括処理

リモート起動ではワークスペースを開く前にローカルプロファイルを取り込みます。
リモート側の既存設定は通常のインポート処理でマージされ、キーバインド、
スニペット、タスクも `tode --import` と同じ処理を使用します。拡張機能IDは
大文字小文字を区別せずリモート環境と比較され、不足しているものだけが1回の
エディターサーバー呼び出しで一括インストールされます。
`publisher.extension@1.2.3` のようなバージョン指定は維持されます。一部の
インストールに失敗した場合は、成功分を隠さず失敗を報告します。

#### terminal-browserのアプリケーション統合

インストール済みtodeを開くと、安定したアプリケーションID `terminal-code` で
terminal-browserへ登録されるようになりました。ブラウザーペインにも同じ
アプリケーション名とIDを指定するため、terminal-browserは複数のペインを同じ
アプリケーションとして識別し、アプリケーション検索や新規タブUIからterminal-code
を表示できます。インストール済み `tode.cmd` がない場合は登録を行わないため、
ソースファイルを直接実行しても無効なランチャーは登録されません。

#### Windowsランタイムの互換性

Windowsで使用するterminal-browserの基準バージョンを `v0.8.0` に更新しました。
`0.8.0-win.1` のようなfork版は、この互換基準を満たすものとして認識されます。
Windowsでは、別途インストールされた
`%LOCALAPPDATA%\Programs\terminal-browser` のブラウザーを引き続き直接使用し、
Electron一式をterminal-codeの各インストールへコピーしません。macOSとLinuxは
upstreamの `v0.7.3` を使用します。

### チェックアウトからのビルド

tode自体を開発する場合、開発版インストールによってリリース版を置き換えます。

```powershell
npm install
npm run dist:windows
```

ビルドは `%LOCALAPPDATA%\Programs\tode` に配置され、`bin\tode.cmd` が作成され、
その `bin` ディレクトリがユーザーの `PATH` に追加されます。Windows版の番号は
ベースとなるupstream版とfork固有のリビジョンを組み合わせます。
`0.3.4-win.1` はupstream `0.3.4` をベースにした最初のWindowsビルドです。
現在値は `scripts\stage-windows.ps1` 先頭の `$TodeWindowsVersion` で、開発版と
リリーススクリプトが共有します。リリース時はこの値を変更し、一時的なビルドでは
`-Version` を指定できます。値は `VERSION` に保存され、`tode --version` が表示します。

### このforkで変更している点

- code-serverにはWindowsビルドがないため、WindowsではVSCodiumの `reh-web`
  サーバーを使用します。これはcode-serverがラップしているものと同じOSS版
  VS Codeサーバーで、`win32-x64` 向けに公開されています。
- `%LOCALAPPDATA%` 配下のパス、`.cmd` ランチャー、非表示の独立コンソールを持つ
  バックグラウンドプロセスを使用し、ペインを閉じてもエディターサーバーが
  終了しないようにしています。
- 開いているウィンドウとの通信にはWindows名前付きパイプを使用し、VS Code自身の
  比較方法に合う形式でVS Code URIを構築します。
- ブラウザー内のワークベンチはディスク上の設定を直接読まないため、todeの設定を
  配信HTMLへ含めています。WebViewとリソースも同じorigin経由で配信し、Markdown
  プレビューのスクロールとテーマ読み込みを動作させます。
- キー操作なしでウィンドウを閉じる `tode --quit` と、ブラウザー強制終了後に
  ペインを復元する `tode --reset-terminal` を追加しています。
- WindowsのショートカットウィザードはWezTermを操作します。ユーザーのLuaを直接
  編集せず、`WEZTERM_CONFIG_FILE` が指すラッパー設定を使用します。未対応の
  ターミナルでは、未対応であることを明示して処理を中止します。
- 署名済みGitHub Releasesと、それを参照する `tode --upgrade` からなるWindows専用
  リリースチャンネルを使用します。

### macOSとLinuxへのインストール

upstreamのインストーラーをそのまま使用します。

```bash
curl -fsSL https://tode.sh/install | bash
```

### コマンド一覧

```text
使用方法: tode [path...] [options]
          tode --<command>

  tode                  現在の作業ディレクトリを開く
  tode <folder>         指定フォルダーを開く
  tode <file>           指定ファイルを開く

オプション:
  -g, --goto <f:l:c>    ファイルの行と列を指定して開く
  -a, --add <folder>    アクティブなワークスペースにフォルダーを追加
  -n, --new-window      ファイルであっても新しいペインで開く
  -w, --wait            ファイルが閉じられるまで待機
  -d, --diff <a> <b>    2つのファイルを比較
  -r, --reuse-window    新しいペインではなく現在のウィンドウでフォルダーを開く
  --install-extension   IDまたはVSIXパスから拡張機能をインストール
  --uninstall-extension 拡張機能を削除
  --list-extensions     インストール済み拡張機能を一覧表示
  --split <direction>   right、left、down、up方向の新しいペインで開く
  --size <fraction>     新規分割が占める割合（0.2～0.95）
  --timing              起動の各段階にかかった時間を表示
  --review              ソース管理パネルを開く
  --ssh <user@host>     SSHサーバー上でterminal-codeを実行

コマンド（先頭引数として指定）:
  --shortcut-setup      terminal-codeと現在のターミナルのキー競合を解消
  --timing              terminal-codeの起動時間を計測
  --import [editor]     VS Code互換エディターから設定、キーバインド、
                        スニペット、拡張機能を取り込む
  --theme [file|name]   VS CodeテーマJSONまたはインストール済みテーマ名を指定。
                        選択は次回以降も維持される。引数なしでは
                        ターミナル本来の配色へ戻す
  --serve [path]        コードサーバーを起動してURLを表示
  --skill               terminal-code変更支援用のエージェントスキルを表示
  --upgrade [--check]   terminal-codeを最新版へ更新
  --shutdown            terminal-codeの全アクティビティを停止
  --uninstall [--yes]   terminal-codeの全データを削除
```

### 動作の仕組み

terminal-codeは、ターミナル内ブラウザーである
[terminal-browser](https://github.com/zenbu-labs/terminal-browser)と、
ブラウザー内で動くVS Codeである[code-server](https://github.com/coder/code-server)
を組み合わせ、ターミナル内にVS Codeを表示します。

### ショートカット

ターミナルとterminal-codeは重要なショートカットで競合し、キー入力が
terminal-codeまで届かない場合があります。`tode --shortcut-setup` を実行すると、
対話型ウィザードでターミナル側またはterminal-code側のショートカットを変更し、
競合を解消できます。

### SSH

SSH経由でterminal-codeを利用する推奨方法は、ローカルコンピューター上で
`tode --ssh <ssh arguments>` を実行することです。

SSH接続先で `tode` を直接実行することもできますが、VS Codeが描画する全フレームと
すべての入力をネットワーク経由で送る必要があり、kitty graphics protocolの
[local-client最適化](https://sw.kovidgoyal.net/kitty/graphics-protocol/#local-client)
も利用できません。

`tode --ssh` はリモート側でVS Codeバックエンドだけを実行します。フロントエンドは
ローカルに残るため、操作へすぐに応答でき、ネットワークリクエストだけがSSH接続を
経由します。

Windowsでは terminal-browser `0.8.0-win.1`、OpenSSH Client、`PATH` 上の
`tar.exe` が必要です。SSHのHostエイリアスを使用できます。リモートバンドル準備時に
複数のSSH接続が作成される可能性があるため、鍵認証または `ssh-agent` を推奨します。
現在のリモート対象はUnixホストです。

### Windows

Windows対応は実験的で、次の要素で構成されています。

- **ブラウザー。** [terminal-browser Windows版](https://github.com/fukuyori/terminal-browser/releases)
  がペインを描画します。todeはインストール先
  `%LOCALAPPDATA%\Programs\terminal-browser` を直接参照し、同梱 `node.exe` で
  実行します。ブラウザーはコピーも再ダウンロードもされません。kitty graphics
  protocol対応ターミナルが必要で、現在の検証対象はWezTermです。
- **エディターサーバー。** code-serverのリリースはLinuxとmacOSのみなので、
  Windowsでは[VSCodiumの `reh-web` サーバー](https://github.com/VSCodium/vscodium/releases)
  を使用します。初回起動時に
  `%LOCALAPPDATA%\tode\data\vscodium-server` へ取得します。拡張機能は Open VSX
  を使用します。別のマーケットプレイスを使う場合は
  `VSCODE_GALLERY_SERVICE_URL` / `VSCODE_GALLERY_ITEM_URL` を設定します。
- **保存場所。** WindowsにはXDGディレクトリ分割がないため、`data`、`state`、
  `cache` は `%LOCALAPPDATA%\tode` 配下に置きます。`XDG_DATA_HOME` などを
  明示的に設定した場合は、他OSと同様にそちらが優先されます。
- **設定。** ブラウザー内ワークベンチはディスク上のプロファイルを直接読まないため、
  todeの設定をinjectorが配信するHTMLの `configurationDefaults` として渡します。
  既定値レイヤーとして適用されるので、ユーザーがエディター内で行った変更が
  引き続き優先されます。
- **開いているウィンドウとの通信。** Unixソケットの代わりに名前付きパイプを使用し、
  `%LOCALAPPDATA%\tode\state\ipc` の小さな `.pipe` ファイルで通知します。
  これにより、ウィンドウ内から実行した `tode <file>` が同じウィンドウへ届きます。

配色は2層で処理されます。ターミナルの色は `workbench.colorCustomizations` として
届き、tode専用テーマの上へbridgeが適用します。これによってウィンドウが
ターミナルの配色へリアルタイムに追従し、ワークベンチの
`--vscode-editor-background` もターミナル背景色になります。
`tode --theme "Monokai"` のような名前によるテーマ選択にも対応し、開いている
ウィンドウと次回以降の起動へ反映されます。エディター内でテーマを選択した場合も
bridgeがターミナル配色の適用を解除し、その選択を保存します。引数なしの
`tode --theme` でターミナル配色へ戻ります。

テーマ選択を維持するために2つの修正を行っています。まず、ワークベンチが
サーバー自身のポートからテーマJSONを取得するとinjectorのページとはcross-originに
なり、CORSヘッダーなしでは拒否されます。そのためinjector自身をremote authority
としてページへ渡し、全リソースを同じorigin経由で返します。また、この
ワークベンチはテーマ状態を保持せず、未読み込みのプレースホルダーで設定を
上書きするため、選択内容を
`%LOCALAPPDATA%\tode\data\color-theme.json` に保存してbridgeが継続的に適用します。

**ショートカット。** Windowsの `tode --shortcut-setup` はWezTermを操作します。
WezTerm設定はinclude命令のないLuaプログラムなので、ユーザーの設定を直接編集せず、
`wezterm.lua` と同じ場所に `tode-wezterm.lua` ラッパーを書き出します。ラッパーは
元の設定を読み込んだ後にtodeの上書きを追加し、`WEZTERM_CONFIG_FILE` ユーザー環境
変数から参照されます。適用後はWezTermを再起動してください。WezTermの
`config.leader` が `Ctrl+Q` を使用することがあるため、Windowsでは既定で
`Ctrl+Shift+Q` も終了キーとして使用できます。ウィザードはleaderを解放するか、
タイムアウトを維持したまま別のキーへ移動できます。
`tode --shortcut-setup --undo` はラッパーを削除し、環境変数を元の状態へ戻します。
WezTerm以外のWindowsターミナル用バックエンドはまだありません。その場合は
未対応であることを表示して終了しますが、`TODE_QUIT_CHORD` による手動指定は使えます。

```powershell
$env:TODE_QUIT_CHORD = "ctrl+alt+q"
tode
```

ブラウザーやプロセスツリーが強制終了されると、ペインが代替画面、カーソル非表示、
マウスレポート有効、最終フレーム表示の状態に残る場合があります。
`tode --reset-terminal` はブラウザーが正常終了時に出力する復元シーケンスを送り、
ペインを閉じずにターミナルへ戻します。

`tode --quit` はキー入力を使わず、任意のシェルから開いているウィンドウを閉じます。
「ウィンドウが待ち受けていない」と表示された場合、bridge拡張機能が動作しておらず、
終了キーを押しても届かない状態だと判断できます。

Windowsリリースの更新はこのforkの
[GitHub Releases](https://github.com/fukuyori/terminal-code/releases)を参照します。
`windows` チャンネルは最新リリースの `latest.json` を読み、
`--upgrade --version <v>` は `v<v>` タグ内の `manifest.json` を読みます。
チェックアウトからの開発版も同じチャンネルを使用するため、`tode --upgrade` で
最新リリースへ置き換えられます。

チェックアウトからのビルドとパッケージ作成には2本のスクリプトを使用します。
1本目がコンパイルとpayload配置、2本目がアップグレード用ZIP、manifest、
Inno Setupインストーラーを作成します。

```powershell
npm run build:windows                   # 1. コンパイル、payload配置
npm run package:windows                 # 2. ZIP、manifest、Inno Setup
```

`package:windows` にはInno Setupが必要です。terminal-codeにはネイティブの
`tode.exe` がなく、インストール後のエントリーポイントは `bin\tode.cmd` なので、
この2本には `-Sign` オプションを設けていません。Inno Setupの標準アンインストーラーは
インストーラー内に含まれます。両スクリプトは `scripts\stage-windows.ps1` 先頭の
バージョンを使用し、これは開発版の表示値とも共通です。

公開は明示的に実行する別の操作です。

```powershell
npm run publish:windows                 # gh release create v<version>
```

公開スクリプトは最初にローカルのWindows Defenderで成果物を検査し、
`VT_API_KEY` が設定されている場合はVirusTotalへインストーラーをアップロードして
検査します。検出があれば公開を停止し、`-ScanOnly` は検査だけを実行します。
生成物は未署名なので、公開時には既存の `-AllowUnsigned` 指定が必要です。

ネイティブ版を使わない場合は、[WSL](https://learn.microsoft.com/en-us/windows/wsl/install)
内でLinux版を実行することもできます。
