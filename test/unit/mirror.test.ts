import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CccEvent, MAX_LINE, parseEventLine, validateEvent } from '../../src/models/events';
import { buildHooksBlock, hookCommand, staleHookCommands } from '../../src/services/hookSettings';
import { MirrorFormatter, sanitizeForPty } from '../../src/services/mirrorFormat';

const SCRIPT = path.resolve(__dirname, '..', '..', '..', 'hooks', 'ccc-hook.js');
const base = { v: 1 as const, sessionId: 's1', toolName: 'Bash', toolUseId: 'tu1' };

describe('shell mirror', () => {
  let home: string;
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-mirror-')); });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));
  const run = (o: unknown) => spawnSync(process.execPath, [SCRIPT], { input: JSON.stringify(o), encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home } });
  const read = () => fs.readFileSync(path.join(home, '.claude-control-center', 'events', 's1.jsonl'), 'utf8').trim().split('\n');

  it('hook records truncated command and output, and omits output when disabled', () => {
    run({ session_id: 's1', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'tu1', tool_input: { command: 'c'.repeat(9000), description: 'list', run_in_background: true } });
    run({ session_id: 's1', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'tu1', tool_response: { stdout: 'o'.repeat(200 * 1024), stderr: 'bad', interrupted: false, backgroundTaskId: 'bg7' } });
    const [pre, first] = read();
    let post = first;
    assert.ok(pre.length <= MAX_LINE && post.length <= MAX_LINE);
    const p1 = parseEventLine(pre)!, p2 = parseEventLine(post)!;
    assert.strictEqual(p1.command!.length, 4096);
    assert.strictEqual(p1.description, 'list');
    assert.strictEqual(p1.runInBackground, true);
    assert.ok(p2.stdout!.length < 70 * 1024 && p2.stdout!.includes('truncated'));
    assert.strictEqual(p2.stderr, 'bad');
    assert.strictEqual(p2.backgroundTaskId, 'bg7');
    fs.writeFileSync(path.join(home, '.claude-control-center', 'config.json'), JSON.stringify({ mirrorOutput: false, maxOutputKB: 64 }));
    run({ session_id: 's1', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'tu2', tool_response: { stdout: 'SECRET' } });
    post = read()[2];
    assert.ok(!post.includes('SECRET'));
  });

  it('sanitizes OSC/DCS sequences but keeps colors and normalizes newlines', () => {
    const s = sanitizeForPty('a\x1b]52;c;ZXZpbA==\x07b\x1b]0;title\x1b\\c\x1bPq#0\x1b\\d\x9d8;;x\x9c\x1b[31mred\x1b[0m\nz');
    assert.strictEqual(s, 'abcd\x1b[31mred\x1b[0m\r\nz');
  });

  it('validates new fields', () => {
    const ev = { ...base, ts: '2026-01-01T00:00:00Z', event: 'PostToolUse' };
    assert.strictEqual(validateEvent({ ...ev, stdout: 'x'.repeat(200 * 1024) })!.stdout!.length, 140 * 1024);
    assert.strictEqual(validateEvent({ ...ev, interrupted: 'yes' }), undefined);
    assert.strictEqual(validateEvent({ ...ev, exitCode: 1.5 }), undefined);
    assert.strictEqual(validateEvent({ ...ev, command: 7 }), undefined);
    assert.strictEqual(validateEvent({ ...ev, exitCode: 2, runInBackground: true })!.exitCode, 2);
  });

  it('formatter pairs pre/post by toolUseId and handles background/error/other tools', () => {
    const f = new MirrorFormatter();
    const e = (o: Partial<CccEvent>) => ({ ...base, ts: '2026-01-01T00:00:00.000Z', event: 'PreToolUse', ...o }) as CccEvent;
    assert.strictEqual(f.render(e({ toolName: 'Read' })), undefined);
    const pre = f.render(e({ command: 'ls', description: 'list', agentId: 'a1', agentType: 'Explore' }))!;
    assert.ok(pre.includes('$\x1b[0m ls') && pre.includes('# list') && pre.includes('[Explore]'));
    const post = f.render(e({ event: 'PostToolUse', ts: '2026-01-01T00:00:01.200Z', stdout: 'a\nb' }))!;
    assert.ok(post.startsWith('a\r\nb\r\n') && post.includes('✓ done 1.2s'));
    assert.ok(f.render(e({ event: 'PostToolUse', toolUseId: 'x', backgroundTaskId: 'bg1' }))!.includes('↗ running in background (bg1)'));
    assert.ok(f.render(e({ event: 'PostToolUseFailure', toolUseId: 'y' }))!.includes('✗ error'));
  });

  it('detects hook commands pointing at an old path', () => {
    const stable = path.join('C:\\home', '.claude-control-center');
    const settings = { hooks: buildHooksBlock(hookCommand('C:\\ext\\v1')) };
    assert.strictEqual(staleHookCommands(settings, path.join(stable, 'hooks', 'ccc-hook.js')).length, 1);
    const ok = { hooks: buildHooksBlock(hookCommand(stable)) };
    assert.deepStrictEqual(staleHookCommands(ok, path.join(stable, 'hooks', 'ccc-hook.js')), []);
  });
});
