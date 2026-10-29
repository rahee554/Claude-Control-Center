import * as assert from 'assert';
import { applyTranscriptLine, emptyStats } from '../../src/collectors/transcriptCollector';
import { sessionTitle } from '../../src/views/dashboardState';

const run = (...lines: object[]) => {
  const st = emptyStats('abcdef1234', 'x.jsonl');
  const seen = new Set<string>();
  lines.forEach((l) => applyTranscriptLine(st, JSON.stringify(l), seen));
  return st;
};
const u = { type: 'user', message: { role: 'user', content: 'Fix the login bug please' } };

describe('sessionTitle', () => {
  it('prefers custom, then ai title', () => {
    assert.strictEqual(sessionTitle(run(u, { type: 'ai-title', aiTitle: 'AI' }, { type: 'custom-title', customTitle: 'Mine' })), 'Mine');
    assert.strictEqual(sessionTitle(run(u, { type: 'ai-title', aiTitle: 'AI' })), 'AI');
  });
  it('falls back to first prompt, then folder · id8', () => {
    assert.strictEqual(sessionTitle(run(u)), 'Fix the login bug please');
    assert.strictEqual(sessionTitle(run({ type: 'user', message: { content: 'x'.repeat(100) } })).length, 61);
    assert.strictEqual(sessionTitle(run(), '/a/demo'), 'demo · abcdef12');
  });
});

describe('sessionTitle minimal stats', () => {
  it('works with only a session id', () => {
    assert.strictEqual(sessionTitle({ sessionId: 'abcdef1234' }, '/a/demo'), 'demo · abcdef12');
  });
});
