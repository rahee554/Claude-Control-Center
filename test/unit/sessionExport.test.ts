import * as assert from 'assert';
import { sessionToMarkdown, buildExportInput, SessionExportInput } from '../../src/views/sessionExport';

const T0 = Date.UTC(2026, 0, 1, 10, 30, 0);

function input(over: Partial<SessionExportInput> = {}): SessionExportInput {
  return { label: 'Main', sessionId: 'abcdef1234567890', turns: [], models: [], ...over };
}

describe('sessionExport', () => {
  it('renders title, summary, models table and messages', () => {
    const md = sessionToMarkdown(input({
      startedAt: T0, endedAt: T0 + 65 * 60 * 1000,
      models: [{ family: 'opus', tokensIn: 100, tokensOut: 20, agents: 2 }],
      turns: [{ time: T0, text: 'fix the bug\nmore detail', files: [{ path: '/w/a.ts', added: 3, removed: 1 }], tools: 4 }]
    }));
    assert.ok(md.startsWith('# Main (abcdef12)\n'));
    assert.ok(md.includes('Duration 1h 5m · 1 message · 1 file changed (+3 −1) · 4 tool calls'));
    assert.ok(md.includes('| opus | 2 | 100 | 20 |'));
    assert.ok(md.includes('### 10:30 — fix the bug\n'));
    assert.ok(!md.includes('more detail'));
    assert.ok(md.includes('- /w/a.ts (+3 −1)'));
  });

  it('uses a custom formatTime', () => {
    const md = sessionToMarkdown(input({ turns: [{ time: 5, text: 'x', files: [], tools: 0 }] }), (ms) => `t${ms}`);
    assert.ok(md.includes('### t5 — x'));
  });

  it('escapes Markdown and HTML in text, paths and labels', () => {
    const md = sessionToMarkdown(input({
      label: 'a|b',
      turns: [{ time: T0, text: '| * [x](y) <script>', files: [{ path: '/w/_my`file#.ts', added: 1, removed: 0 }], tools: 0 }]
    }));
    assert.ok(md.includes('### 10:30 — \\| \\* \\[x\\](y) \\<script\\>'));
    assert.ok(!md.includes('<script>'));
    assert.ok(!md.includes('[x]'));
    assert.ok(md.includes('- /w/\\_my\\`file\\#.ts (+1 −0)'));
    assert.ok(md.startsWith('# a\\|b (abcdef12)'));
  });

  it('handles an empty session', () => {
    const md = sessionToMarkdown(input());
    assert.ok(md.includes('0 messages · 0 files changed (+0 −0) · 0 tool calls'));
    assert.ok(!md.includes('Duration'));
    assert.ok(md.includes('No model usage recorded.'));
    assert.ok(md.includes('No messages.'));
  });

  it('truncates the first line to 80 characters with an ellipsis', () => {
    const long = 'a'.repeat(100);
    const md = sessionToMarkdown(input({ turns: [{ time: T0, text: long, files: [], tools: 0 }] }));
    assert.ok(md.includes(`— ${'a'.repeat(80)}…\n`));
    assert.ok(!md.includes('a'.repeat(81)));
    const exact = sessionToMarkdown(input({ turns: [{ time: T0, text: 'b'.repeat(80), files: [], tools: 0 }] }));
    assert.ok(!exact.includes('…'));
  });

  it('totals files (unique paths), lines and tool calls across turns', () => {
    const md = sessionToMarkdown(input({
      turns: [
        { time: T0, text: 'one', files: [{ path: '/a', added: 2, removed: 1 }, { path: '/b', added: 1, removed: 0 }], tools: 3 },
        { time: T0 + 1000, text: 'two', files: [{ path: '/a', added: 4, removed: 2 }], tools: 2 }
      ]
    }));
    assert.ok(md.includes('2 messages · 2 files changed (+7 −3) · 5 tool calls'));
  });
});

describe('buildExportInput', () => {
  it('maps turns and family shares', () => {
    const turns = [{ line: 1, ts: 5, endTs: 9, prompt: 'hi', tools: [{}], tokIn: 0, tokOut: 0, files: [{ path: 'a', added: 1, removed: 2 }] }] as never;
    const fam = [{ family: 'opus', tokens: { in: 1, out: 2, cache: 3 }, agents: [{}, {}] }] as never;
    const r = buildExportInput('L', 'sid', turns, fam);
    assert.deepStrictEqual(r.turns[0], { time: 5, text: 'hi', tools: 1, files: [{ path: 'a', added: 1, removed: 2 }] });
    assert.deepStrictEqual(r.models[0], { family: 'opus', tokensIn: 4, tokensOut: 2, agents: 2 });
    assert.strictEqual(r.endedAt, 9);
  });
});
