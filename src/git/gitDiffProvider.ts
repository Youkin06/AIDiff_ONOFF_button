/**
 * gitDiffProvider.ts
 *
 * Nguồn dữ liệu cho chế độ "Git Diff": liệt kê các file khác với HEAD,
 * cung cấp nội dung HEAD qua content provider (scheme `ai-git-diff`),
 * và hỗ trợ discard (git checkout) + mark-as-reviewed.
 *
 * Không đụng tới DiffManager/snapshot của chế độ AI — baseline ở đây luôn là HEAD.
 */

import { execFile } from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';

export const GIT_DIFF_SCHEME = 'ai-git-diff';

function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(stdout);
    });
  });
}

function normalizePath(filePath: string): string {
  const fsPath = vscode.Uri.file(path.resolve(filePath)).fsPath;
  return process.platform === 'win32' ? fsPath.toLowerCase() : fsPath;
}

/** Chuyển absolute path -> relative POSIX path so với repo root (git luôn dùng `/`). */
function toGitRelPath(root: string, absPath: string): string {
  return path.relative(root, absPath).split(path.sep).join('/');
}

export interface GitStatus {
  hasRepo: boolean;
  files: string[];
}

export class GitDiffProvider {
  private _onDidChange = new vscode.EventEmitter<void>();
  public readonly onDidChange = this._onDidChange.event;

  public readonly contentProviderEventEmitter = new vscode.EventEmitter<vscode.Uri>();

  /** File user đã "mark reviewed" — ẩn khỏi list cho tới khi nó thay đổi lại. */
  private reviewed = new Set<string>();

  /** Cache repo root cho mỗi workspace folder (null = không phải git repo). */
  private repoRootCache = new Map<string, string | null>();

  private watcher?: vscode.FileSystemWatcher;
  private queryCounter = 0;

  constructor(private readonly context: vscode.ExtensionContext) {
    context.subscriptions.push(
      vscode.workspace.registerTextDocumentContentProvider(GIT_DIFF_SCHEME, {
        onDidChange: this.contentProviderEventEmitter.event,
        provideTextDocumentContent: async (uri: vscode.Uri) => {
          const realPath = uri.with({ scheme: 'file', query: '' }).fsPath;
          return (await this.getHeadContent(realPath)) ?? '';
        },
      })
    );
  }

  start(): void {
    this.watcher = vscode.workspace.createFileSystemWatcher('**/*');
    const onFsEvent = (uri: vscode.Uri): void => {
      // File thay đổi -> bỏ trạng thái "reviewed" để nó xuất hiện lại nếu vẫn khác HEAD.
      this.reviewed.delete(normalizePath(uri.fsPath));
      this._onDidChange.fire();
    };
    this.watcher.onDidChange(onFsEvent);
    this.watcher.onDidCreate(onFsEvent);
    this.watcher.onDidDelete(onFsEvent);
    this.context.subscriptions.push(this.watcher);
  }

  dispose(): void {
    this.watcher?.dispose();
    this._onDidChange.dispose();
    this.contentProviderEventEmitter.dispose();
  }

  // ---- Public API ----

  /** URI dùng cho phần "Original" (HEAD) của vscode.diff. */
  buildOriginalUri(absPath: string): vscode.Uri {
    return vscode.Uri.file(absPath).with({
      scheme: GIT_DIFF_SCHEME,
      query: String(++this.queryCounter),
    });
  }

  /** Trạng thái git hiện tại: có repo hay không + danh sách file khác HEAD (đã lọc reviewed). */
  async getStatus(): Promise<GitStatus> {
    const roots = await this.collectRepoRoots();
    if (roots.length === 0) {
      return { hasRepo: false, files: [] };
    }

    const result = new Set<string>();
    for (const root of roots) {
      try {
        const out = await runGit(
          ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
          root
        );
        for (const abs of parsePorcelainZ(out, root)) {
          result.add(abs);
        }
      } catch {
        // repo lỗi/đang trong trạng thái bất thường — bỏ qua root này.
      }
    }

    const files = Array.from(result).filter((p) => !this.reviewed.has(normalizePath(p)));
    return { hasRepo: true, files };
  }

  /** Nội dung phiên bản HEAD của file. Trả '' cho file untracked/mới (baseline rỗng). */
  async getHeadContent(absPath: string): Promise<string | undefined> {
    const root = await this.findRootForPath(absPath);
    if (!root) {
      return undefined;
    }
    const rel = toGitRelPath(root, absPath);
    try {
      return await runGit(['show', `HEAD:${rel}`], root);
    } catch {
      return '';
    }
  }

  /** Discard thay đổi của file về HEAD (git checkout); xóa file nếu nó untracked. */
  async discard(absPath: string): Promise<void> {
    const root = await this.findRootForPath(absPath);
    if (!root) {
      throw new Error('Not a git repository');
    }
    const rel = toGitRelPath(root, absPath);

    let trackedAtHead = true;
    try {
      await runGit(['cat-file', '-e', `HEAD:${rel}`], root);
    } catch {
      trackedAtHead = false;
    }

    // Nếu file đang mở và dirty, hoàn tác buffer trước để tránh xung đột reload.
    const openDoc = vscode.workspace.textDocuments.find(
      (d) => normalizePath(d.uri.fsPath) === normalizePath(absPath)
    );

    if (trackedAtHead) {
      await runGit(['checkout', 'HEAD', '--', rel], root);
      if (openDoc) {
        try {
          await vscode.commands.executeCommand('workbench.action.files.revert', openDoc.uri);
        } catch {
          // ignore
        }
      }
    } else {
      try {
        await vscode.workspace.fs.delete(vscode.Uri.file(absPath));
      } catch {
        // ignore
      }
    }

    this.reviewed.delete(normalizePath(absPath));
    this._onDidChange.fire();
  }

  /** Đánh dấu file là "đã review" — ẩn khỏi list cho tới khi nó thay đổi tiếp. */
  markReviewed(absPath: string): void {
    this.reviewed.add(normalizePath(absPath));
    this._onDidChange.fire();
  }

  markAllReviewed(absPaths: string[]): void {
    for (const p of absPaths) {
      this.reviewed.add(normalizePath(p));
    }
    this._onDidChange.fire();
  }

  // ---- Private helpers ----

  private async collectRepoRoots(): Promise<string[]> {
    const roots = new Set<string>();
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const root = await this.repoRootFor(folder.uri.fsPath);
      if (root) {
        roots.add(root);
      }
    }
    return Array.from(roots);
  }

  private async repoRootFor(folder: string): Promise<string | null> {
    if (this.repoRootCache.has(folder)) {
      return this.repoRootCache.get(folder)!;
    }
    let root: string | null = null;
    try {
      const out = (await runGit(['rev-parse', '--show-toplevel'], folder)).trim();
      root = out.length > 0 ? out : null;
    } catch {
      root = null;
    }
    this.repoRootCache.set(folder, root);
    return root;
  }

  private async findRootForPath(absPath: string): Promise<string | null> {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const root = await this.repoRootFor(folder.uri.fsPath);
      if (root && !path.relative(root, absPath).startsWith('..')) {
        return root;
      }
    }
    // Fallback: hỏi git trực tiếp từ thư mục chứa file.
    try {
      const out = (await runGit(['rev-parse', '--show-toplevel'], path.dirname(absPath))).trim();
      return out.length > 0 ? out : null;
    } catch {
      return null;
    }
  }
}

/**
 * Parse output của `git status --porcelain=v1 -z`.
 * Mỗi record: "XY <path>" phân tách bằng NUL. Record rename/copy (R/C) có thêm
 * một field NUL nữa chứa path cũ — ta lấy path mới và bỏ qua field kế tiếp.
 */
function parsePorcelainZ(out: string, root: string): string[] {
  const parts = out.split('\0');
  const files: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry || entry.length < 4) {
      continue;
    }
    const xy = entry.slice(0, 2);
    if (xy === '!!') {
      continue; // ignored
    }
    const relPath = entry.slice(3);
    if (xy[0] === 'R' || xy[0] === 'C') {
      i++; // bỏ qua field path cũ của rename/copy
    }
    if (relPath) {
      files.push(path.resolve(root, relPath));
    }
  }
  return files;
}
