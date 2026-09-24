const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
exports.activate = () => {
  // Normal development mode keeps real globalState; --extensionTestsPath uses
  // in-memory storage and cannot verify persistence across application restarts.
  void (async () => {
    const resultPath = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, '.driver-result.json');
    try {
      await require('../integration.cjs').run();
      fs.writeFileSync(resultPath, JSON.stringify({ passed: true }));
    } catch (error) {
      fs.writeFileSync(resultPath, JSON.stringify({ passed: false, error: error.stack || String(error) }));
    } finally {
      await vscode.commands.executeCommand('workbench.action.quit');
    }
  })();
};
