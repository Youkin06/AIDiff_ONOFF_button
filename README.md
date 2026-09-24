# AI Diff Viewer — 監視ON/OFF版

AIがコードを書き換えるときは差分を確認し、自分で編集するときは監視を止められる、VS Code拡張機能です。

[AI Diff Viewer](https://github.com/EloWeld/ai-diff-viewer) 1.0.6をベースに、右下の監視スイッチとUnityプロジェクト向けの負荷対策を追加した個人用改変版です。

## できること

- 右下の **AI Diff: ON / OFF** をクリックして監視を切り替えます。
- ONでは、Codexなどによる外部からのファイル変更を検知し、差分を表示します。
- OFFでは新しいAI Diffを作らず、通常どおり編集・保存できます。
- ON/OFFの状態は保存され、VS Codeを終了・再起動しても復元されます。
- OFFにしても確認待ちの差分は残り、Accept（承認）／Revert（元に戻す）が使えます。
- ONに戻すと、その時点のファイル内容から監視を再開します。

## インストール手順（Mac）

利用するだけなら、ソースコードやNode.jsは不要です。

1. GitHubにログインし、[最新版のダウンロードページ](https://github.com/Youkin06/AIDiff_ONOFF_button/releases/latest)を開きます。このリポジトリは非公開のため、アクセス権のあるアカウントが必要です。
2. ページ下部の **Assets** から `ai-diff-viewer-1.0.8.vsix` をダウンロードします。Source codeのzipではありません。
3. 通常のVS Codeを開き、**⌘ + Shift + P** を押します。
4. `Extensions: Install from VSIX...`（VSIXからのインストール）を検索し、実行します。
5. ダウンロードした `.vsix` ファイルを選びます。
6. **⌘ + Shift + X** で拡張機能一覧を開き、AI Diff Viewerに「有効にする / Enable」が出ていたらクリックします。
7. **⌘ + Shift + P** → `Developer: Reload Window`（ウィンドウの再読み込み）を実行します。
8. 右下に **AI Diff: ON** または **AI Diff: OFF** が出れば完了です。

一度インストールすれば、起動のたびにインストールし直す必要はありません。

### ターミナルからインストールする場合

```bash
code --install-extension "$HOME/Downloads/ai-diff-viewer-1.0.8.vsix" --force
```

`code` が見つからない場合は、VS Codeのコマンドパレットで `Shell Command: Install 'code' command in PATH` を実行し、ターミナルを開き直します。

## 使い方

| 作業 | おすすめの状態 |
| --- | --- |
| Codexなどにコードを書き換えてもらう | ON |
| 自分で編集する・監視を一時停止する | OFF |

右下をクリックするたびに切り替わります。コマンドパレットの `AI Diff Viewer: Toggle Monitoring` からも操作できます。

初回はONです。その後は最後の状態を復元します。表示がOFFでも、拡張が消えたわけではありません。

ショートカットを設定するには、⌘K → ⌘Sでキーボードショートカットを開き、上記コマンドを検索します。コマンドIDは `ai-cli-diff-view.toggleMonitoring` です。

> OFFは既存の差分を消す操作ではありません。確認待ちのファイルに対してRevert Allを実行すると、そのファイルの手動編集も戻る可能性があります。先に差分を確認してください。

## 右下に表示されないとき

次の順番で確認してください。

1. 拡張機能一覧で **AI Diff Viewerが有効** になっているか確認する。
2. VS Code下部のステータスバーを右クリックし、**AI Diff Monitoring** にチェックがあるか確認する。
3. バー自体がない場合は「表示 → 外観 → ステータスバー」を表示する。
4. `Developer: Reload Window` を実行する。
5. バージョンが **1.0.8** になっているか確認する。

1.0.7では、大きなUnity生成物を読み込んで拡張ホストが停止するケースがありました。1.0.8では除外とファイルサイズ制限を追加しています。

## 監視対象と制限

- Unityの `Library`、`Temp`、`Logs`、`Build`、`Builds`、`UserSettings`、`il2cppOutput`、`_BackUpThisFolder_ButDontShipItWithYourGame` で終わるフォルダーなどは監視対象外です。
- 2 MiBを超えるファイルはワークスペースの自動監視対象外です。
- 元の実装にある初期走査の深さ制限も残しています。
- VS Code自身による保存は、ONでも通常は差分生成が抑制されます。動作確認には外部ツールによる書き込みを使ってください。
- このスイッチはAI Diffの新規差分生成を制御します。Gitの変更履歴やVS Code標準の差分表示は停止しません。

## Marketplace版との関係

拡張IDは元の `mtglitch.ai-diff-viewer` のままです。VSIXを入れると元の拡張を置き換えるため、2つ同時に動くわけではありません。

**この改変版を使い続ける場合は、拡張機能一覧のAI Diff Viewerを右クリックし、自動更新がOFFになっていることを確認してください。** Marketplace版に更新すると、この版の監視スイッチが失われる可能性があります。

元publisherの名前は互換性のため保持しています。元publisherとしてMarketplaceに公開するためのものではありません。このリポジトリのGitHub ActionsはVSIXのビルドのみを行い、Marketplaceへの公開は行いません。

## ローカルのソースを削除しても使える？

**VSIXからインストール済みなら、このソースフォルダーやダウンロードしたVSIXを削除しても使えます。** VS Codeにインストールされた拡張本体は、別の場所に保存されています。

別のMacや再インストール時は、[Releases](https://github.com/Youkin06/AIDiff_ONOFF_button/releases)からVSIXをダウンロードし、上記手順でインストールしてください。削除前のソースコードもGitHubから取得できます。

## 開発・ビルドする場合

Node.js 24系とnpmを推奨します。

```bash
git clone https://github.com/Youkin06/AIDiff_ONOFF_button.git
cd AIDiff_ONOFF_button
npm ci
npm run compile
npm test
npm run package
```

- `compile`：TypeScriptのコンパイル。
- `test`：Macの実VS Codeを分離したプロファイルで起動して統合検証。標準以外の場所にVS Codeがある場合は `VSCODE_EXECUTABLE` を指定します。
- `package`：インストール用の `ai-diff-viewer-1.0.8.vsix` を生成。
- VS Codeでこのフォルダーを開き、F5の **Run AI Diff Viewer** から開発用ウィンドウを起動できます。

監視切替・編集保存・Accept/Revert・再起動時の状態復元・大容量生成物の除外など、15項目の統合検証に合格しています。すべての元機能やAIサービスへのAPI呼び出しを網羅したテストではありません。

更新後はVSIXを再インストールし、ウィンドウを再読み込みします。

```bash
code --install-extension ./ai-diff-viewer-1.0.8.vsix --force
```

バージョンを上げる場合は `npm version patch --no-git-tag-version` を実行してからビルドし、変更したソースと新しいVSIXをGitHubに保存してください。VSIXのファイル名も変わります。

## 元プロジェクト・ライセンス

- 改変元：[EloWeld/ai-diff-viewer](https://github.com/EloWeld/ai-diff-viewer)
- 取得コミット：`a013436e20da070f81b8983408cd6fddb274e1da`（1.0.6）
- 原作者：konan-1947 / フォーク：MtGlitch
- ライセンス：[MIT](LICENSE)。元作者の著作権表示を保持しています。
- 実装と検証の詳細：[MONITORING_JA.md](MONITORING_JA.md)
