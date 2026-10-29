import * as assert from 'assert';
import * as path from 'path';
import { parseRequest } from '../../src/services/modBridge';

const root = path.resolve('/ws');
const now = 1_000_000;
const req = (o: object = {}) => JSON.stringify({ v: 1, action: 'openDiff', path: path.join(root, 'a.ts'), sessionId: 'abc-1', ts: now, ...o });

describe('modBridge.parseRequest', () => {
  it('accepts valid', () => assert.deepStrictEqual(parseRequest(req(), [root], now), { path: path.join(root, 'a.ts'), sessionId: 'abc-1' }));
  it('rejects UNC', () => assert.strictEqual(parseRequest(req({ path: '\\host\share\a.ts' }), [root], now), undefined));
  it('rejects outside workspace', () => assert.strictEqual(parseRequest(req({ path: path.resolve('/other/a.ts') }), [root], now), undefined));
  it('rejects stale ts', () => assert.strictEqual(parseRequest(req({ ts: now - 61_000 }), [root], now), undefined));
  it('rejects bad action', () => assert.strictEqual(parseRequest(req({ action: 'rm' }), [root], now), undefined));
  it('rejects oversized', () => assert.strictEqual(parseRequest(req({ x: 'a'.repeat(5000) }), [root], now), undefined));
});
