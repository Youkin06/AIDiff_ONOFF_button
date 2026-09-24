import * as vscode from 'vscode';
import { DiffManager } from './diff/diffManager';
import { IAiRunner } from './claude/aiRunner';
import { HookWatcher } from './watcher/hookWatcher';
import { WorkspaceWatcher } from './watcher/workspaceWatcher';
import { SessionPanelProvider } from './views/sessionPanel';
import { HunkCodeLensProvider } from './diff/hunkCodeLensProvider';
import { registerAllCommands } from './commands/commandsRegistry';
import { NavigationManager } from './diff/navigationManager';
import { NavBarPanel } from './views/navBarPanel';
import { GitDiffProvider } from './git/gitDiffProvider';

export function activate(context: vscode.ExtensionContext): void {
  // CodeLens buttons (Accept/Revert hunk) are suppressed in diff editors by default.
  // Enable at workspace scope so they appear in the right (modified) pane.
  const editorConfig = vscode.workspace.getConfiguration();
  if (editorConfig.get<boolean>('diffEditor.codeLens') !== true) {
    void editorConfig.update('diffEditor.codeLens', true, vscode.ConfigurationTarget.Global);
  }

  const diffManager       = new DiffManager(context);
  const gitDiffProvider   = new GitDiffProvider(context);
  const sessionPanel      = new SessionPanelProvider(diffManager, gitDiffProvider, context);
  const workspaceWatcher  = new WorkspaceWatcher(diffManager);
  const fsHookWatcher     = new HookWatcher(diffManager);
  const navigationManager = new NavigationManager(diffManager);

  const monitoringKey = 'ai-cli-diff-view.monitoringEnabled';
  diffManager.monitoringEnabled = context.globalState.get<boolean>(monitoringKey, true);
  const monitoringStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  monitoringStatus.name = 'AI Diff Monitoring';
  monitoringStatus.command = 'ai-cli-diff-view.toggleMonitoring';
  const updateMonitoringStatus = (): void => {
    const enabled = diffManager.monitoringEnabled;
    monitoringStatus.text = enabled ? '$(eye) AI Diff: ON' : '$(eye-closed) AI Diff: OFF';
    monitoringStatus.tooltip = enabled
      ? 'AI Diff Viewer monitoring is enabled. Click to disable.'
      : 'AI Diff Viewer monitoring is disabled. Click to enable.';
    monitoringStatus.show();
  };
  updateMonitoringStatus();
  context.subscriptions.push(monitoringStatus,
    vscode.commands.registerCommand('ai-cli-diff-view.toggleMonitoring', async () => {
      diffManager.monitoringEnabled = !diffManager.monitoringEnabled;
      fsHookWatcher.monitoringChanged();
      if (diffManager.monitoringEnabled) {
        workspaceWatcher.start();
      } else {
        workspaceWatcher.dispose();
      }
      updateMonitoringStatus();
      try {
        await context.globalState.update(monitoringKey, diffManager.monitoringEnabled);
      } catch (err) {
        void vscode.window.showErrorMessage(`AI Diff: Could not save monitoring state: ${String(err)}`);
      }
    })
  );

  diffManager.renderer.setNavigationManager(navigationManager);

  const navBarPanel = new NavBarPanel(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(NavBarPanel.viewType, navBarPanel)
  );
  diffManager.renderer.setNavUpdateCallback(() => {
    updateNavBarState();
  });

  let activeRunner: IAiRunner | undefined;

  context.subscriptions.push(
    { dispose: () => diffManager.disposeAll() },
    { dispose: () => fsHookWatcher.dispose() },
    { dispose: () => workspaceWatcher.dispose() },
    { dispose: () => sessionPanel.dispose() },
    { dispose: () => gitDiffProvider.dispose() }
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SessionPanelProvider.viewType, sessionPanel)
  );

  const codeLensProvider = new HunkCodeLensProvider(diffManager);
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, codeLensProvider),
    diffManager.onDidChangeDiffs(() => codeLensProvider.refresh())
  );

  fsHookWatcher.start();
  if (diffManager.monitoringEnabled) { workspaceWatcher.start(); }
  gitDiffProvider.start();

  registerAllCommands({
    diffManager,
    sessionPanel,
    context,
    getRunner: () => activeRunner,
    setRunner: (r) => { activeRunner = r; },
  });

  context.subscriptions.push(
    vscode.commands.registerCommand('ai-cli-diff-view.nextFile', () => navigationManager.nextFile()),
    vscode.commands.registerCommand('ai-cli-diff-view.prevFile', () => navigationManager.prevFile())
  );

  function updateNavBarState(): void {
    const editor = vscode.window.activeTextEditor;
    const filePath = editor?.document.uri.fsPath;
    const pendingFiles = diffManager.getPendingFiles();

    if (pendingFiles.length === 0) {
      navBarPanel.setActiveFile(undefined);
      navBarPanel.update(undefined);
      return;
    }

    if (filePath && diffManager.renderer.hasPending(filePath)) {
      navBarPanel.setActiveFile(filePath);
    } else {
      navBarPanel.setActiveFile(undefined);
    }

    const navAnchor = filePath ?? pendingFiles[0];
    navBarPanel.update(navigationManager.getNavigationInfo(navAnchor));
  }

  // Switching the active editor only refreshes inline decorations — it never force-opens the
  // split-view diff editor. Auto-opening is governed by the `autoOpenDiffEditor` setting
  // (off by default) and only fires from watcher paths where the AI CLI actually wrote the file.
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      updateNavBarState();
      if (!editor || editor.document.uri.scheme !== 'file') { return; }
      const filePath = editor.document.uri.fsPath;
      if (diffManager.renderer.hasPending(filePath)) {
        diffManager.renderer.applyDecorations(filePath);
      }
    })
  );

  context.subscriptions.push(
    diffManager.onDidChangeDiffs(() => {
      updateNavBarState();
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      const filePath = e.document.uri.fsPath;
      if (diffManager.renderer.hasPending(filePath)) {
        diffManager.renderer.applyDecorations(filePath);
      }
    })
  );
}

export function deactivate(): void {}
