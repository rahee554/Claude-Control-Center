import * as assert from 'assert';
import { ALLOWED_COMMANDS, buildCard, CardInput, duration, meter, statusText } from '../../src/views/statusCard';

const NOW = 1_000_000_000_000;
const base: CardInput = { now: NOW, active: 0, models: { opus: 0, sonnet: 0, haiku: 0 }, tasks: 0, paused: false };

describe('statusCard', () => {
  it('formats countdowns', () => {
    assert.strictEqual(duration(72 * 60_000), '1h 12m');
    assert.strictEqual(duration(5 * 60_000), '5m');
    assert.strictEqual(duration(26 * 3_600_000), '1d 2h');
    assert.strictEqual(duration(-1), 'now');
  });

  it('renders minimal card: limits, context, agents, footer links only', () => {
    const md = buildCard({
      ...base, account: { email: 'me@x.io', plan: 'max' },
      fiveHour: { pct: 62, resetsAt: NOW + 72 * 60_000 }, sevenDay: { pct: 30 }, limitsAt: NOW - 120_000,
      subs: [{ label: 'Sub', fiveHour: 10 }], context: { pct: 41, tokens: 82_000 },
      active: 3, models: { opus: 2, sonnet: 1, haiku: 0 }, tasks: 1, messages: 7, files: { count: 2, added: 5, removed: 1 }
    });
    assert.ok(md.includes('Claude Code · max'));
    assert.ok(md.includes('5h · 62%') && md.includes('(in 1h 12m)'));
    assert.ok(md.includes('Context · 41%') && md.includes('3 active agents'));
    for (const gone of ['Sub', 'Opus', 'messages', 'files', 'MCP', 'me@x']) assert.ok(!md.includes(gone), gone);
    assert.deepStrictEqual([...md.matchAll(/\[([^\]]+)\]\(command:/g)].map((m) => m[1]), ['Open panel', 'Refresh', 'Settings']);
  });

  it('countdowns accept epoch seconds (CLI / status line) and ms; far resets show a weekday', () => {
    const sec = buildCard({ ...base, fiveHour: { pct: 8, resetsAt: (NOW + 72 * 60_000) / 1000 }, sevenDay: { pct: 57, resetsAt: (NOW + 4 * 86_400_000) / 1000 } });
    assert.ok(sec.includes('(in 1h 12m)'));
    assert.ok(!sec.includes('in now'));
    assert.ok(/Weekly · 57% · _Resets \w{3} /.test(sec));
    assert.ok(buildCard({ ...base, fiveHour: { pct: 8, resetsAt: NOW + 72 * 60_000 } }).includes('(in 1h 12m)'));
  });

  it('meter widths and thresholds', () => {
    const cells = (m: string, col: string) => { const r = new RegExp(`background-color:${col};">((?:&nbsp;)*)`).exec(m); return r ? r[1].split('&nbsp;').length - 1 : 0; };
    assert.strictEqual(cells(meter(50), '#3794ff'), 18);
    assert.strictEqual(cells(meter(50), '#3c3c3c'), 18);
    assert.strictEqual(cells(meter(70), '#cca700'), 25);
    assert.strictEqual(cells(meter(90), '#f14c4c'), 32);
    assert.ok(!meter(0).includes('#3794ff'));
  });

  it('shows Unavailable for missing data', () => {
    const md = buildCard({ ...base, limitsAt: NOW - 3_600_000 });
    assert.ok(md.includes('5h · _Unavailable_'));
    assert.ok(md.includes('Context · _Unavailable_'));
  });

  it('only links allow-listed commands', () => {
    const md = buildCard({ ...base, paused: true });
    const cmds = [...md.matchAll(/\(command:([\w.]+)/g)].map((m) => m[1]);
    assert.strictEqual(cmds.length, 3);
    for (const c of cmds) assert.ok(ALLOWED_COMMANDS.includes(c), c);
  });

  it('compact text: percent, spinner when running, pause', () => {
    assert.strictEqual(statusText({ ...base, fiveHour: { pct: 61.6 } }), '$(ccc-claude) 62%');
    assert.strictEqual(statusText({ ...base, active: 2 }), '$(ccc-claude) 2');
    assert.strictEqual(statusText({ ...base, paused: true }), '$(ccc-claude) $(debug-pause)');
  });
});
