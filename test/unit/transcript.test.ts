import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { applyTranscriptLine, emptyStats, isAllowedTranscript, TranscriptCollector } from '../../src/collectors/transcriptCollector';

const assistant = (id: string, usage: Record<string, number>, content: unknown[] = [], extra: Record<string, unknown> = {}) => JSON.stringify({
  type: 'assistant', sessionId: 'S', timestamp: '2026-01-01T00:00:00Z', ...extra,
  message: { id, model: 'claude-opus-5-5', role: 'assistant', usage, content }
});

describe('transcript parsing', () => {
  it('extracts model, deduped usage totals, context tokens and edits; tolerates malformed lines', () => {
    const st = emptyStats('S', 'x.jsonl');
    const seen = new Set<string>();
    const u = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 };
    assert.ok(applyTranscriptLine(st, assistant('m1', u, [{ type: 'text', text: 'hi' }]), seen));
    assert.ok(applyTranscriptLine(st, assistant('m1', u, [{ type: 'tool_use', name: 'Edit', input: { file_path: 'a.ts' } }]), seen));
    assert.strictEqual(applyTranscriptLine(st, '{broken', seen), false);
    assert.strictEqual(applyTranscriptLine(st, '"string"', seen), false);
    assert.ok(applyTranscriptLine(st, JSON.stringify({ type: 'user', message: { content: 'x' } }), seen));
    assert.ok(applyTranscriptLine(st, assistant('m2', { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 300, cache_creation_input_tokens: 0 },
      [{ type: 'tool_use', name: 'Write', input: { file_path: 'b.ts' } }, { type: 'tool_use', name: 'Bash', input: { command: 'ls' } }],
      { isSidechain: true, agentId: 'AG' }), seen));
    assert.strictEqual(st.model, 'claude-opus-5-5');
    assert.strictEqual(st.usage.inputTokens, 11);
    assert.strictEqual(st.usage.outputTokens, 7);
    assert.strictEqual(st.usage.cacheReadInputTokens, 400);
    assert.strictEqual(st.contextTokens, 130, 'sidechain usage does not change main context');
    assert.strictEqual(st.malformedLines, 2);
    assert.deepStrictEqual(st.edits.map((x) => [x.path, x.tool, x.agentId]), [['a.ts', 'Edit', undefined], ['b.ts', 'Write', 'AG']]);
  });

  it('only tails transcripts under the projects root, incrementally', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-tr-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-out-'));
    try {
      fs.mkdirSync(path.join(root, 'proj'));
      const f = path.join(root, 'proj', 'S.jsonl');
      fs.writeFileSync(f, assistant('m1', { input_tokens: 1, output_tokens: 1 }) + '\n');
      const bad = path.join(outside, 'S.jsonl');
      fs.writeFileSync(bad, '');
      assert.strictEqual(isAllowedTranscript(bad, root), false);
      assert.strictEqual(isAllowedTranscript(path.join(root, 'proj', '..', '..', path.basename(outside), 'S.jsonl'), root), false);
      const c = new TranscriptCollector(root);
      let updates = 0;
      c.onDidUpdate(() => updates++);
      assert.strictEqual(c.track('X', bad), false);
      assert.strictEqual(c.track('S', f), true);
      assert.strictEqual(c.getStats('S')!.usage.outputTokens, 1);
      fs.appendFileSync(f, assistant('m2', { input_tokens: 1, output_tokens: 4 }) + '\n' + '{"partial');
      c.poll();
      assert.strictEqual(c.getStats('S')!.usage.outputTokens, 5);
      assert.strictEqual(c.getStats('S')!.malformedLines, 0);
      assert.strictEqual(updates, 2);
      c.dispose();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
