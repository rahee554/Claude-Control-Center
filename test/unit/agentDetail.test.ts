import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { stripCd, SubTail, toolLabel } from '../../src/views/agentDetail';

describe('agentDetail', () => {
  it('strips a leading cd && prefix', () => {
    assert.strictEqual(stripCd('cd "G:/a b" && npm test'), 'npm test');
    assert.strictEqual(stripCd("cd /x/y&&ls"), 'ls');
    assert.strictEqual(stripCd('echo cd x && y'), 'echo cd x && y');
  });
  it('labels bash with description else command', () => {
    assert.strictEqual(toolLabel('Bash', { command: 'cd /x && npm run build', description: 'Build it' }), 'Build it');
    assert.strictEqual(toolLabel('Bash', { command: 'cd /x && npm run build\n' }), 'npm run build');
    assert.strictEqual(toolLabel('Read', { file_path: '/a/b.ts' }), 'b.ts');
  });
  it('tails incrementally with IN/OUT, result and files', () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sub-')), 'agent-x.jsonl');
    const L = (o: unknown) => JSON.stringify(o) + '\n';
    fs.writeFileSync(f, L({ type: 'user', message: { content: 'do it' } }) +
      L({ type: 'assistant', timestamp: '2026-01-01T00:00:00Z', message: { id: 'm1', usage: { input_tokens: 5, output_tokens: 2 }, content: [{ type: 'tool_use', id: 't1', name: 'Write', input: { file_path: '/p/a.ts', content: 'x\ny' } }] } }) + '{"partial');
    const t = new SubTail(f);
    assert.ok(t.poll());
    assert.strictEqual(t.prompt, 'do it');
    assert.strictEqual(t.tools[0].status, 'run');
    assert.strictEqual(t.tokens, 7);
    assert.ok(!t.poll());
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('{"partial', '') +
      L({ type: 'user', timestamp: '2026-01-01T00:00:02Z', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }) +
      L({ type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: 'Done' }] } }));
    assert.ok(t.poll());
    assert.strictEqual(t.tools[0].status, 'ok');
    assert.strictEqual(t.tools[0].out, 'ok');
    assert.strictEqual(t.tools[0].ms, 2000);
    assert.strictEqual(t.reply, 'Done');
    assert.deepStrictEqual(t.files.get('/p/a.ts'), { added: 2, removed: 0 });
  });
});
