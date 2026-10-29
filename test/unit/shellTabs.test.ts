import * as assert from 'assert';
import { parseShellMsg, routeOf } from '../../src/views/shellTabs';

describe('shell tab routing', () => {
  it('routes only known tabs', () => {
    assert.strictEqual(routeOf({ tab: 'agents' }), 'agents');
    assert.strictEqual(routeOf({ tab: 'shell' }), 'shell');
    assert.strictEqual(routeOf({ tab: 'evil' }), undefined);
    assert.strictEqual(routeOf(null), undefined);
  });
  it('validates shell messages', () => {
    assert.deepStrictEqual(parseShellMsg({ tab: 'shell', type: 'select', id: 'agents' }), { type: 'select', id: 'agents' });
    assert.strictEqual(parseShellMsg({ tab: 'shell', type: 'select', id: 'x' }), undefined);
    assert.deepStrictEqual(parseShellMsg({ tab: 'shell', type: 'ready' }), { type: 'ready' });
  });
});
