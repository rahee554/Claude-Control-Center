import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SETTINGS, validateSetting } from '../../src/views/settingsView';
import { DEFAULT_ROUTING } from '../../src/accounts/model';
import { locateTranscript } from '../../src/accounts/delegatedSessions';
import { isAllowedTranscript, setExtraTranscriptRoots } from '../../src/collectors/transcriptCollector';

const HOOKS = path.join(__dirname, '..', '..', '..', 'hooks');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const mcp = require(path.join(HOOKS, 'ccc-mcp.js')) as { validateDelegate: (a: Record<string, unknown>, c: unknown, n: number) => { account: { id: string }; model?: string; weight: string } };

describe('delegate routing (weight -> account + model)', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-rt-'));
  const cfg = (routing: Record<string, string>, s: Record<string, unknown> = {}) => ({
    exe: 'claude.exe', workspaces: [ws], settings: { maxConcurrent: 2, allowRunFromMcp: true, routing, ...s },
    accounts: [
      { id: 'main', label: 'Main', role: 'main', enabled: true, loggedIn: true },
      { id: 's1', label: 'One', role: 'sub', enabled: true, loggedIn: true, fiveHour: 50 },
      { id: 's2', label: 'Two', role: 'sub', enabled: true, loggedIn: true, fiveHour: 5 }
    ]
  });
  const r = { ...DEFAULT_ROUTING, heavy: 's1', light: 'auto' };
  it('classifies light by default, heavy by preset or long prompt or explicit weight', () => {
    assert.strictEqual(mcp.validateDelegate({ prompt: 'x' }, cfg(r), 0).weight, 'light');
    assert.strictEqual(mcp.validateDelegate({ prompt: 'x', preset: 'full' }, cfg(r), 0).weight, 'heavy');
    assert.strictEqual(mcp.validateDelegate({ prompt: 'x', preset: 'run' }, cfg(r), 0).weight, 'heavy');
    assert.strictEqual(mcp.validateDelegate({ prompt: 'x'.repeat(4001) }, cfg(r), 0).weight, 'heavy');
    assert.strictEqual(mcp.validateDelegate({ prompt: 'x', weight: 'heavy' }, cfg(r), 0).weight, 'heavy');
    assert.strictEqual(mcp.validateDelegate({ prompt: 'x'.repeat(5000), weight: 'light' }, cfg(r), 0).weight, 'light');
    assert.throws(() => mcp.validateDelegate({ prompt: 'x', weight: 'huge' }, cfg(r), 0), /weight/);
  });
  it('picks account and default model from routing', () => {
    const h = mcp.validateDelegate({ prompt: 'x', weight: 'heavy' }, cfg(r), 0);
    assert.deepStrictEqual([h.account.id, h.model], ['s1', 'opus']);
    const l = mcp.validateDelegate({ prompt: 'x' }, cfg(r), 0);
    assert.deepStrictEqual([l.account.id, l.model], ['s2', 'haiku']); // auto = lowest 5h usage
  });
  it('explicit account/model win over routing; "default" model means CLI default', () => {
    const v = mcp.validateDelegate({ prompt: 'x', weight: 'heavy', account: 's2', model: 'sonnet' }, cfg(r), 0);
    assert.deepStrictEqual([v.account.id, v.model], ['s2', 'sonnet']);
    assert.strictEqual(mcp.validateDelegate({ prompt: 'x', weight: 'heavy' }, cfg({ ...r, heavyModel: 'default' }), 0).model, undefined);
  });
  it('routing to main still needs allowMainFromMcp', () => {
    const m = { ...r, light: 'main' };
    assert.throws(() => mcp.validateDelegate({ prompt: 'x' }, cfg(m), 0), /main account/);
    assert.strictEqual(mcp.validateDelegate({ prompt: 'x' }, cfg(m, { allowMainFromMcp: true }), 0).account.id, 'main');
  });
  it('without routing config behaves as before (auto, no model)', () => {
    const v = mcp.validateDelegate({ prompt: 'x' }, { ...cfg({}), settings: { maxConcurrent: 2 } }, 0);
    assert.deepStrictEqual([v.account.id, v.model], ['s2', undefined]);
  });
});

describe('settings page schema', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf8')) as { contributes: { configuration: { properties: Record<string, { type: string; default: unknown; enum?: string[]; minimum?: number; maximum?: number }> } } };
  const props = pkg.contributes.configuration.properties;
  it('every entry matches package.json (type, default, enum, range)', () => {
    for (const d of SETTINGS) {
      const p = props[`ccc.${d.key}`];
      assert.ok(p, `missing ccc.${d.key}`);
      assert.strictEqual(p.default, d.def, d.key);
      if (d.type === 'bool') assert.strictEqual(p.type, 'boolean');
      else if (d.type === 'number') { assert.strictEqual(p.type, 'number'); assert.strictEqual(p.minimum, d.min, d.key); if (p.maximum !== undefined) assert.strictEqual(p.maximum, d.max, d.key); }
      else { assert.strictEqual(p.type, 'string'); if (d.type === 'enum') assert.deepStrictEqual(p.enum, d.options, d.key); }
    }
  });
  it('lists every ccc.* setting except the retired models.chart', () => {
    const listed = new Set(SETTINGS.map((d) => `ccc.${d.key}`));
    assert.deepStrictEqual(Object.keys(props).filter((k) => !listed.has(k)).sort(), ['ccc.checkpoints.exclude', 'ccc.delegate.allowFullFromMcp', 'ccc.models.chart'].filter((k) => k in props));
  });
  it('validates type, range, enum and unknown keys', () => {
    assert.strictEqual(validateSetting('alerts.enabled', false), false);
    assert.strictEqual(validateSetting('alerts.enabled', 'yes'), undefined);
    assert.strictEqual(validateSetting('delegate.maxConcurrent', 11), undefined);
    assert.strictEqual(validateSetting('delegate.maxConcurrent', 2.5), undefined);
    assert.strictEqual(validateSetting('delegate.maxConcurrent', 3), 3);
    assert.strictEqual(validateSetting('mirror.focus', 'always'), undefined);
    assert.strictEqual(validateSetting('delegate.routing.heavy', 'main'), 'main');
    assert.strictEqual(validateSetting('delegate.routing.heavy', 'a; rm'), undefined);
    assert.strictEqual(validateSetting('limits.claudePath', 'claude & calc'), undefined);
    assert.strictEqual(validateSetting('editor.fontSize', 3), undefined);
    assert.strictEqual(validateSetting('__proto__', true), undefined);
  });
});

describe('delegated session transcripts', () => {
  it('locates a session under an account config dir and allows reading it', () => {
    const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-acct-'));
    const sid = '123e4567-e89b-42d3-a456-426614174000';
    fs.mkdirSync(path.join(cfgDir, 'projects', 'slug'), { recursive: true });
    const f = path.join(cfgDir, 'projects', 'slug', `${sid}.jsonl`);
    fs.writeFileSync(f, '{}\n');
    assert.strictEqual(locateTranscript(cfgDir, sid), f);
    assert.strictEqual(locateTranscript(cfgDir, '../../etc/passwd'), undefined);
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-root-'));
    assert.strictEqual(isAllowedTranscript(f, other), false);
    setExtraTranscriptRoots([path.join(cfgDir, 'projects')]);
    try { assert.strictEqual(isAllowedTranscript(f, other), true); } finally { setExtraTranscriptRoots([]); }
  });
});
