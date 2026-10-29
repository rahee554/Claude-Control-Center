import * as assert from 'assert';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Account, accountsFile, applyAccountEdit, shellCommand } from '../../src/accounts/model';

const HOOKS = path.join(__dirname, '..', '..', '..', 'hooks');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const mcp = require(path.join(HOOKS, 'ccc-mcp.js')) as { validateDelegate: (a: Record<string, unknown>, c: unknown, n: number) => { account: { id: string }; preset: string; cwd: string } };

describe('accounts: login command per shell', () => {
  const exe = 'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe';
  it('quotes the exe for each shell', () => {
    assert.strictEqual(shellCommand(exe, ['auth', 'login'], 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'), `& "${exe}" auth login`);
    assert.strictEqual(shellCommand(exe, ['auth', 'login'], 'pwsh.exe'), `& "${exe}" auth login`);
    assert.strictEqual(shellCommand(exe, ['auth', 'login'], 'C:\\Windows\\System32\\cmd.exe'), `"${exe}" auth login`);
    assert.strictEqual(shellCommand(exe, ['auth', 'login'], 'C:\\Program Files\\Git\\bin\\bash.exe'), `"${exe.replace(/\\/g, '/')}" auth login`);
    assert.strictEqual(shellCommand('/usr/local/bin/claude', [], '/bin/zsh'), '"/usr/local/bin/claude"');
  });
  it('rejects unsafe paths/args', () => {
    assert.throws(() => shellCommand('C:\\x"; calc; "', ['auth'], 'pwsh'));
    assert.throws(() => shellCommand('C:\\a&b\\claude.exe', [], 'cmd'));
    assert.throws(() => shellCommand('C:\\claude.exe', ['auth;calc'], 'cmd'));
  });
});

describe('accounts: edit model', () => {
  const list: Account[] = [{ id: 'm', label: 'Main', role: 'main', enabled: true, color: 'c' }, { id: 's', label: 'S', role: 'sub', enabled: true, color: 'c', configDir: '/s' }];
  it('applies fields and keeps a single main', () => {
    const r = applyAccountEdit(list, 's', { label: ' Work ', role: 'main', defaultModel: 'haiku', defaultPreset: 'edit', notes: 'n', enabled: false });
    assert.deepStrictEqual(r.map((a) => a.role), ['sub', 'main']);
    assert.strictEqual(r[1].label, 'Work');
    assert.strictEqual(r[1].defaultModel, 'haiku');
    assert.strictEqual(r[1].enabled, false);
    assert.strictEqual(list[1].label, 'S'); // input untouched
  });
  it('validates', () => {
    assert.throws(() => applyAccountEdit(list, 's', { label: ' ' }));
    assert.throws(() => applyAccountEdit(list, 's', { defaultModel: 'gpt' }));
    assert.throws(() => applyAccountEdit(list, 'zz', { notes: 'x' }));
  });
  it('accounts.json carries no secrets and includes status', () => {
    const f = accountsFile(list, new Map([['s', { loggedIn: true, email: 'a@b', fiveHour: 3 }]]), { workspaces: ['/w'], allowRunFromMcp: false, allowMainFromMcp: false, maxConcurrent: 2 });
    assert.deepStrictEqual(Object.keys(f.accounts[1]).sort(), ['configDir', 'email', 'enabled', 'fiveHour', 'id', 'label', 'loggedIn', 'plan', 'role', 'weekly']);
    assert.strictEqual(f.accounts[1].loggedIn, true);
  });
});

describe('mcp: delegate_task validation', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-ws-'));
  const cfg = (s: Record<string, unknown> = {}) => ({
    exe: 'claude.exe', workspaces: [ws], settings: { maxConcurrent: 2, ...s },
    accounts: [
      { id: 'main', label: 'Main', role: 'main', enabled: true, loggedIn: true },
      { id: 's1', label: 'Sub One', role: 'sub', enabled: true, loggedIn: true, configDir: '/s1', fiveHour: 10 },
      { id: 's2', label: 'Off', role: 'sub', enabled: false, loggedIn: true },
      { id: 's3', label: 'Out', role: 'sub', enabled: true, loggedIn: false }
    ]
  });
  const ok = { prompt: 'hi' };
  it('accepts a valid call, resolves auto and labels', () => {
    assert.strictEqual(mcp.validateDelegate(ok, cfg(), 0).account.id, 's1');
    assert.strictEqual(mcp.validateDelegate({ ...ok, account: 'sub one', preset: 'edit' }, cfg(), 0).preset, 'edit');
  });
  it('rejects preset escalation', () => {
    assert.throws(() => mcp.validateDelegate({ ...ok, preset: 'run' }, cfg(), 0), /allowRunFromMcp/);
    assert.throws(() => mcp.validateDelegate({ ...ok, preset: 'bash' }, cfg(), 0), /preset/);
    assert.throws(() => mcp.validateDelegate({ ...ok, preset: 'dangerously' }, cfg(), 0), /preset/);
    assert.strictEqual(mcp.validateDelegate({ ...ok, preset: 'run' }, cfg({ allowRunFromMcp: true }), 0).preset, 'bash');
  });
  it('rejects cwd outside the workspace', () => {
    assert.throws(() => mcp.validateDelegate({ ...ok, cwd: os.tmpdir() }, cfg(), 0), /workspace/);
    assert.throws(() => mcp.validateDelegate({ ...ok, cwd: path.join(ws, '..', 'x') }, cfg(), 0), /workspace/);
  });
  it('rejects disabled, logged-out, main and over-limit', () => {
    assert.throws(() => mcp.validateDelegate({ ...ok, account: 's2' }, cfg(), 0), /disabled/);
    assert.throws(() => mcp.validateDelegate({ ...ok, account: 's3' }, cfg(), 0), /not logged in/);
    assert.throws(() => mcp.validateDelegate({ ...ok, account: 'main' }, cfg(), 0), /allowMainFromMcp/);
    assert.throws(() => mcp.validateDelegate(ok, cfg(), 2), /maxConcurrent/);
    assert.throws(() => mcp.validateDelegate({ prompt: ' ' }, cfg(), 0), /prompt/);
  });
});

describe('mcp: full preset, contextFiles, appendSystemPrompt, resume', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-ws2-'));
  fs.writeFileSync(path.join(ws, 'a.js'), 'export const a = 1;');
  fs.writeFileSync(path.join(ws, 'big.txt'), 'x'.repeat(150 * 1024));
  const cfg = (s: Record<string, unknown> = {}) => ({
    exe: 'claude.exe', workspaces: [ws], settings: { maxConcurrent: 2, ...s },
    accounts: [{ id: 's1', label: 'Sub', role: 'sub', enabled: true, loggedIn: true, fiveHour: 1 }]
  });
  const v = (a: Record<string, unknown>, s?: Record<string, unknown>) => mcp.validateDelegate({ prompt: 'p', ...a }, cfg(s), 0) as unknown as Record<string, unknown>;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const lib = require(path.join(HOOKS, 'ccc-runner-lib.js')) as { buildArgs: (...a: unknown[]) => string[] };

  it('full is gated by allowRunFromMcp or allowFullFromMcp, default off', () => {
    assert.throws(() => v({ preset: 'full' }), /allowRunFromMcp/);
    assert.strictEqual(v({ preset: 'full' }, { allowRunFromMcp: true }).preset, 'full');
    assert.strictEqual(v({ preset: 'full' }, { allowFullFromMcp: true }).preset, 'full');
    assert.throws(() => v({ preset: 'full' }, { allowFullFromMcp: false, allowRunFromMcp: true }), /disabled/);
    assert.match(lib.buildArgs('full').join(' '), /WebFetch,WebSearch,Task,Agent,TodoWrite,NotebookEdit/);
  });
  it('contextFiles are read inside the workspace and bounded', () => {
    assert.match(String(v({ contextFiles: ['a.js'], cwd: ws }).context), /<context_file path="a.js">\nexport const a = 1;/);
    assert.throws(() => v({ contextFiles: [path.join(os.tmpdir(), 'x.js')] }), /outside the workspace/);
    assert.throws(() => v({ contextFiles: ['../x.js'] }), /outside the workspace/);
    assert.throws(() => v({ contextFiles: ['big.txt', 'big.txt'] }), /200KB/);
    assert.throws(() => v({ contextFiles: 'a.js' }), /array/);
    assert.throws(() => v({ contextFiles: ['nope.js'] }), /cannot read/);
  });
  it('appendSystemPrompt and resume become single safe argv tokens', () => {
    assert.throws(() => v({ appendSystemPrompt: 5 }), /appendSystemPrompt/);
    assert.strictEqual(v({ appendSystemPrompt: '--x' }).appendSystemPrompt, '--x');
    const a = lib.buildArgs('readonly', 'haiku', undefined, { resume: '12345678-1234-1234-1234-123456789abc', appendSystemPrompt: '--dangerously-skip-permissions' });
    assert.ok(a.includes('--append-system-prompt=--dangerously-skip-permissions') && !a.includes('--dangerously-skip-permissions'));
    assert.deepStrictEqual(a.slice(a.indexOf('--resume'), a.indexOf('--resume') + 2), ['--resume', '12345678-1234-1234-1234-123456789abc']);
    assert.throws(() => lib.buildArgs('readonly', undefined, undefined, { resume: '--x' }), /session id/);
  });
  it('resumeTaskId rejects unknown or invalid ids', () => {
    assert.throws(() => v({ resumeTaskId: 'zzzznotatask0' }), /unknown task/);
    assert.throws(() => v({ resumeTaskId: '../x' }), /invalid task id/);
  });
});

describe('mcp: stdio server', function () {
  this.timeout(15000);
  it('initialize, tools/list, tools/call list_accounts', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-home-'));
    fs.mkdirSync(path.join(home, '.claude-control-center'));
    fs.writeFileSync(path.join(home, '.claude-control-center', 'accounts.json'), JSON.stringify({ workspaces: [], accounts: [{ id: 's1', label: 'Sub', role: 'sub', enabled: true, loggedIn: true, fiveHour: 12 }] }));
    const child = spawn(process.execPath, [path.join(HOOKS, 'ccc-mcp.js')], { env: { ...process.env, HOME: home, USERPROFILE: home } });
    const replies: Record<number, { result?: Record<string, unknown>; error?: unknown }> = {};
    let buf = '';
    const got = new Promise<void>((resolve) => child.stdout.on('data', (d) => {
      buf += d;
      for (const ln of buf.split('\n').slice(0, -1)) { const m = JSON.parse(ln); replies[m.id] = m; }
      buf = buf.slice(buf.lastIndexOf('\n') + 1);
      if (replies[1] && replies[2] && replies[3] && replies[4]) resolve();
    }));
    const send = (o: object) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\n');
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    send({ method: 'notifications/initialized' });
    send({ id: 2, method: 'tools/list' });
    send({ id: 3, method: 'tools/call', params: { name: 'list_accounts', arguments: {} } });
    send({ id: 4, method: 'nope' });
    await got;
    child.kill();
    fs.rmSync(home, { recursive: true, force: true });
    assert.strictEqual(replies[1].result?.protocolVersion, '2025-03-26');
    assert.deepStrictEqual((replies[2].result?.tools as { name: string }[]).map((t) => t.name), ['list_accounts', 'delegate_task', 'get_task_result']);
    const content = replies[3].result?.content as { text: string }[];
    assert.deepStrictEqual(JSON.parse(content[0].text)[0], { id: 's1', label: 'Sub', role: 'sub', enabled: true, loggedIn: true, fiveHourPct: 12 });
    assert.strictEqual((replies[4].error as { code: number }).code, -32601);
  });
});
