import * as fs from 'fs';
import * as vscode from 'vscode';
import * as path from 'path';
import { DiffManager } from '../diff/diffManager';
import { GitDiffProvider } from '../git/gitDiffProvider';
import { detectOurClaudeHooks, hooksFullyActive } from '../claude/hookInstallDetect';

type SessionState = 'idle' | 'running' | 'error';
type ViewMode = 'ai' | 'git';

const MODE_STATE_KEY = 'ai-cli-diff.viewMode';

export class SessionPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'ai-cli-diff-view.session';

  private view?: vscode.WebviewView;
  private state: SessionState = 'idle';
  private lastPrompt = '';
  private errorMessage = '';
  private mode: ViewMode;
  /** File list của lần render git gần nhất — dùng cho accept-all/revert-all. */
  private lastGitFiles: string[] = [];
  private gitRefreshTimer?: ReturnType<typeof setTimeout>;
  private readonly diffDisposable: vscode.Disposable;
  private readonly gitDisposable: vscode.Disposable;
  private readonly configDisposable: vscode.Disposable;

  constructor(
    private readonly diffManager: DiffManager,
    private readonly gitDiffProvider: GitDiffProvider,
    private readonly context: vscode.ExtensionContext
  ) {
    this.mode = context.workspaceState.get<ViewMode>(MODE_STATE_KEY, 'ai');
    this.diffDisposable = this.diffManager.onDidChangeDiffs(() => {
      if (this.mode === 'ai') {
        this.render();
      }
    });
    this.gitDisposable = this.gitDiffProvider.onDidChange(() => {
      this.scheduleGitRefresh();
    });
    this.configDisposable = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('ai-cli-diff-view.autoOpenDiffEditor')) {
        this.render();
      }
    });
  }

  dispose(): void {
    this.diffDisposable.dispose();
    this.gitDisposable.dispose();
    this.configDisposable.dispose();
    if (this.gitRefreshTimer) {
      clearTimeout(this.gitRefreshTimer);
    }
  }

  private scheduleGitRefresh(): void {
    if (this.mode !== 'git') {
      return;
    }
    if (this.gitRefreshTimer) {
      clearTimeout(this.gitRefreshTimer);
    }
    this.gitRefreshTimer = setTimeout(() => this.render(), 400);
  }

  private async openGitDiff(absPath: string): Promise<void> {
    try {
      const originalUri = this.gitDiffProvider.buildOriginalUri(absPath);
      const modifiedUri = vscode.Uri.file(absPath);
      const title = `Git Diff: ${path.basename(absPath)}`;
      await vscode.commands.executeCommand('vscode.diff', originalUri, modifiedUri, title, { preview: false });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`Git Diff: could not open file - ${message}`);
    }
  }

  private async discardGitFile(absPath: string): Promise<void> {
    const pick = await vscode.window.showWarningMessage(
      `Discard changes in ${path.basename(absPath)}? This restores the file to its HEAD state.`,
      { modal: true },
      'Discard'
    );
    if (pick !== 'Discard') {
      return;
    }
    try {
      await this.gitDiffProvider.discard(absPath);
      void vscode.window.showInformationMessage(`Discarded: ${path.basename(absPath)}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`Git Diff: discard failed - ${message}`);
    }
  }

  private async discardAllGit(): Promise<void> {
    const files = [...this.lastGitFiles];
    if (files.length === 0) {
      void vscode.window.showWarningMessage('No git changes to discard.');
      return;
    }
    const pick = await vscode.window.showWarningMessage(
      `Discard changes in ${files.length} file(s)? This restores them to their HEAD state.`,
      { modal: true },
      'Discard All'
    );
    if (pick !== 'Discard All') {
      return;
    }
    let n = 0;
    for (const p of files) {
      try {
        await this.gitDiffProvider.discard(p);
        n++;
      } catch {
        // ignore individual failures
      }
    }
    void vscode.window.showInformationMessage(`Discarded changes in ${n} file(s).`);
  }

  /** Re-read hook install state from disk (e.g. after installHooks). */
  refresh(): void {
    this.render();
  }

  setRunning(prompt: string): void {
    this.state = 'running';
    this.lastPrompt = prompt;
    this.errorMessage = '';
    this.render();
  }

  setIdle(): void {
    this.state = 'idle';
    this.render();
  }

  setError(message: string): void {
    this.state = 'error';
    this.errorMessage = message;
    this.render();
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    };
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.render();
      }
    });
    webviewView.webview.onDidReceiveMessage((msg: { command?: string; path?: string; mode?: string }) => {
      if (msg.command === 'switchMode' && (msg.mode === 'ai' || msg.mode === 'git')) {
        if (this.mode !== msg.mode) {
          this.mode = msg.mode;
          void this.context.workspaceState.update(MODE_STATE_KEY, this.mode);
          this.render();
        }
        return;
      }

      if (msg.command === 'openFile' && msg.path && typeof msg.path === 'string') {
        if (this.mode === 'git') {
          void this.openGitDiff(msg.path);
        } else {
          void vscode.commands.executeCommand('ai-cli-diff-view.openPendingFile', msg.path);
        }
      } else if (msg.command === 'openFilePlain' && msg.path && typeof msg.path === 'string') {
        void vscode.commands.executeCommand('ai-cli-diff-view.openPendingFilePlain', msg.path);
      } else if (msg.command === 'installHooks') {
        void vscode.commands.executeCommand('ai-cli-diff-view.installHooks');
      } else if (msg.command === 'acceptAll') {
        if (this.mode === 'git') {
          this.gitDiffProvider.markAllReviewed(this.lastGitFiles);
          return;
        }
        void vscode.commands.executeCommand('ai-cli-diff-view.acceptAllChanges');
      } else if (msg.command === 'revertAll') {
        if (this.mode === 'git') {
          void this.discardAllGit();
          return;
        }
        void (async () => {
          const files = this.diffManager.getPendingFiles();
          if (files.length === 0) {
            void vscode.window.showWarningMessage('No pending changes to revert.');
            return;
          }
          const pick = await vscode.window.showWarningMessage(
            `Revert all changes in ${files.length} file(s)?`,
            { modal: true },
            'Revert All'
          );
          if (pick !== 'Revert All') {
            return;
          }
          let n = 0;
          for (const p of files) {
            try {
              await this.diffManager.revert(p);
              n++;
            } catch {
              // ignore individual failures
            }
          }
          void vscode.window.showInformationMessage(`Reverted all changes in ${n} file(s).`);
        })();
      } else if (msg.command === 'acceptFile' && msg.path && typeof msg.path === 'string') {
        const filePath = msg.path;
        if (this.mode === 'git') {
          this.gitDiffProvider.markReviewed(filePath);
          return;
        }
        void (async () => {
          try {
            await this.diffManager.accept(filePath);
            void vscode.window.showInformationMessage(`Accepted: ${path.basename(filePath)}`);
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            void vscode.window.showErrorMessage(`AI Diff: accept failed - ${message}`);
          }
        })();
      } else if (msg.command === 'revertFile' && msg.path && typeof msg.path === 'string') {
        const filePath = msg.path;
        if (this.mode === 'git') {
          void this.discardGitFile(filePath);
          return;
        }
        void (async () => {
          try {
            await this.diffManager.revert(filePath);
            void vscode.window.showInformationMessage(`Reverted: ${path.basename(filePath)}`);
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            void vscode.window.showErrorMessage(`AI Diff: revert failed - ${message}`);
          }
        })();
      } else if (msg.command === 'toggleAutoOpen') {
        void (async () => {
          const cfg = vscode.workspace.getConfiguration('ai-cli-diff-view');
          const current = cfg.get<boolean>('autoOpenDiffEditor', false);
          await cfg.update('autoOpenDiffEditor', !current, vscode.ConfigurationTarget.Global);
        })();
      }
    });
    this.render();
  }

  private render(): void {
    void this.renderAsync();
  }

  private async renderAsync(): Promise<void> {
    if (!this.view) {
      return;
    }
    const iconsDir = vscode.Uri.joinPath(
      this.context.extensionUri,
      'media', 'file-icons'
    );
    const iconBase = this.view.webview.asWebviewUri(iconsDir).toString() + '/';
    const html = await this.buildHtml(iconBase);
    if (this.view) {
      this.view.webview.html = html;
    }
  }

  private async buildHtml(iconBase: string): Promise<string> {
    const isGit = this.mode === 'git';

    let gitStatus: { hasRepo: boolean; files: string[] } = { hasRepo: true, files: [] };
    if (isGit) {
      gitStatus = await this.gitDiffProvider.getStatus();
      this.lastGitFiles = gitStatus.files;
    }

    const pending = isGit ? gitStatus.files : this.diffManager.getPendingFiles();
    const treeModel = buildPendingTreeModel(pending);
    const pendingTreeHtml =
      pending.length === 0 ? '' : renderPendingTreeHtml(treeModel, 0, iconBase, this.mode);

    const modeToggleHtml = `
      <div class="mode-toggle" role="tablist">
        <button type="button" class="mode-btn ${isGit ? '' : 'mode-active'}" data-mode="ai" role="tab" aria-selected="${isGit ? 'false' : 'true'}">AI Diff</button>
        <button type="button" class="mode-btn ${isGit ? 'mode-active' : ''}" data-mode="git" role="tab" aria-selected="${isGit ? 'true' : 'false'}">Git Diff</button>
      </div>`;

    let statusHtml = '';
    if (this.state === 'running') {
      statusHtml = `
      <div class="banner banner-run">
        <span class="banner-icon">&#8635;</span>
        <div class="banner-text">
          <div class="banner-title">Running</div>
          <div class="banner-detail">${escapeHtml(this.lastPrompt || '(no prompt)')}</div>
        </div>
      </div>`;
    } else if (this.state === 'error') {
      statusHtml = `
      <div class="banner banner-err">
        <span class="banner-icon">&#9888;</span>
        <div class="banner-text">
          <div class="banner-title">Session failed</div>
          <div class="banner-detail">${escapeHtml(this.errorMessage || 'Unknown error')}</div>
        </div>
      </div>`;
    }

    const sectionLabel = isGit ? 'Changes vs HEAD' : 'Pending changes';
    const emptyLabel = isGit
      ? gitStatus.hasRepo
        ? 'No changes vs HEAD (working tree clean)'
        : 'Not a git repository in this workspace'
      : 'No pending file changes';
    const acceptAllLabel = isGit ? 'Mark All Reviewed' : 'Accept All';
    const acceptAllTitle = isGit
      ? 'Hide all listed files from the Git Diff list (does not touch git)'
      : 'Accept all pending changes in every file';
    const revertAllLabel = isGit ? 'Discard All' : 'Revert All';
    const revertAllTitle = isGit
      ? 'Discard changes in every file, restoring them to their HEAD state'
      : 'Revert all pending changes in every file';

    const pendingBlock =
      pending.length === 0
        ? `<div class="empty-pending">${escapeHtml(emptyLabel)}</div>`
        : `
      <div class="section-title">
        <span>${escapeHtml(sectionLabel)}</span>
        <span class="badge">${pending.length}</span>
      </div>
      <div class="bulk-actions">
        <button type="button" class="btn-bulk btn-bulk-accept" id="btn-accept-all" title="${escapeAttr(acceptAllTitle)}">
          <span class="btn-bulk-ico">&#10003;</span><span>${escapeHtml(acceptAllLabel)}</span>
        </button>
        <button type="button" class="btn-bulk btn-bulk-revert" id="btn-revert-all" title="${escapeAttr(revertAllTitle)}">
          <span class="btn-bulk-ico">&#10007;</span><span>${escapeHtml(revertAllLabel)}</span>
        </button>
      </div>
      <div class="file-tree" id="file-tree">${pendingTreeHtml}</div>`;

    const autoOpen = vscode.workspace
      .getConfiguration('ai-cli-diff-view')
      .get<boolean>('autoOpenDiffEditor', false);
    const autoOpenToggleHtml = `
      <div class="setting-row" id="setting-auto-open" title="Automatically open the split-view diff editor when an AI CLI edits a file">
        <div class="setting-text">
          <div class="setting-title">Auto Open Diff Editor</div>
          <div class="setting-detail">Open split-view diff on every AI CLI edit</div>
        </div>
        <button type="button" role="switch" aria-checked="${autoOpen ? 'true' : 'false'}" class="toggle ${autoOpen ? 'toggle-on' : 'toggle-off'}" id="toggle-auto-open">
          <span class="toggle-knob"></span>
        </button>
      </div>`;

    const hookDet = detectOurClaudeHooks(this.context.extensionUri.fsPath);
    const hooksOk = hooksFullyActive(hookDet);

    let extVersion = '';
    try {
      const pkgJson = JSON.parse(
        fs.readFileSync(path.join(this.context.extensionUri.fsPath, 'package.json'), 'utf8')
      ) as { version?: string };
      extVersion = pkgJson.version ?? '';
    } catch {
      // ignore
    }
    const versionTag = extVersion
      ? `<span class="hook-version">v${escapeHtml(extVersion)}</span>`
      : '';

    let hookStatusHtml = '';
    if (hooksOk) {
      hookStatusHtml = `<div class="hook-status hook-ok"><span class="hook-status-text">CLI hooks: active</span>${versionTag}</div>`;
    } else if (!hookDet.settingsFound) {
      hookStatusHtml = `<div class="hook-status hook-no"><span class="hook-status-text">CLI hooks: <strong>not installed</strong> (no Claude settings file yet)</span>${versionTag}</div>`;
    } else if (hookDet.preHookFound || hookDet.postHookFound) {
      hookStatusHtml = `<div class="hook-status hook-warn"><span class="hook-status-text">CLI hooks: <strong>incomplete</strong> — pre: ${
        hookDet.preHookFound ? 'OK' : 'missing'
      }, post: ${hookDet.postHookFound ? 'OK' : 'missing'}</span>${versionTag}</div>`;
    } else {
      hookStatusHtml = `<div class="hook-status hook-no"><span class="hook-status-text">CLI hooks: <strong>not installed</strong> for this extension</span>${versionTag}</div>`;
    }

    const installLabel = hooksOk ? 'Reinstall / update CLI hooks' : 'Install CLI hooks';

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; }
  body {
    font-family: var(--vscode-font-family);
    font-size: 12px;
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background);
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    min-height: 100%;
    user-select: none;
  }

  .scroll-region {
    flex: 1 1 0;
    min-height: 0;
    overflow-y: auto;
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .bottom-stick {
    flex-shrink: 0;
    padding: 10px 14px 12px;
    border-top: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.28));
    background: var(--vscode-sideBar-background);
  }

  .banner {
    display: flex;
    gap: 10px;
    align-items: flex-start;
    padding: 10px 12px;
    border-radius: 8px;
    border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.25));
    background: var(--vscode-editor-inactiveSelectionBackground, rgba(128,128,128,0.08));
  }
  .banner-run .banner-icon { color: var(--vscode-charts-yellow, #cca700); font-size: 16px; line-height: 1.2; }
  .banner-err {
    border-color: var(--vscode-inputValidation-errorBorder, rgba(241,76,76,0.45));
    background: var(--vscode-inputValidation-errorBackground, rgba(241,76,76,0.08));
  }
  .banner-err .banner-icon { color: var(--vscode-errorForeground, #f14c4c); }
  .banner-title { font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.85; }
  .banner-detail { margin-top: 4px; font-size: 12px; line-height: 1.45; opacity: 0.95; word-break: break-word; }

  .section-title {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    opacity: 0.75;
    margin-bottom: 6px;
  }
  .badge {
    font-size: 11px;
    font-weight: 700;
    padding: 2px 8px;
    border-radius: 10px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
  }

  /* Tree: mimic workbench file explorer (codicons + row layout; still HTML, not native widget) */
  .file-tree {
    display: flex;
    flex-direction: column;
    font-size: 13px;
    line-height: 22px;
    color: var(--vscode-sideBar-foreground, var(--vscode-foreground));
  }
  .tree-node { outline: none; }
  .tree-node > .tree-row-folder {
    list-style: none;
    cursor: pointer;
  }
  .tree-node > .tree-row-folder::-webkit-details-marker { display: none; }
  .tree-node > .tree-row-folder::marker { content: ''; }

  .tree-row {
    display: flex;
    align-items: center;
    min-height: 22px;
    padding: 1px 4px;
    margin: 0;
    border: none;
    border-radius: 2px;
    background: transparent;
    font-family: inherit;
    font-size: 13px;
    line-height: 22px;
    color: inherit;
    text-align: left;
    cursor: pointer;
    width: 100%;
    box-sizing: border-box;
  }
  .tree-row:hover {
    background: var(--vscode-list-hoverBackground);
  }
  .tree-row:focus-visible {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: -1px;
  }

  .tree-twist {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    flex-shrink: 0;
    margin-right: 1px;
    color: var(--vscode-icon-foreground);
    opacity: 0.9;
  }
  .tree-twist-file {
    flex-shrink: 0;
    width: 16px;
    height: 16px;
    margin-right: 1px;
  }

  .tree-node:not([open]) .tree-chev-open { display: none !important; }
  .tree-node[open] .tree-chev-closed { display: none !important; }
  .tree-node:not([open]) .tree-ico-open { display: none !important; }
  .tree-node[open] .tree-ico-closed { display: none !important; }

  .tree-ico-slot {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    flex-shrink: 0;
    margin-right: 4px;
    color: var(--vscode-icon-foreground);
  }
  .tree-row-file .tree-ico-slot {
    opacity: 0.92;
  }

  .tree-label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tree-row-folder .tree-label {
    font-weight: 400;
  }

  .tree-row-file { gap: 4px; cursor: default; }
  .tree-row-file .tree-label { cursor: default; }

  .row-open-actions {
    display: none;
    gap: 4px;
    flex-shrink: 0;
    margin-left: 6px;
  }
  .tree-row-file:hover .row-open-actions,
  .tree-row-file:focus-within .row-open-actions { display: inline-flex; }

  .btn-open {
    font-family: inherit;
    font-size: 10px;
    font-weight: 500;
    padding: 2px 8px;
    min-width: 64px;
    border-radius: 3px;
    border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.3));
    background: var(--vscode-button-secondaryBackground, transparent);
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    cursor: pointer;
    line-height: 1.2;
    white-space: nowrap;
    transition: filter 0.12s;
  }
  .btn-open:hover { filter: brightness(1.15); }
  .btn-open-diff {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border-color: var(--vscode-button-background);
  }

  .row-actions {
    display: none;
    flex-shrink: 0;
    gap: 2px;
  }
  .tree-row-file:hover .row-actions,
  .tree-row-file:focus-within .row-actions { display: inline-flex; }
  .row-action {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    padding: 0;
    border: none;
    background: transparent;
    color: var(--vscode-icon-foreground);
    cursor: pointer;
    border-radius: 3px;
    font-size: 12px;
    line-height: 1;
  }
  .row-action:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.2)); }
  .row-action.accept:hover { color: var(--vscode-testing-iconPassed, #73c991); }
  .row-action.revert:hover { color: var(--vscode-errorForeground, #f14c4c); }

  .tree-children {
    display: block;
  }

  .empty-pending { font-size: 12px; opacity: 0.45; font-style: italic; padding: 8px 0; }

  .btn-install {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    width: 100%;
    padding: 10px 14px;
    border-radius: 8px;
    border: none;
    cursor: pointer;
    font-family: inherit;
    font-size: 12px;
    font-weight: 600;
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
    transition: filter 0.12s;
  }
  .btn-install:hover { filter: brightness(1.08); }
  .btn-install:active { filter: brightness(0.95); }

  .footer-note { font-size: 10px; opacity: 0.4; line-height: 1.35; margin-top: 8px; }

  .hook-status {
    font-size: 11px;
    line-height: 1.45;
    padding: 8px 10px;
    border-radius: 6px;
    border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.25));
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
  }
  .hook-status-text { flex: 1; min-width: 0; }
  .hook-version {
    flex-shrink: 0;
    font-size: 10px;
    opacity: 0.6;
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.02em;
    padding: 1px 6px;
    border-radius: 4px;
    border: 1px solid currentColor;
  }
  .hook-ok {
    color: var(--vscode-testing-iconPassed, #73c991);
    background: rgba(115, 201, 145, 0.08);
    border-color: var(--vscode-testing-iconPassed, rgba(115,201,145,0.35));
  }
  .hook-no { opacity: 0.9; }
  .hook-warn {
    color: var(--vscode-editorWarning-foreground, #cca700);
    background: rgba(204, 167, 0, 0.08);
  }
  .bottom-stick .hook-status {
    margin-top: 12px;
    margin-bottom: 0;
  }

  .bulk-actions {
    display: flex;
    gap: 6px;
    margin-bottom: 6px;
  }
  .btn-bulk {
    flex: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 6px 8px;
    font-family: inherit;
    font-size: 11px;
    font-weight: 600;
    line-height: 1.2;
    border-radius: 4px;
    border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.3));
    cursor: pointer;
    background: var(--vscode-button-secondaryBackground, transparent);
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    transition: filter 0.12s, background 0.12s;
  }
  .btn-bulk:hover { filter: brightness(1.12); }
  .btn-bulk-accept {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border-color: var(--vscode-button-background);
  }
  .btn-bulk-revert {
    color: var(--vscode-errorForeground, #f14c4c);
    border-color: var(--vscode-inputValidation-errorBorder, rgba(241,76,76,0.45));
  }
  .btn-bulk-revert:hover {
    background: rgba(241,76,76,0.12);
  }
  .btn-bulk-ico { font-size: 11px; line-height: 1; }

  .setting-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    border-radius: 6px;
    border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.25));
    margin-bottom: 8px;
    cursor: pointer;
  }
  .setting-text { flex: 1; min-width: 0; }
  .setting-title { font-size: 12px; font-weight: 600; }
  .setting-detail { font-size: 10px; opacity: 0.6; margin-top: 2px; line-height: 1.35; }
  .toggle {
    flex-shrink: 0;
    position: relative;
    width: 30px;
    height: 16px;
    border-radius: 999px;
    border: none;
    padding: 0;
    cursor: pointer;
    transition: background 0.15s;
  }
  .toggle-off { background: var(--vscode-input-background, rgba(128,128,128,0.35)); }
  .toggle-on { background: var(--vscode-button-background); }
  .toggle-knob {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 12px;
    height: 12px;
    background: var(--vscode-button-foreground, #fff);
    border-radius: 50%;
    transition: left 0.15s;
  }
  .toggle-on .toggle-knob { left: 16px; }

  .mode-toggle {
    display: flex;
    gap: 2px;
    padding: 2px;
    border-radius: 6px;
    background: var(--vscode-editor-inactiveSelectionBackground, rgba(128,128,128,0.12));
    border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.25));
  }
  .mode-btn {
    flex: 1;
    padding: 5px 8px;
    font-family: inherit;
    font-size: 11px;
    font-weight: 600;
    line-height: 1.2;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    background: transparent;
    color: var(--vscode-foreground);
    opacity: 0.7;
    transition: background 0.12s, opacity 0.12s;
  }
  .mode-btn:hover { opacity: 1; }
  .mode-btn.mode-active {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    opacity: 1;
  }
</style>
</head>
<body>
  <div class="scroll-region">
    ${modeToggleHtml}
    ${statusHtml}
    <div class="section">
      ${pendingBlock}
    </div>
  </div>
  <div class="bottom-stick">
    ${isGit ? '' : autoOpenToggleHtml}
    <button type="button" class="btn-install" id="btn-install" title="Write hooks to ~/.claude/settings.json">
      ${escapeHtml(installLabel)}
    </button>
    <p class="footer-note">Best with Claude, Codex, and Qwen. Hook install currently targets Claude.</p>
    ${hookStatusHtml}
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    (function bindFileTree() {
      var el = document.getElementById('file-tree');
      if (!el) return;
      el.querySelectorAll('.tree-row-file').forEach(function (row) {
        var p = row.getAttribute('data-path');
        row.querySelectorAll('.btn-open').forEach(function (btn) {
          btn.addEventListener('click', function (ev) {
            ev.stopPropagation();
            if (!p) return;
            var act = btn.getAttribute('data-action');
            if (act === 'openFile') vscode.postMessage({ command: 'openFilePlain', path: p });
            else if (act === 'openDiff') vscode.postMessage({ command: 'openFile', path: p });
          });
        });
        row.querySelectorAll('.row-action').forEach(function (btn) {
          btn.addEventListener('click', function (ev) {
            ev.stopPropagation();
            var act = btn.getAttribute('data-action');
            if (!p || !act) return;
            vscode.postMessage({ command: act === 'accept' ? 'acceptFile' : 'revertFile', path: p });
          });
        });
      });
    })();
    var acceptAllBtn = document.getElementById('btn-accept-all');
    if (acceptAllBtn) {
      acceptAllBtn.addEventListener('click', function () { vscode.postMessage({ command: 'acceptAll' }); });
    }
    var revertAllBtn = document.getElementById('btn-revert-all');
    if (revertAllBtn) {
      revertAllBtn.addEventListener('click', function () { vscode.postMessage({ command: 'revertAll' }); });
    }
    var toggleAutoOpen = document.getElementById('toggle-auto-open');
    if (toggleAutoOpen) {
      toggleAutoOpen.addEventListener('click', function () { vscode.postMessage({ command: 'toggleAutoOpen' }); });
    }
    var settingRow = document.getElementById('setting-auto-open');
    if (settingRow) {
      settingRow.addEventListener('click', function (ev) {
        if (ev.target && ev.target.id === 'toggle-auto-open') return;
        vscode.postMessage({ command: 'toggleAutoOpen' });
      });
    }
    document.getElementById('btn-install').addEventListener('click', function () {
      vscode.postMessage({ command: 'installHooks' });
    });
    document.querySelectorAll('.mode-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var m = btn.getAttribute('data-mode');
        if (m) vscode.postMessage({ command: 'switchMode', mode: m });
      });
    });
  </script>
</body>
</html>`;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

interface DirBuild {
  subdirs: Map<string, DirBuild>;
  files: Array<{ name: string; path: string }>;
}

interface TreeJson {
  dirs: Array<{ name: string; tree: TreeJson }>;
  files: Array<{ name: string; path: string }>;
}

function workspaceFolderContaining(absPath: string): vscode.WorkspaceFolder | undefined {
  const norm = path.normalize(absPath);
  for (const f of vscode.workspace.workspaceFolders ?? []) {
    const root = path.normalize(f.uri.fsPath);
    const rel = path.relative(root, norm);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
      return f;
    }
  }
  return undefined;
}

function commonPathPrefix(fullPaths: string[]): string {
  if (fullPaths.length === 0) {
    return '';
  }
  const split = fullPaths.map((p) =>
    path.normalize(p).split(path.sep).filter((s) => s.length > 0)
  );
  const first = split[0]!;
  let len = first.length;
  for (let i = 1; i < split.length; i++) {
    const row = split[i]!;
    let j = 0;
    while (j < len && j < row.length && first[j]!.toLowerCase() === row[j]!.toLowerCase()) {
      j++;
    }
    len = j;
  }
  if (len === 0) {
    return '';
  }
  return path.join(...first.slice(0, len));
}

function outsideBaseForOrphans(orphans: string[]): string {
  if (orphans.length === 0) {
    return '';
  }
  if (orphans.length === 1) {
    return path.dirname(path.normalize(orphans[0]!));
  }
  return commonPathPrefix(orphans.map((p) => path.normalize(p)));
}

function addToTree(root: DirBuild, parts: string[], absPath: string): void {
  if (parts.length === 1) {
    root.files.push({ name: parts[0]!, path: absPath });
    return;
  }
  const head = parts[0]!;
  const tail = parts.slice(1);
  let sub = root.subdirs.get(head);
  if (!sub) {
    sub = { subdirs: new Map(), files: [] };
    root.subdirs.set(head, sub);
  }
  addToTree(sub, tail, absPath);
}

function dirBuildToJson(db: DirBuild): TreeJson {
  const dirs = [...db.subdirs.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, sub]) => ({ name, tree: dirBuildToJson(sub) }));
  const files = [...db.files].sort((a, b) => a.name.localeCompare(b.name));
  return { dirs, files };
}

function buildPendingTreeModel(pending: string[]): TreeJson {
  const root: DirBuild = { subdirs: new Map(), files: [] };
  const folders = vscode.workspace.workspaceFolders ?? [];
  const orphans = pending.filter((p) => !workspaceFolderContaining(p));
  const outsideBase = outsideBaseForOrphans(orphans);

  for (const absPath of pending) {
    const wf = workspaceFolderContaining(absPath);
    let parts: string[];
    if (wf) {
      const rel = path.relative(wf.uri.fsPath, path.normalize(absPath));
      const segments = rel.split(/[/\\]/).filter(Boolean);
      parts = folders.length > 1 ? [wf.name, ...segments] : segments;
    } else {
      const rel = path.relative(outsideBase, path.normalize(absPath));
      parts = rel.split(/[/\\]/).filter(Boolean).filter((seg) => seg !== '.' && seg !== '..');
      if (parts.length === 0) {
        parts = [path.basename(absPath)];
      }
    }
    if (parts.length) {
      addToTree(root, parts, absPath);
    }
  }
  return dirBuildToJson(root);
}

/** Map extension → material-icon-theme icon name. */
const EXT_ICON: Record<string, string> = {
  ts: 'typescript', tsx: 'react_ts',
  js: 'javascript', jsx: 'react',  mjs: 'javascript', cjs: 'javascript',
  css: 'css', scss: 'sass', sass: 'sass', less: 'less',
  html: 'html', htm: 'html',
  json: 'json', jsonc: 'json',
  md: 'markdown', mdx: 'markdown',
  py: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  kt: 'kotlin', kts: 'kotlin',
  rb: 'ruby',
  php: 'php',
  c: 'c', cc: 'cpp', cpp: 'cpp', h: 'h', hpp: 'hpp',
  cs: 'csharp',
  sh: 'console', bash: 'console',
  yaml: 'yaml', yml: 'yaml',
  toml: 'toml',
  xml: 'xml',
  svg: 'svg',
  vue: 'vue',
  svelte: 'svelte',
  prisma: 'prisma',
  graphql: 'graphql',
  dockerfile: 'docker',
  env: 'document',
  gitignore: 'git',
  lock: 'lock',
  sql: 'database',
  zip: 'zip', gz: 'zip', tar: 'zip',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', ico: 'image',
  pdf: 'pdf',
  txt: 'document',
};

function fileIconImg(fileName: string, iconBase: string): string {
  const ext = fileName.includes('.') ? fileName.split('.').pop()!.toLowerCase() : '';
  const iconName = EXT_ICON[ext] ?? 'file';
  const src = escapeAttr(`${iconBase}${iconName}.svg`);
  return `<img src="${src}" width="16" height="16" aria-hidden="true" style="flex-shrink:0;display:block;">`;
}

function folderImg(open: boolean, iconBase: string): string {
  const name = open ? 'folder-open' : 'folder';
  const src = escapeAttr(`${iconBase}${name}.svg`);
  return `<img src="${src}" width="16" height="16" aria-hidden="true" style="flex-shrink:0;display:block;">`;
}

function chevronSvg(down: boolean): string {
  return down
    ? `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`
    : `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`;
}

function renderPendingTreeHtml(node: TreeJson, depth: number, iconBase: string, mode: ViewMode): string {
  const isGit = mode === 'git';
  const acceptTitle = isGit ? 'Mark as reviewed (hide from list)' : 'Accept all changes in this file';
  const acceptLabel = isGit ? 'Mark reviewed' : 'Accept';
  const revertTitle = isGit ? 'Discard changes (restore to HEAD)' : 'Revert all changes in this file';
  const revertLabel = isGit ? 'Discard' : 'Revert';
  const indentPx = 2 + depth * 8;
  const chunks: string[] = [];
  for (const d of node.dirs) {
    const inner = renderPendingTreeHtml(d.tree, depth + 1, iconBase, mode);
    chunks.push(
      `<details class="tree-node" open>` +
        `<summary class="tree-row tree-row-folder" style="padding-left:${indentPx}px">` +
        `<span class="tree-twist tree-chev-open">${chevronSvg(true)}</span>` +
        `<span class="tree-twist tree-chev-closed" style="display:none">${chevronSvg(false)}</span>` +
        `<span class="tree-ico-slot tree-ico-open">${folderImg(true, iconBase)}</span>` +
        `<span class="tree-ico-slot tree-ico-closed" style="display:none">${folderImg(false, iconBase)}</span>` +
        `<span class="tree-label">${escapeHtml(d.name)}</span>` +
        `</summary>` +
        `<div class="tree-children">${inner}</div>` +
        `</details>`
    );
  }
  for (const f of node.files) {
    chunks.push(
      `<div class="tree-row tree-row-file" data-path="${escapeAttr(f.path)}" style="padding-left:${indentPx}px" tabindex="0">` +
        `<span class="tree-twist tree-twist-file" aria-hidden="true"></span>` +
        `<span class="tree-ico-slot">${fileIconImg(f.name, iconBase)}</span>` +
        `<span class="tree-label">${escapeHtml(f.name)}</span>` +
        `<span class="row-open-actions">` +
        `<button type="button" class="btn-open btn-open-file" data-action="openFile" title="Open file in a normal editor (no diff)">Open file</button>` +
        `<button type="button" class="btn-open btn-open-diff" data-action="openDiff" title="Open split-view diff editor">Open diff</button>` +
        `</span>` +
        `<span class="row-actions">` +
        `<button type="button" class="row-action accept" data-action="accept" title="${escapeAttr(acceptTitle)}" aria-label="${escapeAttr(acceptLabel)}">&#10003;</button>` +
        `<button type="button" class="row-action revert" data-action="revert" title="${escapeAttr(revertTitle)}" aria-label="${escapeAttr(revertLabel)}">&#10007;</button>` +
        `</span>` +
        `</div>`
    );
  }
  return chunks.join('');
}
