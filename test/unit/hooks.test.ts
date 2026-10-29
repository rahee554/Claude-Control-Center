import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseEventLine } from '../../src/models/events';
import { hookCommand, mergeHooks, readSettings, writeSettingsAtomic } from '../../src/services/hookSettings';

const SCRIPT = path.resolve(__dirname, '..', '..', '..', 'hooks', 'ccc-hook.js');

function runHook(home: string, input: string, env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [SCRIPT], {
    input, encoding: 'utf8', timeout: 10000,
    env: { ...process.env, HOME: home, USERPROFILE: home, CCC_COLLECT_PROMPTS: '', ...env }
  });
}

function readEvents(home: string, sid: string) {
  const f = path.join(home, '.claude-control-center', 'events', `${sid}.jsonl`);
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
}

describe('hook script', () => {
  let home: string;
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-home-')); });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it('writes a sanitized, schema-valid event with summarized tool input', () => {
    const r = runHook(home, JSON.stringify({
      session_id: 'abc-123', transcript_path: 'C:/t.jsonl', cwd: 'C:/proj', hook_event_name: 'PreToolUse',
      tool_name: 'Write', tool_input: { file_path: 'C:/proj/a.ts', content: 'SECRET_CONTENT'.repeat(100) }
    }));
    assert.strictEqual(r.status, 0);
    const [e] = readEvents(home, 'abc-123');
    assert.strictEqual(e.filePath, 'C:/proj/a.ts');
    assert.strictEqual(e.toolName, 'Write');
    assert.ok(!JSON.stringify(e).includes('SECRET_CONTENT'));
    assert.ok(parseEventLine(JSON.stringify(e)), 'output must validate');
    const bash = runHook(home, JSON.stringify({ session_id: 'abc-123', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'x'.repeat(500) } }));
    assert.strictEqual(bash.status, 0);
    assert.ok(readEvents(home, 'abc-123')[1].summary.length <= 140);
  });

  it('drops prompt text unless opted in', () => {
    const input = JSON.stringify({ session_id: 's', hook_event_name: 'UserPromptSubmit', prompt: 'my secret prompt' });
    runHook(home, input);
    assert.strictEqual(readEvents(home, 's')[0].summary, undefined);
    runHook(home, input, { CCC_COLLECT_PROMPTS: '1' });
    assert.strictEqual(readEvents(home, 's')[1].summary, 'my secret prompt');
  });

  it('records subagent ids and sanitizes the session file name', () => {
    runHook(home, JSON.stringify({ session_id: '../../evil', hook_event_name: 'SubagentStart', agent_id: 'ag1', agent_type: 'Explore' }));
    const dir = path.join(home, '.claude-control-center', 'events');
    assert.deepStrictEqual(fs.readdirSync(dir), ['______evil.jsonl']);
    const [e] = readEvents(home, '______evil');
    assert.strictEqual(e.agentId, 'ag1');
    assert.strictEqual(e.agentType, 'Explore');
    assert.strictEqual(typeof e.pid, 'number');
  });

  it('exits 0 on garbage and oversized input without writing', () => {
    assert.strictEqual(runHook(home, 'not json').status, 0);
    assert.strictEqual(runHook(home, JSON.stringify({ session_id: 's' })).status, 0);
    assert.strictEqual(runHook(home, 'x'.repeat(1100 * 1024)).status, 0);
    assert.ok(!fs.existsSync(path.join(home, '.claude-control-center', 'events', 's.jsonl')));
  });
});

describe('hook settings merge', () => {
  const cmd = hookCommand('C:\\ext\\v1');
  it('builds a quoted forward-slash command', () => {
    assert.strictEqual(cmd, 'node "C:/ext/v1/hooks/ccc-hook.js"');
    assert.throws(() => hookCommand('C:\\a"b'));
  });

  it('preserves existing hooks and other settings, and is idempotent', () => {
    const existing = { model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }] } };
    const a = mergeHooks(existing, cmd);
    assert.ok(a.changed);
    assert.strictEqual(a.settings.model, 'opus');
    const stop = (a.settings.hooks as Record<string, { hooks: { command: string }[] }[]>).Stop;
    assert.strictEqual(stop.length, 2);
    assert.strictEqual(stop[0].hooks[0].command, 'echo done');
    const b = mergeHooks(a.settings, cmd);
    assert.strictEqual(b.changed, false);
    const c = mergeHooks(a.settings, hookCommand('C:\\ext\\v2'));
    assert.ok(c.changed);
    assert.strictEqual((c.settings.hooks as Record<string, unknown[]>).Stop.length, 2, 'old ccc entry replaced, not duplicated');
    assert.strictEqual(existing.hooks.Stop.length, 1, 'input not mutated');
  });

  it('refuses non-object settings and writes atomically with backup', () => {
    assert.throws(() => mergeHooks([], cmd));
    assert.throws(() => mergeHooks({ hooks: [] }, cmd));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-set-'));
    try {
      const f = path.join(dir, 'settings.json');
      assert.strictEqual(readSettings(f), undefined);
      fs.writeFileSync(f, '{"a":1}');
      const backup = writeSettingsAtomic(f, mergeHooks(readSettings(f), cmd).settings);
      assert.ok(backup && fs.readFileSync(backup, 'utf8') === '{"a":1}');
      assert.strictEqual((readSettings(f) as { a: number }).a, 1);
      assert.deepStrictEqual(fs.readdirSync(dir).filter((n) => n.includes('tmp')), []);
      fs.writeFileSync(f, '{bad');
      assert.throws(() => readSettings(f));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
