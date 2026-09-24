const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vscode = require('vscode');

exports.run = async () => {
  const root = path.resolve(__dirname, '..');
  const managerModule = require('../out/diff/diffManager');
  const OriginalManager = managerModule.DiffManager;
  let manager;
  let context;
  managerModule.DiffManager = class extends OriginalManager {
    constructor(ctx) { super(ctx); manager = this; context = ctx; }
  };
  const extension = vscode.extensions.getExtension('mtglitch.ai-diff-viewer');
  assert.ok(extension && !extension.isActive, 'Test must intercept before startup activation');
  await extension.activate();
  assert.ok(manager, 'Extension activated with real VS Code context');
  const toggle = () => vscode.commands.executeCommand('ai-cli-diff-view.toggleMonitoring');
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (predicate, label) => {
    for (let i = 0; i < 100; i++) {
      if (predicate()) { return; }
      await sleep(100);
    }
    throw new Error(`Timed out: ${label}`);
  };
  const passed = [];
  const check = label => { passed.push(label); console.log(`PASS: ${label}`); };
  const folder = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const phaseFile = path.join(folder, '.test-phase');
  // Native recursive watchers are started asynchronously by the workbench.
  await sleep(2500);
  if (fs.existsSync(phaseFile)) {
    assert.equal(manager.monitoringEnabled, false);
    assert.equal(context.globalState.get('ai-cli-diff-view.monitoringEnabled'), false);
    check('OFF restored after real Extension Host restart');
    const file = path.join(folder, 'restart.txt');
    fs.writeFileSync(file, 'still disabled\n');
    await sleep(900);
    assert.equal(manager.hasPendingDiff(file), false);
    check('Restart while OFF does not generate diff');
    await toggle();
    fs.writeFileSync(file, 'enabled after restart\n');
    await until(() => manager.renderer.hasPending(file), 'resumed after restart');
    check('ON after restart resumes real filesystem watching');
    await manager.accept(file);
    fs.writeFileSync(path.join(root, '.vscode-test', 'restart-results.json'), JSON.stringify(passed, null, 2));
    return;
  }

  assert.equal(manager.monitoringEnabled, true);
  check('Default monitoring ON');
  const { FileSnapshotStore } = require('../out/watcher/fileSnapshotStore');
  const boundedStore = new FileSnapshotStore();
  boundedStore.buildInitialSnapshots(folder);
  assert.equal(boundedStore.has(path.join(folder, 'Builds', 'generated.cpp')), false);
  assert.equal(boundedStore.has(path.join(folder, 'large.txt')), false);
  assert.equal(boundedStore.has(path.join(folder, 'sample.txt')), true);
  fs.appendFileSync(path.join(folder, 'Builds', 'generated.cpp'), 'changed');
  fs.appendFileSync(path.join(folder, 'large.txt'), 'changed');
  await sleep(900);
  assert.equal(manager.hasPendingDiff(path.join(folder, 'Builds', 'generated.cpp')), false);
  assert.equal(manager.hasPendingDiff(path.join(folder, 'large.txt')), false);
  check('Unity generated output and files over 2 MiB excluded from scan and events');
  const file = path.join(folder, 'sample.txt');
  fs.writeFileSync(file, 'AI edit\n');
  await until(() => manager.renderer.hasPending(file), 'initial external edit');
  assert.equal(manager.getSnapshot(file), 'baseline\n');
  check('ON: real filesystem event creates inline hunks');
  await toggle();
  assert.equal(manager.monitoringEnabled, false);
  assert.equal(manager.renderer.hasPending(file), true);
  check('OFF preserves pending diff');
  await manager.accept(file);
  assert.equal(manager.hasPendingDiff(file), false);
  assert.equal(fs.readFileSync(file, 'utf8'), 'AI edit\n');
  check('Accept works while OFF without changing contents');

  fs.writeFileSync(file, 'manual external edit\n');
  const doc = await vscode.workspace.openTextDocument(file);
  await until(() => doc.getText() === 'manual external edit\n', 'external write reload before editor save');
  await vscode.window.showTextDocument(doc);
  const edit = new vscode.WorkspaceEdit();
  edit.insert(doc.uri, new vscode.Position(0, 0), 'manual editor edit\n');
  assert.equal(await vscode.workspace.applyEdit(edit), true);
  assert.equal(await doc.save(), true);
  await sleep(900);
  assert.equal(manager.hasPendingDiff(file), false);
  check('OFF: external writes, editor edits and saves create no diff; save succeeds');
  const baseline = doc.getText();
  await toggle();
  await sleep(700);
  assert.equal(manager.hasPendingDiff(file), false);
  fs.writeFileSync(file, 'next AI edit\n');
  await until(() => manager.renderer.hasPending(file), 'resumed external edit');
  assert.equal(manager.getSnapshot(file), baseline);
  check('Resume uses OFF-period edits as baseline; only next edit is diffed');
  await until(() => doc.getText() === 'next AI edit\n', 'document refreshed');
  await toggle();
  await manager.revert(file);
  assert.equal(doc.getText(), baseline);
  assert.equal(manager.hasPendingDiff(file), false);
  await doc.save();
  check('Revert works while OFF and restores baseline');

  // Deliver a watcher callback just before a fast OFF/ON transition.
  await toggle();
  const { WorkspaceWatcher } = require('../out/watcher/workspaceWatcher');
  const watcher = new WorkspaceWatcher(manager);
  watcher.start();
  const raceFile = path.join(folder, 'race.txt');
  fs.writeFileSync(raceFile, 'queued edit\n');
  watcher.handleExternalWrite(raceFile);
  await toggle();
  watcher.dispose();
  await toggle();
  await sleep(900);
  assert.equal(manager.hasPendingDiff(raceFile), false);
  check('Queued filesystem callback cannot cross OFF/ON boundary');

  const signalDir = path.join(os.tmpdir(), 'ai-cli-diff-signals');
  const snapshot = path.join(folder, '.hook-snapshot');
  fs.writeFileSync(snapshot, 'hook original\n');
  const hookFile = path.join(folder, 'hook.txt');
  fs.writeFileSync(hookFile, 'hook original\n');
  await sleep(700);
  if (manager.hasPendingDiff(hookFile)) { await manager.accept(hookFile); }
  await toggle();
  const signal = path.join(signalDir, `monitoring-test-${process.pid}.json`);
  fs.writeFileSync(hookFile, 'hook paused\n');
  fs.writeFileSync(signal, JSON.stringify({ filePath: hookFile, snapshotPath: snapshot, timestamp: Date.now() }));
  await sleep(500);
  assert.equal(manager.hasPendingDiff(hookFile), false);
  assert.equal(fs.existsSync(signal), false);
  check('OFF consumes hook signals without creating pending diff');
  await toggle();
  await sleep(700);
  assert.equal(manager.hasPendingDiff(hookFile), false);
  check('Paused hook signal is not replayed on resume');

  // Central gate also protects the built-in CLI runner's snapshot entry point.
  await toggle();
  const cliFile = path.join(folder, 'cli.txt');
  fs.writeFileSync(cliFile, 'CLI content\n');
  await manager.snapshotBefore(cliFile);
  manager.loadSnapshot(cliFile, 'old');
  await manager.openDiff(cliFile);
  assert.equal(manager.hasPendingDiff(cliFile), false);
  check('OFF blocks built-in CLI snapshot and automatic diff entry points');
  assert.equal(context.globalState.get('ai-cli-diff-view.monitoringEnabled'), false);
  fs.writeFileSync(phaseFile, 'restart');
  fs.writeFileSync(path.join(root, '.vscode-test', 'integration-results.json'), JSON.stringify(passed, null, 2));
};
