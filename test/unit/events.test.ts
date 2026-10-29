import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HookCollector } from '../../src/collectors/hookCollector';
import { eventKey, parseEventLine, validateEvent } from '../../src/models/events';

const ev = (o: Record<string, unknown> = {}) => ({ v: 1, ts: '2026-01-01T00:00:00.000Z', event: 'PreToolUse', sessionId: 's1', ...o });

describe('event validation', () => {
  it('accepts a valid event and truncates long strings', () => {
    const e = validateEvent(ev({ summary: 'x'.repeat(1000), pid: 42 }));
    assert.ok(e);
    assert.strictEqual(e.summary!.length, 400);
    assert.strictEqual(e.pid, 42);
  });
  it('rejects wrong version, missing fields, bad types, bad ts, bad pid', () => {
    assert.strictEqual(validateEvent(ev({ v: 2 })), undefined);
    assert.strictEqual(validateEvent({ v: 1, ts: '2026-01-01T00:00:00Z', event: 'Stop' }), undefined);
    assert.strictEqual(validateEvent(ev({ toolName: 5 })), undefined);
    assert.strictEqual(validateEvent(ev({ ts: 'yesterday' })), undefined);
    assert.strictEqual(validateEvent(ev({ pid: -1 })), undefined);
    assert.strictEqual(validateEvent([1]), undefined);
    assert.strictEqual(validateEvent(null), undefined);
  });
  it('parses lines and rejects malformed JSON', () => {
    assert.ok(parseEventLine(JSON.stringify(ev())));
    assert.strictEqual(parseEventLine('{not json'), undefined);
    assert.strictEqual(parseEventLine(''), undefined);
  });
  it('drops unknown fields', () => {
    const e = validateEvent(ev({ prompt: 'secret' })) as unknown as Record<string, unknown>;
    assert.strictEqual(e.prompt, undefined);
  });
  it('dedupe key depends on identity fields only', () => {
    const a = validateEvent(ev({ summary: 'a' }))!;
    const b = validateEvent(ev({ summary: 'b' }))!;
    const c = validateEvent(ev({ toolName: 'Bash' }))!;
    assert.strictEqual(eventKey(a), eventKey(b));
    assert.notStrictEqual(eventKey(a), eventKey(c));
  });
  it('same tool_use_id from a doubly-registered hook dedupes despite different ts', () => {
    const a = validateEvent(ev({ toolName: 'Edit', toolUseId: 'toolu_1', ts: '2026-01-01T00:00:00.000Z' }))!;
    const b = validateEvent(ev({ toolName: 'Edit', toolUseId: 'toolu_1', ts: '2026-01-01T00:00:00.040Z' }))!;
    assert.strictEqual(eventKey(a), eventKey(b));
  });
});

describe('HookCollector', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-hc-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('reads incrementally, dedupes, counts malformed lines, and waits for partial lines', () => {
    const f = path.join(dir, 's1.jsonl');
    const line = JSON.stringify(ev()) + '\n';
    fs.writeFileSync(f, line + line + 'garbage\n');
    const c = new HookCollector({ dir });
    assert.strictEqual(c.scan().length, 1);
    assert.strictEqual(c.malformedLines, 1);
    const partial = JSON.stringify(ev({ event: 'PostToolUse' }));
    fs.appendFileSync(f, partial.slice(0, 10));
    assert.strictEqual(c.scan().length, 0);
    fs.appendFileSync(f, partial.slice(10) + '\n');
    const got = c.scan();
    assert.strictEqual(got.length, 1);
    assert.strictEqual(got[0].event, 'PostToolUse');
    assert.strictEqual(c.scan().length, 0);
    c.dispose();
  });

  it('only reads the tail of existing files on first sight', () => {
    const f = path.join(dir, 's2.jsonl');
    const lines = Array.from({ length: 200 }, (_, i) => JSON.stringify(ev({ ts: new Date(1e12 + i * 1000).toISOString() }))).join('\n') + '\n';
    fs.writeFileSync(f, lines);
    const c = new HookCollector({ dir, initialTailBytes: 1000 });
    const got = c.scan();
    assert.ok(got.length > 0 && got.length < 20, `got ${got.length}`);
    assert.strictEqual(c.malformedLines, 0, 'partial first line must be skipped, not counted');
    c.dispose();
  });
});
