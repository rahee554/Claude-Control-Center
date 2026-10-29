import * as assert from 'assert';
import { ProcessAdapter } from '../../src/adapters/processAdapter';
import { buildAncestorMap, canTerminateAsGroup, classifyTerminal, Ownership } from '../../src/security/ownership';

const base = { expectedTag: 'ccc', name: 'pwsh', claudeAncestors: new Map<number, string[]>() };

describe('terminal ownership', () => {
  it('ExtensionOwned only with the exact tag', () => {
    assert.strictEqual(classifyTerminal({ ...base, ownerTag: 'ccc', terminalPid: 1 }).ownership, Ownership.ExtensionOwned);
    assert.notStrictEqual(classifyTerminal({ ...base, ownerTag: 'other', terminalPid: 1 }).ownership, Ownership.ExtensionOwned);
  });

  it('ClaudeConfirmed when terminal pid is an ancestor of a hook pid', async () => {
    // claude(300) <- shell(200) <- pwsh terminal(100); hook reported ppid 300
    const pa = new ProcessAdapter(() => true, async () => new Map([[300, 200], [200, 100], [100, 4]]));
    const chain = await pa.ancestors(300);
    assert.deepStrictEqual(chain, [300, 200, 100, 4]);
    const anc = buildAncestorMap([{ sessionId: 'S', chain }]);
    const r = classifyTerminal({ ...base, terminalPid: 100, claudeAncestors: anc });
    assert.strictEqual(r.ownership, Ownership.ClaudeConfirmed);
    assert.deepStrictEqual(r.sessionIds, ['S']);
    assert.strictEqual(classifyTerminal({ ...base, terminalPid: 999, claudeAncestors: anc }).ownership, Ownership.Unrelated);
  });

  it('process correlation can be disabled', async () => {
    const pa = new ProcessAdapter(() => false, async () => { throw new Error('must not query'); });
    assert.deepStrictEqual(await pa.ancestors(5), [5]);
    assert.deepStrictEqual(await pa.ancestors(-1), []);
  });

  it('ancestor walk stops on cycles', async () => {
    const pa = new ProcessAdapter(() => true, async () => new Map([[1, 2], [2, 1]]));
    assert.deepStrictEqual(await pa.ancestors(1), [1, 2]);
  });

  it('name hints are only ClaudeLikely and never group-terminable', () => {
    const r = classifyTerminal({ ...base, name: 'claude', terminalPid: 7 });
    assert.strictEqual(r.ownership, Ownership.ClaudeLikely);
    assert.strictEqual(canTerminateAsGroup(r.ownership), false);
    assert.strictEqual(canTerminateAsGroup(Ownership.Unrelated), false);
    assert.strictEqual(canTerminateAsGroup(Ownership.Unknown), false);
    assert.strictEqual(canTerminateAsGroup(Ownership.ExtensionOwned), true);
    const m = classifyTerminal({ ...base, name: 'Claude: x', mirrorSessionId: 's9', ownerTag: base.expectedTag });
    assert.deepStrictEqual([m.ownership, m.sessionIds], [Ownership.ClaudeMirror, ['s9']]);
    assert.strictEqual(canTerminateAsGroup(Ownership.ClaudeMirror), false);
    assert.strictEqual(canTerminateAsGroup(Ownership.ClaudeConfirmed), true);
    assert.strictEqual(classifyTerminal({ ...base }).ownership, Ownership.Unknown);
  });
});
