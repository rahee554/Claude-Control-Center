import * as assert from 'assert';
import Mocha from 'mocha';
import * as vscode from 'vscode';
import type { CccApi } from '../../src/extension';

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'bdd', timeout: 30000 });
  mocha.suite.emit('pre-require', globalThis, 'smoke', mocha);
  describe('smoke', () => {
    it('activates and manages an owned terminal', async () => {
      const ext = vscode.extensions.getExtension<CccApi>('artflow-studio.claude-code-control-center');
      assert.ok(ext, 'extension present');
      const api = await ext.activate();
      assert.ok(api.agents && api.terminals && api.usage);
      const cmds = await vscode.commands.getCommands(true);
      assert.ok(cmds.includes('ccc.installStatusLine') && cmds.includes('ccc.uninstallStatusLine'));
      const t = api.terminals.createTerminal({ name: 'ccc-smoke' });
      await t.processId;
      await api.terminals.reclassify();
      const info = api.terminals.list().find((i) => i.terminal === t);
      assert.ok(info);
      assert.strictEqual(info.ownership, 'extensionOwned');
      await vscode.commands.executeCommand('ccc.focusTerminal', info);
      const closed = new Promise<void>((r) => vscode.window.onDidCloseTerminal((x) => { if (x === t) r(); }));
      assert.strictEqual(await api.terminals.terminate(info, false), true);
      await closed;
      assert.ok(!api.terminals.list().some((i) => i.terminal === t));
    });
  });
  return new Promise((resolve, reject) => mocha.run((f) => (f ? reject(new Error(`${f} failure(s)`)) : resolve())));
}
