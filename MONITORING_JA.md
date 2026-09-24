# AI Diff Viewer 監視ON/OFF版

## 1.0.8 起動時クラッシュの修正

Unityの`Library`、`Temp`、`Logs`、`Build`、`Builds`、`UserSettings`、IL2CPP生成コードとバックアップ出力を監視・初期snapshotから除外しました。2 MiBを超えるファイルもworkspace監視から除外します。
検証用Unityプロジェクトの初期読込対象は約3.1 GBから2.4 MB（261ファイル、単独検証51ms、heap約10 MiB）へ減少しました。除外対象はAI Diffによる自動監視の対象外ですが、VS Codeの編集・保存には影響しません。
既存の14項目に生成物・大容量ファイルの除外テストを追加し、15項目の統合検証に合格しました。

元ソース: https://github.com/EloWeld/ai-diff-viewer
取得コミット: `a013436e20da070f81b8983408cd6fddb274e1da`（1.0.6）。
空の作業フォルダーに公式ソースを取得し、ローカル版を1.0.8に更新しました。
MITライセンスと元作者の著作権表示は維持しています。

## 変更したファイル

| ファイル | 変更内容 |
| --- | --- |
| `src/extension.ts` | 右下のStatus Bar、コマンド、globalState保存、起動時の復元 |
| `src/diff/diffManager.ts` | OFF時の自動snapshot取得・注入・diff生成を共通入口で遮断 |
| `src/watcher/workspaceWatcher.ts` | 監視の停止・再開、baseline更新、旧遅延処理の無効化 |
| `src/watcher/fileSnapshotStore.ts` | 再開時に既知ファイルを再読込。削除されたファイルのbaselineを破棄 |
| `src/watcher/hookWatcher.ts` | OFF中のhook信号を消費して無視。再開前の信号・snapshotを除外 |
| `src/claude/claudeRunner.ts` | OFF中の取得を抑制し、切り替えをまたぐCLI結果を除外 |
| `package.json` | Toggle Monitoring登録、1.0.8への更新、test script追加 |
| `package-lock.json` | npmで取得した依存関係を固定 |
| `.vscode/launch.json` / `tasks.json` | F5のExtension Development Hostと事前compile |
| `tests/` | 実VS Codeを使った監視・編集・保存・Accept/Revert・再起動の統合テスト |
| `.vscodeignore` | テストコード・テストデータをVSIXから除外 |
| `MONITORING_JA.md` | 本手順書 |

## 実装内容

- 初期値はON。`ExtensionContext.globalState`の`ai-cli-diff-view.monitoringEnabled`に保存します。
- OFFではworkspace watcherと保存イベントの購読をdisposeします。予約済みの200ms遅延処理は世代番号で無効化します。
- hook watcherは信号の後追いを防ぐため購読を続け、現在のworkspaceに属するOFF中の信号を消費して無視します。他workspaceの信号は消費しません。
- DiffManagerの共通入口もOFFを検査するため、内蔵CLI実行から新規diffが生成されることも防ぎます。
- ONでは現在のディスク内容をbaselineに更新し、監視を再登録します。OFF中の編集・保存は次のdiffの「変更前」になります。
- pending diffのsnapshotや表示は切り替え時に削除しません。既存diffを手動で開く操作、Accept/Revertは使用できます。
- 既存pendingファイルのRevert Allは従来どおりsnapshot全体へ戻します。同じファイルを手動編集する前にpendingをレビューすると、AI編集と手動編集を分けやすくなります。
- Git一覧表示は既存どおり更新します。今回のOFFはAIの新規diff生成を止めるもので、Gitの変更状態やVS Code標準の差分表示は対象外です。

## 動作確認結果

実際のVS Codeを分離した開発環境で起動し、14項目の統合テストに合格しました。

| 確認項目 | 結果 |
| --- | --- |
| 初期ON、外部変更からinline diff生成 | 合格 |
| OFFで既存pendingを保持 | 合格 |
| OFF中の外部書込・VS Code編集・保存で新規diffなし | 合格（編集・保存自体も成功） |
| ON復帰時にOFF中の編集をbaselineへ反映 | 合格 |
| ON復帰後の変更で再びdiff生成 | 合格 |
| 実プロセスの終了・再起動後もOFFを復元 | 合格 |
| 再起動後のOFFで新規diffなし、ON復帰で生成 | 合格 |
| Accept / Revert | 合格（OFF中の既存pendingを対象） |
| 切り替えをまたぐ遅延イベント | 合格（新規diffなし） |
| OFF中のhook信号と再開後の後追い防止 | 合格 |
| 内蔵CLIが使用するsnapshot/diff入口のOFF制御 | 合格 |
| TypeScript strict compile、VSIX生成 | 合格 |

既存機能は上記の確認範囲で回帰がないことを確認しました。実際のCodex／ClaudeへのAPI呼び出しや、全既存コマンドの網羅テストは行っていません。lint scriptは元プロジェクトに存在しません。

## ビルド方法

Node.js/npmが必要です。実行環境はNode.js 24.11.0、npm 11.6.1です。

```bash
cd ./AIDiff_ONOFF_button
npm ci
npm run compile
npm test
npm run package
```

初回の依存取得では`npm install`を実行しました。以降はlockfileを使う`npm ci`で再現できます。
`compile`はstrictモードのTypeScriptコンパイルです。既存のlint script／lint設定はありません。
`package`はプロジェクト既存の`vsce package`を使用し、prepublishでもcompileします。

## VS Codeでテストする方法

1. このフォルダーをVS Codeで開き、`npm ci`を実行します。
2. Run and Debugで「Run AI Diff Viewer」を選択し、F5（Macの設定によってはfn+F5）を押します。
3. Extension Development Hostの新しいウィンドウで、テスト用フォルダーを開きます。
4. 既存のテキストファイルを用意し、右下の`AI Diff: ON`を確認します。
5. 別のTerminalまたはCodexからファイルを書き換え、inline diffを確認します。VS Code自身からの保存は、ONでも元実装が通常抑制します。
6. Status BarをクリックしてOFFにし、VS Codeで編集・保存します。新しいdiffが生成されないことを確認します。
7. ONに戻し、再び外部から編集します。OFF中の内容を基準にdiffが生成されます。
8. Accept/Revertを試します。OFFにしても既存のpendingは保持されます。
9. OFFにして`Developer: Reload Window`を実行し、OFFの復元を確認します。

`npm test`は通常環境と分けた一時user-data／extensionsフォルダーを作り、実際のVS Codeを2回起動・終了します。
通常の拡張テストモードはストレージがメモリー上となるため、再起動検証には専用の開発用テストdriverを使用しています。
VS Codeの標準インストール先を使用します。別の場所の場合は`VSCODE_EXECUTABLE`に実行ファイルを指定してください。
結果は`.vscode-test/integration-results.json`と`.vscode-test/restart-results.json`に出力します。

## VSIX作成方法・生成されたVSIX

```bash
cd ./AIDiff_ONOFF_button
npm run package
```

出力: `./AIDiff_ONOFF_button/ai-diff-viewer-1.0.8.vsix`

## インストール方法

GUI:

1. 通常のVS Codeで⌘⇧Xを押してExtensionsを開きます。
2. Extensions上部の`…`から`Install from VSIX...`（VSIXからのインストール）を選びます。
3. このフォルダーの`ai-diff-viewer-1.0.8.vsix`を選びます。
4. `Developer: Reload Window`を実行します。

Terminal:

```bash
code --install-extension ./AIDiff_ONOFF_button/ai-diff-viewer-1.0.8.vsix --force
```

`code`が見つからない場合、VS Codeで⌘⇧Pを押し、`Shell Command: Install 'code' command in PATH`を実行してTerminalを開き直します。
PATHを変更せず実行する場合:

```bash
"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" --install-extension ./AIDiff_ONOFF_button/ai-diff-viewer-1.0.8.vsix --force
```

## Marketplace版との競合

Extension IDは元と同じ`mtglitch.ai-diff-viewer`です。同じIDの1.0.8としてインストールするため、現在のMarketplace版1.0.6を置き換えます。同時に2つ動くことはなく、通常は事前の無効化・アンインストールは不要です。
以前に拡張を無効化している場合は、インストール後に有効化してください。

VSIXでのインストールは現行のVS Codeではその拡張の自動更新が既定で無効になります。念のためExtensionsでAI Diff Viewerを右クリックし、Auto UpdateがOFFであることを確認してください。自動更新を有効にした場合やMarketplace版へ手動更新した場合、ローカル変更が上書きされる可能性があります。

別IDにする場合は`publisher`または`name`の変更で別拡張になります。ただし、この拡張はコマンドID・view ID・設定名・hook信号ディレクトリーを共有しているため、IDだけ変更して両方を有効にすると競合します。別IDで保存する場合も元版を無効化してください。同時有効化には各IDやhook経路の分離が必要で、今回の最小変更の範囲には含めていません。
MITライセンスは改変・配布を許可していますが、著作権・ライセンス表示の保持が必要です。この版では保持済みです。元publisherを使ったMarketplaceへの公開は行っていません。

参考: [VS Code公式・拡張管理](https://code.visualstudio.com/docs/configure/extensions/extension-marketplace)、[CLI](https://code.visualstudio.com/docs/configure/command-line)

## 更新方法

コード修正後、以下を実行してReload Windowします。

```bash
cd ./AIDiff_ONOFF_button
npm run compile
npm test
npm run package
code --install-extension ./ai-diff-viewer-1.0.8.vsix --force
```

ローカルで同じバージョンを再インストールする際は`--force`を使用します。更新を識別しやすくするには、package前に`npm version patch --no-git-tag-version`でversionとnpm lockfileを更新してください。その場合VSIX名も変わるため、インストールするファイル名を合わせます。

## 使い方

- VS Code下部のStatus Bar右側に、eyeアイコンと`AI Diff: ON`、またはeye-closedアイコンと`AI Diff: OFF`を表示します。
- ボタンのクリックで切り替わり、Tooltipに現在の状態と次の操作を表示します。
- ⌘⇧P → `AI Diff Viewer: Toggle Monitoring`でも切り替えられます。
- ⌘K、⌘SでKeyboard Shortcutsを開き、`AI Diff Viewer: Toggle Monitoring`を検索して好きなキーを割り当てられます。既定キーは追加していません。
- コマンドIDは`ai-cli-diff-view.toggleMonitoring`です。
