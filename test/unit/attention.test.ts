import * as assert from 'assert';
import { AttentionDecider, AlertFlags, DEDUPE_MS } from '../../src/services/attention';
import { CccEvent } from '../../src/models/events';

const on: AlertFlags = { enabled: true, permission: true, input: true, tasks: true };
const ev = (summary: string, ts: number, sessionId = 's1'): CccEvent => ({ v: 1, ts: new Date(ts).toISOString(), event: 'Notification', sessionId, summary });

describe('attention', () => {
  let t = 1_000_000;
  const mk = () => new AttentionDecider(t, () => t);
  beforeEach(() => { t = 1_000_000; });

  it('classifies permission vs input', () => {
    const d = mk();
    assert.strictEqual(d.fromEvent(ev('Claude needs your permission to use Bash', t), on)?.kind, 'permission');
    assert.strictEqual(d.fromEvent(ev('Claude is waiting for your input', t, 's2'), on)?.kind, 'input');
  });
  it('ignores non-notification and stale events', () => {
    const d = mk();
    assert.strictEqual(d.fromEvent({ ...ev('x', t), event: 'Stop' }, on), undefined);
    assert.strictEqual(d.fromEvent(ev('permission', t - 5000), on), undefined);
  });
  it('dedupes per session+kind for 60s', () => {
    const d = mk();
    assert.ok(d.fromEvent(ev('permission', t), on));
    t += DEDUPE_MS - 1;
    assert.strictEqual(d.fromEvent(ev('permission', t), on), undefined);
    assert.ok(d.fromEvent(ev('permission', t, 's2'), on));
    t += 2;
    assert.ok(d.fromEvent(ev('permission', t), on));
  });
  it('respects flags', () => {
    const d = mk();
    assert.strictEqual(d.fromEvent(ev('permission', t), { ...on, permission: false }), undefined);
    assert.strictEqual(d.fromEvent(ev('idle', t), { ...on, enabled: false }), undefined);
    assert.strictEqual(d.fromTask('a', 'done', 'x', { ...on, tasks: false }), undefined);
  });
  it('task done/failed only', () => {
    const d = mk();
    assert.strictEqual(d.fromTask('a', 'running', 'x', on), undefined);
    assert.strictEqual(d.fromTask('a', 'done', 'x', on)?.kind, 'taskDone');
    assert.strictEqual(d.fromTask('b', 'failed', 'x', on)?.kind, 'taskFailed');
  });
});
