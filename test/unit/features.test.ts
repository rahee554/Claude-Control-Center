import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { applyTranscriptLine, countPatch, emptyStats } from '../../src/collectors/transcriptCollector';
import { buildAncestorMap, classifyTerminal, Ownership } from '../../src/security/ownership';
import { baselinePath, isInside, readBaseline } from '../../src/services/fileHistory';
import { unwrapStatusLine, wrapStatusLine } from '../../src/services/hookSettings';
import { limitView, mergePidSources, parseCapture, readSessionPids } from '../../src/services/usageService';
import { buildState, contextWindowFor } from '../../src/views/dashboardState';

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const BK = '0123456789abcdef@v1';

describe('file changes', () => {
  it('counts structuredPatch lines', () => {
    assert.deepStrictEqual(countPatch([{ lines: [' a', '-b', '+c', '+d'] }, { lines: ['-x'] }]), { added: 2, removed: 2 });
    assert.deepStrictEqual(countPatch('nope'), { added: 0, removed: 0 });
  });

  it('aggregates file-history-delta baselines (earliest wins) and patch counts', () => {
    const st = emptyStats('S', 'x');
    const seen = new Set<string>();
    const delta = (name: string | null, v: number) => JSON.stringify({ type: 'file-history-delta', trackingPath: 'C:\\w\\a.ts', backup: { backupFileName: name, version: v } });
    applyTranscriptLine(st, delta(BK, 1), seen);
    applyTranscriptLine(st, delta('0123456789abcdef@v2', 2), seen);
    applyTranscriptLine(st, JSON.stringify({ type: 'user', toolUseResult: { filePath: 'C:\\w\\a.ts', structuredPatch: [{ lines: ['+1', '-2'] }] } }), seen);
    applyTranscriptLine(st, JSON.stringify({ type: 'user', toolUseResult: { type: 'create', filePath: 'C:\\w\\n.ts', content: 'a\nb\nc', structuredPatch: [] } }), seen);
    applyTranscriptLine(st, delta(null, 1).replace('a.ts', 'n.ts'), seen);
    applyTranscriptLine(st, JSON.stringify({ type: 'cost-state', totalCostUSD: 1.5 }), seen);
    const a = st.changes.get('C:\\w\\a.ts')!;
    assert.strictEqual(a.baseline, BK);
    assert.deepStrictEqual([a.added, a.removed], [1, 1]);
    const n = st.changes.get('C:\\w\\n.ts')!;
    assert.strictEqual(n.baseline, null);
    assert.strictEqual(n.added, 3);
    assert.strictEqual(st.costUSD, 1.5);
  });

  it('merges a relative trackingPath with the absolute toolUseResult path via cwd', () => {
    const st = emptyStats('S', 'x');
    const seen = new Set<string>();
    const abs = path.resolve('/w', 'README.md');
    applyTranscriptLine(st, JSON.stringify({ type: 'user', cwd: path.resolve('/w') }), seen);
    applyTranscriptLine(st, JSON.stringify({ type: 'file-history-delta', trackingPath: 'README.md', backup: { backupFileName: BK } }), seen);
    applyTranscriptLine(st, JSON.stringify({ type: 'user', toolUseResult: { filePath: abs, structuredPatch: [{ lines: ['+x'] }] } }), seen);
    assert.strictEqual(st.changes.size, 1);
    assert.strictEqual(st.changes.get(abs)!.baseline, BK);
  });

  it('rejects traversal and bad names in file-history paths', () => {
    const root = path.join(os.tmpdir(), 'fh');
    assert.ok(baselinePath('abc-123', BK, root));
    for (const [s, b] of [['..', BK], ['a/../..', BK], ['abc', '../x'], ['abc', '..\\..\\secret'], ['abc', 'abc@v1'], ['', BK], ['abc', BK + '/x']]) {
      assert.strictEqual(baselinePath(s, b, root), undefined, `${s} ${b}`);
    }
  });

  it('resolves baselines: content, created, missing, oversized', () => {
    const root = tmp('ccc-fh-');
    try {
      fs.mkdirSync(path.join(root, 'S1'));
      fs.writeFileSync(path.join(root, 'S1', BK), 'before');
      const r = readBaseline('S1', BK, root);
      assert.strictEqual(r.kind, 'content');
      assert.strictEqual(Buffer.from((r as { data: Uint8Array }).data).toString(), 'before');
      assert.strictEqual(readBaseline('S1', null, root).kind, 'created');
      assert.strictEqual(readBaseline('S1', undefined, root).kind, 'unavailable');
      assert.strictEqual(readBaseline('S1', '0123456789abcdef@v9', root).kind, 'unavailable');
      fs.writeFileSync(path.join(root, 'S1', '0123456789abcdef@v3'), Buffer.alloc(5 * 1024 * 1024 + 1));
      assert.strictEqual(readBaseline('S1', '0123456789abcdef@v3', root).kind, 'unavailable');
      assert.ok(isInside(path.join(root, 'S1', 'x'), [root]));
      assert.ok(!isInside(path.join(root, '..', 'x'), [root]));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});

describe('usage / rate limits', () => {
  const snapshot = { sessions: [], recent: [], activeCount: 0, staleCount: 0 };

  it('falls back to claude /usage CLI limits, ignoring expired windows', () => {
    const now = 1_000_000_000;
    const cli = { ts: now, fiveHour: { usedPercentage: 59, resetsAt: now / 1000 + 600 }, sevenDay: { usedPercentage: 54, resetsAt: now / 1000 - 1 } };
    const st = buildState({ snapshot, paused: false, staleAfterMs: 1000, hidden: {}, roots: [], cli, now });
    const t5 = st.tiles.find((x) => x.id === 'limit5h')!;
    assert.deepStrictEqual([t5.value, t5.source], ['59%', 'claude /usage']);
    assert.strictEqual(st.tiles.find((x) => x.id === 'limitWeek')!.value, 'Unavailable');
  });

  it('shows Unavailable when rate limits are missing', () => {
    const st = buildState({ snapshot, paused: false, staleAfterMs: 1000, hidden: {}, roots: [] });
    for (const id of ['limit5h', 'limitWeek']) {
      const t = st.tiles.find((x) => x.id === id)!;
      assert.strictEqual(t.value, 'Unavailable');
      assert.ok(t.unavailable && t.tooltip);
    }
    const cap = parseCapture({ ts: 1, sessionId: 'S', rate_limits: { five_hour: { used_percentage: 42, resets_at: 9e9 } } }, 1000)!;
    assert.strictEqual(limitView(cap, 'fiveHour').available, true);
    assert.strictEqual(limitView(cap, 'sevenDay').available, false);
    const expired = parseCapture({ ts: 1, sessionId: 'S', rate_limits: { five_hour: { used_percentage: 42, resets_at: 1 } } }, 10_000)!;
    assert.strictEqual(limitView(expired, 'fiveHour').available, false);
    assert.strictEqual(parseCapture({ ts: 1, sessionId: '../x' }), undefined);
    assert.strictEqual(contextWindowFor('claude-opus-5-5[1m]'), 1_000_000);
    assert.strictEqual(contextWindowFor('claude-opus-5-5'), 200_000);
  });

  it('statusline script captures stdin and relays the original command (temp HOME)', function () {
    this.timeout(20000);
    const home = tmp('ccc-home-');
    try {
      const env = { ...process.env, HOME: home, USERPROFILE: home };
      const script = path.resolve(__dirname, '..', '..', '..', 'hooks', 'ccc-statusline.js');
      const input = JSON.stringify({ session_id: 'sess-1', model: { id: 'm', display_name: 'Opus' }, rate_limits: { five_hour: { used_percentage: 12, resets_at: 9e9 } }, context_window: { used_percentage: 30 } });
      let r = spawnSync(process.execPath, [script], { input, env, encoding: 'utf8' });
      assert.match(r.stdout, /Opus \| ctx 30% \| 5h 12%/);
      const file = path.join(home, '.claude-control-center', 'statusline', 'sess-1.json');
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.strictEqual(saved.rate_limits.five_hour.used_percentage, 12);
      fs.writeFileSync(path.join(home, '.claude-control-center', 'statusline-config.json'),
        JSON.stringify({ original: { type: 'command', command: `"${process.execPath}" -e "process.stdin.on('data',d=>process.stdout.write('ORIG:'+JSON.parse(d).session_id))"` } }));
      r = spawnSync(process.execPath, [script], { input, env, encoding: 'utf8' });
      assert.strictEqual(r.stdout.trim(), 'ORIG:sess-1');
      r = spawnSync(process.execPath, [script], { input: JSON.stringify({ session_id: '../evil' }), env, encoding: 'utf8' });
      assert.ok(!fs.existsSync(path.join(home, '.claude-control-center', 'evil.json')));
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  it('wraps and restores the user statusLine', () => {
    const orig = { type: 'command', command: 'bash ~/sl.sh', padding: 1 };
    const w = wrapStatusLine({ statusLine: orig, other: 1 }, 'node "x/ccc-statusline.js"');
    assert.deepStrictEqual(w.original, orig);
    assert.strictEqual((w.settings.statusLine as { padding: number }).padding, 1);
    const again = wrapStatusLine(w.settings, 'node "x/ccc-statusline.js"');
    assert.ok(again.alreadyWrapped && again.original === undefined);
    assert.deepStrictEqual(unwrapStatusLine(w.settings, orig).settings, { statusLine: orig, other: 1 });
    assert.deepStrictEqual(unwrapStatusLine(wrapStatusLine({}, 'node "ccc-statusline.js"').settings, null).settings, {});
  });
});

describe('sessions-file correlation', () => {
  it('reads only <pid>.json files and confirms the ancestor terminal', () => {
    const dir = tmp('ccc-sess-');
    try {
      fs.writeFileSync(path.join(dir, '4242.json'), JSON.stringify({ pid: 4242, sessionId: 'sess-A' }));
      fs.writeFileSync(path.join(dir, '4242.abc.key'), JSON.stringify({ sessionId: 'LEAK' }));
      fs.writeFileSync(path.join(dir, '7.json'), JSON.stringify({ pid: 8, sessionId: 'mismatch' }));
      fs.writeFileSync(path.join(dir, '9.json'), '{bad');
      const files = readSessionPids(dir);
      assert.deepStrictEqual([...files], [[4242, 'sess-A']]);
      const merged = mergePidSources(new Map([[100, ['sess-B']]]), files);
      assert.deepStrictEqual(merged.get(4242), { sessions: ['sess-A'], fromFile: true });
      const chains = [{ sessionId: 'sess-A', chain: [4242, 300, 1] }];
      const r = classifyTerminal({ expectedTag: 't', terminalPid: 300, name: 'pwsh', claudeAncestors: buildAncestorMap(chains) });
      assert.strictEqual(r.ownership, Ownership.ClaudeConfirmed);
      assert.deepStrictEqual(r.sessionIds, ['sess-A']);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
