import * as assert from 'assert';
import { aggregateModels, cleanPrompt, familyOf, familyShares, revertPlan, SKIP_PROMPT, TimelineReader } from '../../src/views/timeline';
import { applyHide } from '../../src/views/dashboardState';
import { isOpenablePath } from '../../src/services/fileHistory';
import { chipOf } from '../../src/views/dashboardState';
import { applySubagentLine, emptyStats } from '../../src/collectors/transcriptCollector';
import { BACKUP_NAME_RE } from '../../src/services/fileHistory';

const L = (o: object) => JSON.stringify(o);
const ts = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();

function reader(lines: object[]): TimelineReader {
  const r = new TimelineReader('/none.jsonl');
  for (const l of lines) r.apply(L(l));
  return r;
}

describe('subagent edits', () => {
  it('attributes successful subagent Edit/Write calls to the parent session with estimated +/- and hook baseline', () => {
    const st = emptyStats('s1', '/x.jsonl');
    const sub = { offset: 0, agentId: 'agentA', pending: new Map() };
    const bl = (p: string) => (p === '/w/new.ts' ? null : 'ccc-' + 'a'.repeat(40));
    const asst = (id: string, name: string, input: object) => L({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'tool_use', id, name, input }] } });
    const res = (id: string, err = false) => L({ type: 'user', isSidechain: true, timestamp: ts(9), message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: err }] } });
    applySubagentLine(st, asst('e1', 'Edit', { file_path: '/w/a.ts', old_string: 'a\nb\nc', new_string: 'a\nB\nB2\nc' }), sub, bl);
    applySubagentLine(st, asst('e2', 'Write', { file_path: '/w/new.ts', content: 'x\ny' }), sub, bl);
    applySubagentLine(st, asst('e3', 'Edit', { file_path: '/w/fail.ts', old_string: 'q', new_string: 'r' }), sub, bl);
    assert.strictEqual(applySubagentLine(st, res('e1'), sub, bl), true);
    applySubagentLine(st, res('e2'), sub, bl);
    applySubagentLine(st, res('e3', true), sub, bl);
    assert.deepStrictEqual([...st.changes.values()].map((c) => [c.path, c.added, c.removed, c.agentId, c.baseline]),
      [['/w/a.ts', 2, 1, 'agentA', 'ccc-' + 'a'.repeat(40)], ['/w/new.ts', 2, 0, 'agentA', null]]);
    assert.ok(BACKUP_NAME_RE.test('ccc-' + 'a'.repeat(40)));
  });
});

describe('timeline', () => {
  it('groups tools under turns, resolves status/duration, tokens and per-model usage', () => {
    const r = reader([
      { type: 'user', timestamp: ts(0), message: { role: 'user', content: 'fix it' } },
      { type: 'assistant', timestamp: ts(1), message: { id: 'm1', model: 'claude-opus-4', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 }, content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/w/a.ts' } }] } },
      { type: 'assistant', timestamp: ts(1), message: { id: 'm1', model: 'claude-opus-4', usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm test' } }] } },
      { type: 'file-history-delta', trackingPath: '/w/a.ts', backup: { backupFileName: 'aaaaaaaaaaaaaaaa@v1' } },
      { type: 'user', timestamp: ts(3), toolUseResult: { filePath: '/w/a.ts', structuredPatch: [{ lines: ['+x', '-y', '+z'] }] }, message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] } },
      { type: 'user', timestamp: ts(4), message: { content: [{ type: 'tool_result', tool_use_id: 't2', is_error: true }] } },
      { type: 'user', isSidechain: true, timestamp: ts(5), message: { content: 'ignored sidechain' } }
    ]);
    assert.strictEqual(r.turns.length, 1);
    const t = r.turns[0];
    assert.strictEqual(t.prompt, 'fix it');
    assert.strictEqual(t.reply, 'ok');
    assert.deepStrictEqual(t.tools.map((x) => [x.name, x.target, x.status, x.ms]), [['Edit', 'a.ts', 'ok', 2000], ['Bash', 'npm test', 'err', 3000]]);
    assert.strictEqual(t.tokOut, 5); // message id deduped
    assert.deepStrictEqual(t.files, [{ path: '/w/a.ts', added: 2, removed: 1, backup: 'aaaaaaaaaaaaaaaa@v1' }]);
    assert.deepStrictEqual(r.byModel.get('claude-opus-4'), { in: 10, out: 5, cache: 100 });
  });

  it('revertPlan uses the earliest backup at/after the turn; created files are null', () => {
    const turns = [
      { line: 1, ts: 0, endTs: 0, tools: [], tokIn: 0, tokOut: 0, files: [{ path: 'a', added: 1, removed: 0, backup: 'v1' }] },
      { line: 5, ts: 0, endTs: 0, tools: [], tokIn: 0, tokOut: 0, files: [{ path: 'a', added: 1, removed: 0, backup: 'v2' }, { path: 'b', added: 3, removed: 0, backup: null }] },
      { line: 9, ts: 0, endTs: 0, tools: [], tokIn: 0, tokOut: 0, files: [{ path: 'b', added: 1, removed: 0, backup: 'v9' }, { path: 'c', added: 1, removed: 1, backup: 'c1' }] }
    ];
    assert.deepStrictEqual(revertPlan(turns, 0), [{ path: 'a', backup: 'v1' }, { path: 'b', backup: null }, { path: 'c', backup: 'c1' }]);
    assert.deepStrictEqual(revertPlan(turns, 1), [{ path: 'a', backup: 'v2' }, { path: 'b', backup: null }, { path: 'c', backup: 'c1' }]);
    assert.deepStrictEqual(revertPlan(turns, 2, 'b'), [{ path: 'b', backup: 'v9' }]);
  });

  it('aggregates tokens and agents per model', () => {
    const rows = aggregateModels([
      { label: 'main', active: true, model: 'claude-opus-4', byModel: new Map([['claude-opus-4', { in: 60, out: 10, cache: 10 }]]) },
      { label: 'Explore', active: false, model: 'claude-haiku-4', byModel: new Map([['claude-haiku-4', { in: 15, out: 5, cache: 0 }]]) },
      { label: 'task', active: true, model: 'sonnet' }
    ]);
    assert.deepStrictEqual(rows.map((r) => [r.family, r.active, r.agents.length, r.share]), [['opus', 1, 1, 0.8], ['sonnet', 1, 1, 0], ['haiku', 0, 1, 0.2]]);
    assert.strictEqual(familyOf('gpt'), 'other');
  });

  it('chips distinguish permission vs input vs idle', () => {
    assert.strictEqual(chipOf({ status: 'waiting', stale: false }, { event: 'Notification', summary: 'Claude needs your permission to use Bash' }), 'permission');
    assert.strictEqual(chipOf({ status: 'waiting', stale: false }, { event: 'Notification', summary: 'Claude is waiting for your input' }), 'input');
    assert.strictEqual(chipOf({ status: 'waiting', stale: false }, { event: 'Stop' }), 'idle');
    assert.strictEqual(chipOf({ status: 'running', stale: true }), 'stale');
  });
});

describe('review fixes', () => {
  it('cleanPrompt strips only closed injected tags, normalizes CRLF', () => {
    assert.strictEqual(cleanPrompt('hi <system-reminder>x</system-reminder> there').text, 'hi  there');
    assert.strictEqual(cleanPrompt('keep <system-reminder>unclosed text').text, 'keep <system-reminder>unclosed text');
    assert.strictEqual(cleanPrompt('a\r\n\r\n\r\n\r\nb').text, 'a\n\nb');
  });
  it('SKIP_PROMPT only skips the full caveat', () => {
    assert.ok(SKIP_PROMPT.test('Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these messages or otherwise consider them in your response unless the user explicitly asks you to.'));
    assert.ok(!SKIP_PROMPT.test('Caveat: this is my real question'));
  });
  it('applyHide keeps real lastTs and clears stale entries on revert', () => {
    const h: Record<string, string> = { 's|/a': 't1', 's|/b': 't1' };
    applyHide(h, 's', [{ path: '/a', lastTs: '' }, { path: '/c', lastTs: 't2' }]);
    assert.deepStrictEqual(h, { 's|/b': 't1', 's|/c': 't2' });
  });
  it('isOpenablePath rejects UNC and outside paths', () => {
    const drive = process.platform === 'win32' ? 'C:' : '';
    assert.ok(isOpenablePath(`${drive}/w/a.ts`, [`${drive}/w`]));
    assert.ok(!isOpenablePath(`${drive}/other/a.ts`, [`${drive}/w`]));
    assert.ok(!isOpenablePath('\\\\host\\share\\a.ts', [`${drive}/w`]));
    assert.ok(!isOpenablePath('//host/share/a.ts', [`${drive}/w`]));
  });
  it('familyShares sums to 100 and groups by family', () => {
    const row = (model: string, n: number) => ({ model, family: familyOf(model), tokens: { in: n, out: 0, cache: 0 }, share: 0, agents: [{ label: model, active: true }], active: 1 });
    const fs = familyShares([row('claude-opus-4', 1), row('claude-sonnet-4', 1), row('claude-haiku-4', 1), row('claude-opus-5', 0)]);
    assert.deepStrictEqual(fs.map((f) => f.family), ['opus', 'sonnet', 'haiku']);
    assert.strictEqual(fs.reduce((n, f) => n + f.share, 0), 100);
    assert.strictEqual(fs[0].agents.length, 2);
    assert.strictEqual(familyShares([]).length, 0);
    assert.strictEqual(familyShares([row('x', 0)])[0].share, 0);
  });
});
