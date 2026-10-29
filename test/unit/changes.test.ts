import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HookCollector } from '../../src/collectors/hookCollector';
import { applyTranscriptLine, emptyStats } from '../../src/collectors/transcriptCollector';
import { AgentStore } from '../../src/services/agentState';
import { changeGroups } from '../../src/views/dashboardState';

const root = path.resolve(os.tmpdir(), 'ws');
const now = Date.parse('2026-10-29T12:00:00Z');
const ev = (sessionId: string, event: string, ts: string) => ({ v: 1, ts, event, sessionId, cwd: path.join(root, 'demo') });
function stats(id: string, file: string, ts: string) {
  const st = emptyStats(id, 'x.jsonl');
  applyTranscriptLine(st, JSON.stringify({ type: 'user', timestamp: ts, cwd: path.join(root, 'demo'), toolUseResult: { filePath: path.join(root, 'demo', file), structuredPatch: [{ lines: ['+a', '+b', '-c'] }] } }), new Set());
  return st;
}

describe('Claude Changes view', () => {
  it('shows ended sessions (bug: only live sessions were selectable, ended ones are in `recent`)', () => {
    const store = new AgentStore({ staleAfterMs: 120_000, historyLimit: 100, recentLimit: 20 });
    store.apply(ev('demo1', 'SessionStart', '2026-10-29T11:00:00Z') as never, now);
    store.apply(ev('demo1', 'SessionEnd', '2026-10-29T11:01:00Z') as never, now);
    const snap = store.snapshot();
    assert.strictEqual(snap.sessions.length, 0, 'ended session is not live');
    const groups = changeGroups({
      stats: [stats('demo1', 'math.js', '2026-10-29T11:00:30Z'), stats('old', 'x.js', '2026-10-27T11:00:00Z')],
      snapshot: snap, hidden: {}, roots: [root], lookbackMs: 24 * 3600_000, now
    });
    assert.strictEqual(groups.length, 1, 'session older than lookback is dropped');
    assert.strictEqual(groups[0].id, 'demo1');
    assert.strictEqual(groups[0].live, false);
    assert.deepStrictEqual(groups[0].changes.map((c) => c.name), ['math.js']);
    assert.strictEqual(groups[0].added, 2);
    assert.match(groups[0].label, /^demo · demo1/);
  });

  it('excludes files outside the workspace and kept files', () => {
    const st = stats('s', 'a.js', '2026-10-29T11:59:00Z');
    applyTranscriptLine(st, JSON.stringify({ type: 'user', timestamp: '2026-10-29T11:59:00Z', toolUseResult: { filePath: path.resolve(os.tmpdir(), 'elsewhere', 'b.js'), structuredPatch: [] } }), new Set());
    const snap = new AgentStore({ staleAfterMs: 1, historyLimit: 1, recentLimit: 1 }).snapshot();
    assert.deepStrictEqual(changeGroups({ stats: [st], snapshot: snap, hidden: {}, roots: [root], lookbackMs: 3600_000, now })[0].changes.map((c) => c.name), ['a.js']);
    const key = `s|${path.join(root, 'demo', 'a.js')}`;
    assert.strictEqual(changeGroups({ stats: [st], snapshot: snap, hidden: { [key]: '2026-10-29T11:59:00Z' }, roots: [root], lookbackMs: 3600_000, now }).length, 0);
  });

  it('backfills only the newest N event files on activation', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-bf-'));
    for (let i = 0; i < 3; i++) {
      const f = path.join(dir, `s${i}.jsonl`);
      fs.writeFileSync(f, JSON.stringify(ev(`s${i}`, 'SessionStart', `2026-10-29T11:0${i}:00Z`)) + '\n');
      fs.utimesSync(f, new Date(now + i * 1000), new Date(now + i * 1000));
    }
    const c = new HookCollector({ dir, backfillFiles: 2 });
    assert.deepStrictEqual(c.scan().map((e) => e.sessionId).sort(), ['s1', 's2']);
    c.dispose();
  });
});
