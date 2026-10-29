import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Account, AccountStatus, accountEnv, buildClaudeArgs, nextTaskState, pickAutoAccount, resolveClaudeExe } from '../../src/accounts/model';
import { runUsageCli } from '../../src/services/usageCli';

const acc = (id: string, role: 'main' | 'sub' = 'sub', enabled = true): Account => ({ id, label: id, role, enabled, color: 'c', configDir: role === 'sub' ? `/x/${id}` : undefined });

describe('accounts: auto selection', () => {
  const list = [acc('m', 'main'), acc('a'), acc('b'), acc('c', 'sub', false), acc('d')];
  it('picks enabled logged-in sub with lowest 5h usage, skipping >=90% and main/disabled', () => {
    const st = new Map<string, AccountStatus>([
      ['m', { loggedIn: true, fiveHour: 0 }], ['a', { loggedIn: true, fiveHour: 40 }],
      ['b', { loggedIn: true, fiveHour: 95 }], ['c', { loggedIn: true, fiveHour: 1 }], ['d', { loggedIn: false, fiveHour: 2 }]
    ]);
    assert.strictEqual(pickAutoAccount(list, st)?.id, 'a');
  });
  it('returns undefined when every sub is >=90% or logged out', () => {
    assert.strictEqual(pickAutoAccount(list, new Map([['a', { loggedIn: true, fiveHour: 90 }]])), undefined);
  });
  it('main account adds no env; sub sets CLAUDE_CONFIG_DIR', () => {
    assert.deepStrictEqual(accountEnv(acc('m', 'main')), {});
    assert.deepStrictEqual(accountEnv(acc('a')), { CLAUDE_CONFIG_DIR: '/x/a' });
  });
});

describe('accounts: preset -> args', () => {
  const tools = (a: string[]) => a[a.indexOf('--allowedTools') + 1];
  it('maps presets to allowedTools', () => {
    assert.strictEqual(tools(buildClaudeArgs({ preset: 'readonly' })), 'Read,Glob,Grep');
    assert.strictEqual(tools(buildClaudeArgs({ preset: 'edit' })), 'Read,Glob,Grep,Edit,Write');
    assert.strictEqual(tools(buildClaudeArgs({ preset: 'bash' })), 'Read,Glob,Grep,Edit,Write,Bash');
  });
  it('uses stream-json, adds only known models and --settings, never a prompt or skip-permissions', () => {
    const a = buildClaudeArgs({ preset: 'edit', model: 'haiku', settingsFile: '/s.json' });
    assert.deepStrictEqual(a.slice(0, 5), ['-p', '--output-format', 'stream-json', '--verbose', '--allowedTools']);
    assert.ok(a.includes('haiku') && a.includes('/s.json'));
    assert.ok(!buildClaudeArgs({ preset: 'edit', model: 'x; rm -rf /' }).includes('--model'));
    assert.ok(!buildClaudeArgs({ preset: 'edit', model: 'default' }).includes('--model'));
    assert.ok(!a.some((x) => /dangerously/.test(x)));
    // -p is the last positional-free flag: nothing after it is a free-text prompt.
    assert.ok(a.every((x, i) => x.startsWith('-') || a[i - 1]?.startsWith('-')));
  });
});

describe('accounts: runner', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'hooks', 'ccc-runner-lib.js'), 'utf8');
  it('spawns without a shell and feeds the prompt via stdin', () => {
    assert.match(src, /shell:\s*false/);
    assert.match(src, /prompt\.txt'\)\)\.pipe\(child\.stdin\)/);
    assert.doesNotMatch(src, /exec\(|execSync|shell:\s*true/);
  });
  it('resolves the npm .cmd shim to the bundled claude.exe on Windows', () => {
    const exe = 'C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe';
    const have = new Set(['C:\\npm\\claude.cmd', exe]);
    assert.strictEqual(resolveClaudeExe('claude', 'C:\\other;C:\\npm', 'win32', (p) => have.has(p)), exe);
    assert.strictEqual(resolveClaudeExe('claude', 'C:\\other', 'win32', (p) => have.has(p)), undefined);
    assert.strictEqual(resolveClaudeExe('claude', '/a:/usr/bin', 'linux', (p) => p === '/usr/bin/claude'), '/usr/bin/claude');
  });
});

describe('accounts: task state', () => {
  it('running ends in any terminal state; terminal states are sticky', () => {
    assert.strictEqual(nextTaskState('running', 'done'), 'done');
    assert.strictEqual(nextTaskState('running', 'cancelled'), 'cancelled');
    assert.strictEqual(nextTaskState('done', 'running'), 'done');
    assert.strictEqual(nextTaskState('cancelled', 'failed'), 'cancelled');
  });
});

describe('accounts: usage env passing', function () {
  this.timeout(20000);
  it('passes env to the /usage child', async function () {
    if (process.platform !== 'win32') this.skip();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-acc-'));
    fs.writeFileSync(path.join(dir, 'fake.js'), 'console.log(`Current session: ${process.env.CCC_TEST_PCT}% used Â· resets Oct 29, 4pm`)');
    fs.writeFileSync(path.join(dir, 'fake.cmd'), `@node "${path.join(dir, 'fake.js')}"\r\n`);
    try {
      const u = await runUsageCli(path.join(dir, 'fake.cmd'), 15000, { CCC_TEST_PCT: '37' });
      assert.strictEqual(u?.fiveHour?.usedPercentage, 37);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
