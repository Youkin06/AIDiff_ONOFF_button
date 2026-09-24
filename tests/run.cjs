const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
fs.mkdirSync(path.join(root, '.vscode-test'), { recursive: true });
// macOS Unix-domain sockets have a short path limit.
const runDir = fs.realpathSync(fs.mkdtempSync('/tmp/ai-diff-test-'));
const workspace = path.join(runDir, 'workspace');
fs.mkdirSync(workspace);
fs.mkdirSync(path.join(runDir, 'extensions'));
fs.writeFileSync(path.join(workspace, 'sample.txt'), 'baseline\n');
fs.mkdirSync(path.join(workspace, 'Builds'));
fs.writeFileSync(path.join(workspace, 'Builds', 'generated.cpp'), 'generated baseline');
fs.writeFileSync(path.join(workspace, 'large.txt'), Buffer.alloc(3 * 1024 * 1024, 65));
const executable = process.env.VSCODE_EXECUTABLE || '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
for (let phase = 0; phase < 2; phase++) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(executable, [
    '--user-data-dir', path.join(runDir, 'user-data'),
    '--extensions-dir', path.join(runDir, 'extensions'),
    '--extensionDevelopmentPath', root,
    '--extensionDevelopmentPath', path.join(root, 'tests', 'driver'),
    '--skip-welcome', '--skip-release-notes', '--disable-updates',
    '--disable-workspace-trust', workspace,
  ], { env, stdio: 'inherit', timeout: 90000 });
  if (result.status !== 0) {
    console.error(result.error || `Extension Host failed: ${result.status}`);
    process.exit(1);
  }
  const report = JSON.parse(fs.readFileSync(path.join(workspace, '.driver-result.json'), 'utf8'));
  if (!report.passed) { console.error(report.error); process.exit(1); }
  console.log(`Extension Host phase ${phase + 1} passed`);
}
