import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { DiffManager } from '../diff/diffManager';
import { SessionPanelProvider } from '../views/sessionPanel';
import { IAiRunner } from '../claude/aiRunner';
import { createRunner } from '../claude/runnerFactory';

export interface CommandDeps {
  diffManager: DiffManager;
  sessionPanel: SessionPanelProvider;
  context: vscode.ExtensionContext;
  getRunner(): IAiRunner | undefined;
  setRunner(runner: IAiRunner): void;
}

export function registerAllCommands(deps: CommandDeps): void {
  const { diffManager, sessionPanel, context } = deps;

  function getActiveDiffFilePath(): string | undefined {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      const filePath = editor.document.uri.fsPath;
      if (diffManager.renderer.hasPending(filePath)) {
        return filePath;
      }
    }
    return diffManager.getPendingFiles()[0];
  }

  async function ensureRunner(): Promise<IAiRunner | undefined> {
    if (deps.getRunner()) {
      return deps.getRunner();
    }

    try {
      const result = await createRunner(diffManager);
      deps.setRunner(result.runner);
      return result.runner;
    } catch (err: unknown) {
      vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
      return undefined;
    }
  }

  async function pickHunk(filePath: string, action: string): Promise<string | undefined> {
    const hunks = diffManager.renderer.getHunks(filePath);
    if (hunks.length === 0) {
      return undefined;
    }
    if (hunks.length === 1) {
      return hunks[0]!.id;
    }

    const items = hunks.map((h, i) => ({
      label: `Hunk ${i + 1}`,
      description: `${h.removedLines.length} removed, ${h.addedLines.length} added`,
      id: h.id,
    }));
    const picked = await vscode.window.showQuickPick(items, { title: `${action} which hunk?` });
    return picked?.id;
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('ai-cli-diff-view.startSession', async () => {
      const workingDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
      const runner = await ensureRunner();
      if (!runner) {
        return;
      }

      const toolLabel = runner.toolName.charAt(0).toUpperCase() + runner.toolName.slice(1);
      const prompt = await vscode.window.showInputBox({
        title: `AI CLI Diff: Start ${toolLabel} Session`,
        prompt: `Enter a prompt for ${toolLabel}`,
        placeHolder: 'e.g. "Add JSDoc comments to all functions"',
        ignoreFocusOut: true,
      });
      if (!prompt) {
        return;
      }

      sessionPanel.setRunning(prompt);
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `AI CLI Diff (${toolLabel})`, cancellable: false },
        async (progress) => {
          progress.report({ message: 'Starting session...' });
          const onProgress = (step: string): void => {
            progress.report({ message: step });
          };

          try {
            await runner.run(prompt, workingDir, () => {}, onProgress);
            sessionPanel.setIdle();
            vscode.window.showInformationMessage(`${toolLabel} session complete.`);
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            sessionPanel.setError(message);
            vscode.window.showErrorMessage(`${toolLabel} session failed: ${message}`);
          }
        }
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('ai-cli-diff-view.openPendingFile', async (filePath?: string) => {
      if (!filePath || typeof filePath !== 'string') {
        return;
      }

      try {
        // Manual user action — always show the split-view diff regardless of the auto-open setting.
        await diffManager.openDiff(filePath, true);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`AI Diff: could not open file - ${message}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('ai-cli-diff-view.openPendingFilePlain', async (filePath?: string) => {
      if (!filePath || typeof filePath !== 'string') {
        return;
      }

      try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
        await vscode.window.showTextDocument(doc, { preview: false });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`AI Diff: could not open file - ${message}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('ai-cli-diff-view.acceptAllHunks', async () => {
      const filePath = getActiveDiffFilePath();
      if (!filePath) {
        vscode.window.showWarningMessage('No active inline diff.');
        return;
      }
      await diffManager.accept(filePath);
      vscode.window.showInformationMessage(`Accepted all changes: ${path.basename(filePath)}`);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('ai-cli-diff-view.acceptAllChanges', async () => {
      const total = await diffManager.acceptAllPending();
      if (total === 0) {
        vscode.window.showWarningMessage('No pending changes to accept.');
        return;
      }
      vscode.window.showInformationMessage(`Accepted all changes in ${total} file(s).`);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('ai-cli-diff-view.revertAllHunks', async () => {
      const filePath = getActiveDiffFilePath();
      if (!filePath) {
        vscode.window.showWarningMessage('No active inline diff.');
        return;
      }
      await diffManager.revert(filePath);
      vscode.window.showInformationMessage(`Reverted all changes: ${path.basename(filePath)}`);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('ai-cli-diff-view.acceptHunk', async (filePath?: string, hunkId?: string) => {
      const targetPath = filePath ?? getActiveDiffFilePath();
      if (!targetPath) {
        vscode.window.showWarningMessage('No active inline diff.');
        return;
      }
      const resolvedHunkId = hunkId ?? (await pickHunk(targetPath, 'Accept'));
      if (!resolvedHunkId) {
        return;
      }
      await diffManager.acceptHunk(targetPath, resolvedHunkId);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('ai-cli-diff-view.revertHunk', async (filePath?: string, hunkId?: string) => {
      const targetPath = filePath ?? getActiveDiffFilePath();
      if (!targetPath) {
        vscode.window.showWarningMessage('No active inline diff.');
        return;
      }
      const resolvedHunkId = hunkId ?? (await pickHunk(targetPath, 'Revert'));
      if (!resolvedHunkId) {
        return;
      }
      await diffManager.revertHunk(targetPath, resolvedHunkId);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('ai-cli-diff-view.installHooks', async () => {
      const extensionPath = context.extensionUri.fsPath;
      const preHook = path.join(extensionPath, 'hooks', 'pre-tool-hook.js');
      const postHook = path.join(extensionPath, 'hooks', 'post-tool-hook.js');
      const runner = await ensureRunner();
      if (!runner) {
        return;
      }

      const settingsPath = runner.getSettingsFilePath();
      const settingsDir = path.dirname(settingsPath);
      const matcher = runner.getFileEditToolNames().join('|');
      const toolLabel = runner.toolName.charAt(0).toUpperCase() + runner.toolName.slice(1);

      let settings: Record<string, unknown> = {};
      try {
        const raw = fs.readFileSync(settingsPath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          settings = parsed as Record<string, unknown>;
        }
      } catch {
        // Missing or invalid settings — start from an empty object.
      }

      const existingHooks =
        settings['hooks'] && typeof settings['hooks'] === 'object' && !Array.isArray(settings['hooks'])
          ? { ...(settings['hooks'] as Record<string, unknown>) }
          : {};

      existingHooks['PreToolUse'] = mergePhase(
        existingHooks['PreToolUse'],
        matcher,
        `node "${preHook}"`,
        ['pre-tool-hook.js']
      );
      existingHooks['PostToolUse'] = mergePhase(
        existingHooks['PostToolUse'],
        matcher,
        `node "${postHook}"`,
        ['post-tool-hook.js']
      );

      settings['hooks'] = existingHooks;

      if (!fs.existsSync(settingsDir)) {
        fs.mkdirSync(settingsDir, { recursive: true });
      }
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
      sessionPanel.refresh();
      vscode.window.showInformationMessage(
        `${toolLabel} hooks installed. AI CLI Diff will now track \`${runner.toolName}\` edits from any terminal.`
      );
    })
  );
}

/**
 * Merge our hook block into one PreToolUse/PostToolUse phase array, preserving
 * any unrelated entries already there. Existing entries that reference any of
 * `ourHookFilenames` (i.e. previous installs of this extension, possibly from
 * a different path) are stripped before our fresh block is appended.
 */
function mergePhase(
  existingPhase: unknown,
  matcher: string,
  ourCommand: string,
  ourHookFilenames: readonly string[]
): unknown[] {
  const source = Array.isArray(existingPhase) ? existingPhase : [];
  const cleaned: unknown[] = [];

  for (const block of source) {
    if (!block || typeof block !== 'object') {
      cleaned.push(block);
      continue;
    }
    const blockObj = block as Record<string, unknown>;
    const innerHooks = blockObj['hooks'];
    if (!Array.isArray(innerHooks)) {
      cleaned.push(block);
      continue;
    }
    const filteredInner = innerHooks.filter((h) => !isOurHookEntry(h, ourHookFilenames));
    if (filteredInner.length === 0) {
      // Whole block belonged to us — drop it.
      continue;
    }
    cleaned.push({ ...blockObj, hooks: filteredInner });
  }

  cleaned.push({
    matcher,
    hooks: [{ type: 'command', command: ourCommand }],
  });
  return cleaned;
}

function isOurHookEntry(entry: unknown, ourHookFilenames: readonly string[]): boolean {
  if (!entry || typeof entry !== 'object') {
    return false;
  }
  const cmd = (entry as { command?: unknown }).command;
  if (typeof cmd !== 'string') {
    return false;
  }
  const lower = cmd.toLowerCase();
  return ourHookFilenames.some((name) => lower.includes(name.toLowerCase()));
}
