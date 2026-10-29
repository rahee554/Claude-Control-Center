// Multiple Claude accounts (CLAUDE_CONFIG_DIR per account) + delegating tasks to them.
import { execFile, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { CccApi } from '../extension';
import { setExtraTranscriptRoots } from '../collectors/transcriptCollector';
import { OWNER_ENV } from '../security/ownership';
import { buildHooksBlock, hookCommand } from '../services/hookSettings';
import { runUsageCli } from '../services/usageCli';
import { cliEnv } from '../util/cliEnv';
import { CCC_HOME } from '../services/usageService';
import {
  Account, accountEnv, accountsFile, AccountStatus, applyAccountEdit, buildClaudeArgs, COLORS, MODELS, newId, nextTaskState, pickAutoAccount,
  Preset, PRESETS, resolveClaudeExe, shellCommand, TaskMeta, TaskStatus
} from './model';

const KEY = 'ccc.accounts.list';
const ACCOUNTS_DIR = path.join(CCC_HOME, 'accounts');
const TASKS_DIR = path.join(CCC_HOME, 'tasks');
const OWNER_TAG = 'claude-control-center';
const DEFAULT_KEY = 'ccc.accounts.default';
const RECOVERED_KEY = 'ccc.accounts.recovered.v1';
const PENDING_LABEL = 'New account (logging in…)';
const BIN_DIR = path.join(CCC_HOME, 'bin');
const MCP_NAME = 'ccc-accounts';
const MCP_SCRIPTS = ['ccc-mcp.js', 'ccc-runner-lib.js', 'ccc-delegate.js'];

interface Task { meta: TaskMeta; status: TaskStatus; dir: string }
type Node = { kind: 'account'; a: Account } | { kind: 'tasks' } | { kind: 'task'; t: Task };

function claudePath(): string { return vscode.workspace.getConfiguration('ccc.limits').get<string>('claudePath', 'claude'); }
function claudeExe(): string | undefined {
  return resolveClaudeExe(claudePath(), process.env.PATH ?? process.env.Path ?? '', process.platform, (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
}
function readJson<T>(f: string): T | undefined { try { return JSON.parse(fs.readFileSync(f, 'utf8')) as T; } catch { return undefined; } }
function alive(pid?: number): boolean { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } }

/** `claude auth status --json` (exits 1 when logged out, stdout still JSON). Never reads credential files. */
function authStatus(exe: string, a: Account): Promise<{ loggedIn?: boolean; email?: string; plan?: string }> {
  return new Promise((resolve) => {
    execFile(exe, ['auth', 'status', '--json'], { timeout: 20_000, windowsHide: true, env: cliEnv(process.env, accountEnv(a)) }, (_e, stdout) => {
      try {
        const j = JSON.parse(String(stdout)) as { loggedIn?: unknown; email?: unknown; subscriptionType?: unknown };
        resolve({ loggedIn: Boolean(j.loggedIn), email: typeof j.email === 'string' ? j.email : undefined, plan: typeof j.subscriptionType === 'string' ? j.subscriptionType : undefined });
      } catch { resolve({}); }
    }).stdin?.end();
  });
}
/** Runs the claude exe with fixed args, no shell; resolves exit code + output. */
function runExe(exe: string, args: string[], env?: Record<string, string>): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const c = spawn(exe, args, { shell: false, windowsHide: true, env: cliEnv(process.env, env) });
    let out = '';
    c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; });
    c.on('error', (e) => resolve({ code: -1, out: e.message }));
    c.on('close', (code) => resolve({ code, out: out.slice(-2000) }));
    c.stdin.end();
  });
}
/** Copies the MCP server + runner to ~/.claude-control-center/bin (stable path across extension updates). */
function syncBin(extensionPath: string): void {
  fs.mkdirSync(BIN_DIR, { recursive: true });
  for (const f of MCP_SCRIPTS) {
    const body = fs.readFileSync(path.join(extensionPath, 'hooks', f));
    const dst = path.join(BIN_DIR, f);
    let cur: Buffer | undefined;
    try { cur = fs.readFileSync(dst); } catch { cur = undefined; }
    if (!cur || !cur.equals(body)) { fs.writeFileSync(`${dst}.tmp`, body); fs.renameSync(`${dst}.tmp`, dst); }
  }
}

export interface AccountsInfo {
  enabled: boolean;
  main?: { email?: string; plan?: string };
  subs: { label: string; fiveHour?: number; weekly?: number }[];
  runningTasks: number;
}

export function registerAccounts(context: vscode.ExtensionContext, _api: CccApi): { onDidChange: vscode.Event<void>; info: () => AccountsInfo; tasks: () => { id: string; state: string; label: string }[] } {
  const enabled = () => vscode.workspace.getConfiguration('ccc.accounts').get<boolean>('enabled', true);
  const status = new Map<string, AccountStatus>();
  const tasks = new Map<string, Task>();
  const terms = new Map<string, vscode.Terminal>();
  const emitter = new vscode.EventEmitter<void>();

  let accounts: Account[] = context.globalState.get<Account[]>(KEY) ?? [];
  if (!accounts.length) accounts = [{ id: 'main', label: 'Main', role: 'main', enabled: true, color: COLORS[0] }];
  // One-off: re-add sub-account config dirs a stale window dropped from the list (before reload() existed).
  if (!context.globalState.get<boolean>(RECOVERED_KEY)) {
    let dirs: string[] = [];
    try { dirs = fs.readdirSync(ACCOUNTS_DIR).filter((d) => /^[a-z0-9]{6,40}$/.test(d) && fs.existsSync(path.join(ACCOUNTS_DIR, d, '.claude.json'))); } catch { /* none */ }
    for (const id of dirs) if (!accounts.some((a) => a.id === id)) accounts.push({ id, label: PENDING_LABEL, role: 'sub', configDir: path.join(ACCOUNTS_DIR, id), enabled: true, color: COLORS[accounts.length % COLORS.length] });
    void context.globalState.update(KEY, accounts).then(() => context.globalState.update(RECOVERED_KEY, true));
  }
  /** Every window holds its own copy; re-read the shared list before acting so a stale window can't overwrite another's edits. */
  const reload = () => { const g = context.globalState.get<Account[]>(KEY); if (g?.length) accounts = g; };
  let defaultId = context.globalState.get<string>(DEFAULT_KEY);
  const dcfg = () => vscode.workspace.getConfiguration('ccc.delegate');
  // accounts.json for the MCP server (hooks/ccc-mcp.js): labels/status/workspaces only, no secrets.
  const writeAccountsFile = () => {
    reload();
    try {
      const data = accountsFile(accounts, status, {
        exe: claudeExe(), workspaces: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath), defaultAccountId: defaultId,
        allowRunFromMcp: dcfg().get<boolean>('allowRunFromMcp', false), allowMainFromMcp: dcfg().get<boolean>('allowMainFromMcp', false),
        maxConcurrent: dcfg().get<number>('maxConcurrent', 2),
        routing: { heavy: dcfg().get<string>('routing.heavy', 'auto'), light: dcfg().get<string>('routing.light', 'auto'), heavyModel: dcfg().get<string>('routing.heavyModel', 'opus'), lightModel: dcfg().get<string>('routing.lightModel', 'haiku') }
      });
      // Delegated sessions' transcripts live under each account's own config dir.
      setExtraTranscriptRoots(accounts.filter((a) => a.configDir).map((a) => path.join(a.configDir as string, 'projects')));
      fs.mkdirSync(CCC_HOME, { recursive: true });
      const f = path.join(CCC_HOME, 'accounts.json');
      fs.writeFileSync(`${f}.tmp`, JSON.stringify(data, null, 2), { mode: 0o600 }); fs.renameSync(`${f}.tmp`, f);
    } catch { /* best effort */ }
  };
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusBar.command = 'ccc.accounts.switchDefault';
  const updateStatusBar = () => {
    const d = accounts.find((a) => a.id === defaultId);
    statusBar.text = `$(account) ${d ? d.label : 'Auto'}`;
    statusBar.tooltip = 'Default Claude delegation account (click to switch)';
    if (enabled()) statusBar.show(); else statusBar.hide();
  };
  emitter.event(() => { writeAccountsFile(); updateStatusBar(); });
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('ccc.delegate')) emitter.fire(); }));
  const save = async () => { await context.globalState.update(KEY, accounts); emitter.fire(); };
  try { syncBin(context.extensionPath); } catch { /* MCP install will retry */ }

  // ---- tasks on disk ----
  const loadTasks = () => {
    let ids: string[] = [];
    try { ids = fs.readdirSync(TASKS_DIR); } catch { /* none yet */ }
    for (const id of ids) {
      const dir = path.join(TASKS_DIR, id);
      const meta = readJson<{ meta: TaskMeta }>(path.join(dir, 'task.json'))?.meta;
      if (!meta) continue;
      let st = readJson<TaskStatus>(path.join(dir, 'status.json')) ?? { state: 'running' as const };
      if (st.state === 'running' && !alive(st.pid) && !terms.has(id)) st = { ...st, state: nextTaskState('running', 'failed'), error: st.error ?? 'runner gone' };
      tasks.set(id, { meta, status: st, dir });
    }
  };
  loadTasks();
  let taskTimer: NodeJS.Timeout | undefined;
  const watchTasks = () => {
    if (taskTimer) return;
    taskTimer = setInterval(() => {
      loadTasks(); emitter.fire();
      if (![...tasks.values()].some((t) => t.status.state === 'running')) { clearInterval(taskTimer); taskTimer = undefined; }
    }, 2000);
  };

  // ---- tree ----
  const tree: vscode.TreeDataProvider<Node> = {
    onDidChangeTreeData: emitter.event,
    getChildren: (n) => {
      if (!n) return [...accounts.map((a) => ({ kind: 'account' as const, a })), { kind: 'tasks' as const }];
      if (n.kind === 'tasks') return [...tasks.values()].sort((x, y) => y.meta.createdAt - x.meta.createdAt).slice(0, 30).map((t) => ({ kind: 'task' as const, t }));
      return [];
    },
    getTreeItem: (n) => {
      if (n.kind === 'tasks') {
        const i = new vscode.TreeItem('Tasks', vscode.TreeItemCollapsibleState.Expanded);
        i.contextValue = 'tasks'; i.iconPath = new vscode.ThemeIcon('tasklist');
        return i;
      }
      if (n.kind === 'task') {
        const { meta, status: s } = n.t;
        const i = new vscode.TreeItem(meta.title);
        const secs = Math.round(((s.endedAt ?? Date.now()) - (s.startedAt ?? meta.createdAt)) / 1000);
        i.description = `${s.state} · ${meta.accountLabel} · ${secs}s${s.costUsd !== undefined ? ` · $${s.costUsd.toFixed(3)}` : ''}`;
        i.tooltip = `${PRESETS[meta.preset].label}${meta.model ? ` · ${meta.model}` : ''}\n${meta.cwd}${s.error ? `\n${s.error}` : ''}`;
        i.iconPath = new vscode.ThemeIcon({ running: 'sync~spin', done: 'pass', failed: 'error', cancelled: 'circle-slash' }[s.state]);
        i.contextValue = `task.${s.state}`;
        i.command = { command: 'ccc.task.openResult', title: 'Open Result', arguments: [n] };
        return i;
      }
      const { a } = n; const s = status.get(a.id) ?? {};
      const i = new vscode.TreeItem(a.label);
      const usage = s.fiveHour !== undefined || s.weekly !== undefined ? ` · 5h ${s.fiveHour ?? '?'}% · wk ${s.weekly ?? '?'}%` : '';
      const who = s.email ? ` · ${s.email}${s.plan ? ` (${s.plan})` : ''}` : '';
      i.description = `${a.role.toUpperCase()}${a.id === defaultId ? ' · default' : ''}${a.enabled ? '' : ' · disabled'}${s.loggedIn === false ? ' · not logged in' : ''}${who}${usage}`;
      i.tooltip = `${s.email ?? 'email unknown'}${s.plan ? ` · ${s.plan}` : ''}\n${a.configDir ?? 'default config dir (~/.claude)'}\n5h resets ${s.fiveHourResets ?? '?'}\nweek resets ${s.weeklyResets ?? '?'}${a.notes ? `\n\n${a.notes}` : ''}`;
      i.iconPath = new vscode.ThemeIcon(a.role === 'main' ? 'star-full' : 'account', new vscode.ThemeColor(a.enabled ? a.color : 'disabledForeground'));
      i.contextValue = `account.${a.role}.${a.enabled ? 'enabled' : 'disabled'}.${s.loggedIn ? 'in' : 'out'}`;
      return i;
    }
  };
  void tree; // ponytail: Accounts tree view replaced by the Accounts tab; provider kept for task labels, delete when unneeded

  // ---- polling ----
  const refreshAccount = async (a: Account) => {
    const exe = claudeExe();
    const s: AccountStatus = { ...status.get(a.id), ...(exe ? await authStatus(exe, a) : { loggedIn: undefined }), ts: Date.now() };
    if (s.loggedIn && s.email && a.label === PENDING_LABEL) { reload(); const cur = accounts.find((x) => x.id === a.id); if (cur) { cur.label = s.email; await context.globalState.update(KEY, accounts); } }
    if (s.loggedIn && a.enabled) {
      const u = await runUsageCli(claudePath(), 60_000, accountEnv(a));
      if (u) { s.fiveHour = u.fiveHour?.usedPercentage; s.weekly = u.sevenDay?.usedPercentage; s.fiveHourResets = u.fiveHour?.resetsText; s.weeklyResets = u.sevenDay?.resetsText; }
    }
    status.set(a.id, s); emitter.fire();
  };
  let polling = false;
  const pollAll = async () => {
    if (polling || !enabled()) return;
    polling = true;
    reload();
    try { for (const a of [...accounts]) { await refreshAccount(a); await new Promise((r) => setTimeout(r, 3000)); } } finally { polling = false; }
  };
  let pollTimer: NodeJS.Timeout | undefined;
  const schedule = () => {
    if (pollTimer) clearInterval(pollTimer);
    const mins = vscode.workspace.getConfiguration('ccc.accounts').get<number>('pollMinutes', 10);
    if (enabled() && mins > 0) { void pollAll(); pollTimer = setInterval(() => void pollAll(), Math.max(1, mins) * 60_000); }
  };
  schedule();

  // ---- helpers ----
  const accountOf = async (arg: unknown, placeHolder: string, filter: (a: Account) => boolean = () => true): Promise<Account | undefined> => {
    const n = arg as Node | undefined;
    if (n && n.kind === 'account') return accounts.find((x) => x.id === n.a.id) ?? n.a;
    const pick = await vscode.window.showQuickPick(accounts.filter(filter).map((a) => ({ label: a.label, description: a.role.toUpperCase(), a })), { placeHolder });
    return pick?.a;
  };
  const taskOf = (arg: unknown) => { const n = arg as Node | undefined; return n && n.kind === 'task' ? tasks.get(n.t.meta.id) ?? n.t : undefined; };
  const termFor = (name: string, a: Account, opts: Partial<vscode.TerminalOptions>) => vscode.window.createTerminal({
    name, color: new vscode.ThemeColor(a.color), iconPath: new vscode.ThemeIcon('hubot'),
    env: { [OWNER_ENV]: OWNER_TAG, ...accountEnv(a) }, ...opts
  });
  const needExe = () => { const e = claudeExe(); if (!e) throw new Error('Claude Code CLI not found (setting ccc.limits.claudePath).'); return e; };
  // A normal shell (user's default profile) with CLAUDE_CONFIG_DIR, then a fixed typed command, so errors stay visible.
  const shellWith = (name: string, a: Account, args: string[], cwd?: string) => {
    const cmd = shellCommand(needExe(), args, vscode.env.shell || (process.platform === 'win32' ? 'powershell.exe' : 'bash'));
    const t = termFor(name, a, { cwd });
    t.show(); t.sendText(cmd, true);
    return t;
  };
  const login = async (a: Account) => {
    const how = await vscode.window.showQuickPick([
      { label: '$(globe) Log in (browser)', manual: false },
      { label: '$(key) Log in with code (manual)', detail: 'When the browser cannot reach VS Code: open the printed URL, authorize, copy the code and paste it into the terminal.', manual: true }
    ], { placeHolder: `Log in ${a.label}` });
    if (!how) return;
    const t = shellWith(`Claude login: ${a.label}`, a, ['auth', 'login']);
    if (how.manual) void vscode.window.showInformationMessage('In the login terminal: open the URL it prints (Ctrl+click), sign in with the account for this slot, copy the code shown by the browser and paste it into the terminal, then Enter.');
    // Re-check `auth status` every 5s for 2 min, or when the terminal closes.
    const started = Date.now();
    const timer = setInterval(async () => {
      await refreshAccount(a);
      if (status.get(a.id)?.loggedIn || Date.now() - started > 120_000) { clearInterval(timer); sub.dispose(); }
    }, 5000);
    const sub = vscode.window.onDidCloseTerminal((c) => { if (c === t) { sub.dispose(); clearInterval(timer); void refreshAccount(a); } });
    context.subscriptions.push(sub, { dispose: () => clearInterval(timer) });
  };

  // ---- delegate ----
  const runTask = async (a: Account, prompt: string, preset: Preset, model: string | undefined, cwd: string, title: string) => {
    const max = vscode.workspace.getConfiguration('ccc.delegate').get<number>('maxConcurrent', 2);
    if ([...tasks.values()].filter((t) => t.status.state === 'running').length >= max) {
      throw new Error(`${max} delegated task(s) already running (ccc.delegate.maxConcurrent).`); // ponytail: refuse instead of queueing
    }
    const exe = claudeExe();
    if (!exe) throw new Error('Claude Code CLI not found (setting ccc.limits.claudePath).');
    const id = newId();
    const dir = path.join(TASKS_DIR, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'prompt.txt'), prompt, { encoding: 'utf8', mode: 0o600 });
    // Sub-account config dirs lack our hooks; --settings is additive (lists merge, other keys kept).
    let settingsFile: string | undefined;
    const hookJs = path.join(CCC_HOME, 'hooks', 'ccc-hook.js');
    if (a.configDir && fs.existsSync(hookJs)) {
      settingsFile = path.join(dir, 'settings.json');
      fs.writeFileSync(settingsFile, JSON.stringify({ hooks: buildHooksBlock(hookCommand(CCC_HOME)) }));
    }
    const meta: TaskMeta = { id, accountId: a.id, accountLabel: a.label, preset, model, cwd, title: title.slice(0, 80), createdAt: Date.now() };
    fs.writeFileSync(path.join(dir, 'task.json'), JSON.stringify({ exe, args: buildClaudeArgs({ preset, model, settingsFile }), cwd, meta }));
    const runner = path.join(context.extensionPath, 'hooks', 'ccc-delegate.js');
    const t = termFor('Claude', a, { shellPath: process.execPath, shellArgs: [runner, id], cwd, env: { [OWNER_ENV]: OWNER_TAG, ...accountEnv(a), ELECTRON_RUN_AS_NODE: '1' } });
    terms.set(id, t);
    tasks.set(id, { meta, status: { state: 'running', startedAt: Date.now() }, dir });
    t.show(true);
    emitter.fire(); watchTasks();
  };

  const delegate = async (arg: unknown, uri?: vscode.Uri) => {
    if (!enabled()) { void vscode.window.showInformationMessage('Accounts are disabled (ccc.accounts.enabled).'); return; }
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!ws) throw new Error('Open a workspace folder first.');
    // Context from the editor (context menu passes a Uri) — selection, else the file path.
    let ctx = '';
    const ed = vscode.window.activeTextEditor;
    const fileUri = uri instanceof vscode.Uri ? uri : (arg instanceof vscode.Uri ? arg : undefined);
    if (fileUri || (ed && !(arg as Node | undefined)?.kind)) {
      const doc = fileUri && ed?.document.uri.toString() !== fileUri.toString() ? undefined : ed?.document;
      const rel = vscode.workspace.asRelativePath(fileUri ?? doc!.uri);
      const sel = doc && ed && !ed.selection.isEmpty ? doc.getText(ed.selection) : '';
      ctx = sel ? `\n\nContext: ${rel} (lines ${ed!.selection.start.line + 1}-${ed!.selection.end.line + 1})\n\`\`\`\n${sel}\n\`\`\`` : `\n\nContext file: ${rel}`;
    }
    let a = (arg as Node | undefined)?.kind === 'account' ? (arg as { a: Account }).a : undefined;
    if (!a) {
      const auto = pickAutoAccount(accounts, status);
      const pick = await vscode.window.showQuickPick([
        { label: '$(sparkle) Auto', description: auto ? `→ ${auto.label}` : 'no eligible sub-account', a: auto },
        ...accounts.filter((x) => x.enabled).sort((x) => (x.id === defaultId ? -1 : 0)).map((x) => ({ label: x.label, description: `${x.role.toUpperCase()}${status.get(x.id)?.fiveHour !== undefined ? ` · 5h ${status.get(x.id)!.fiveHour}%` : ''}`, a: x as Account | undefined }))
      ], { placeHolder: 'Delegate to which Claude account?' });
      if (!pick) return;
      a = pick.a;
      if (!a) throw new Error('No enabled, logged-in sub-account under 90% 5h usage. Pick one explicitly.');
    }
    const prompt = await vscode.window.showInputBox({ prompt: `Task for ${a.label} (standalone; it has no context from this chat)`, ignoreFocusOut: true, validateInput: (v) => v.trim() ? undefined : 'Required' });
    if (!prompt) return;
    const defPreset = a.defaultPreset ?? dcfg().get<Preset>('defaultPreset', 'readonly');
    const presetPick = await vscode.window.showQuickPick((Object.keys(PRESETS) as Preset[]).map((k) => ({
      label: PRESETS[k].label, description: PRESETS[k].tools.join(', ') + (k === defPreset ? ' (default)' : ''), k
    })).sort((x) => (x.k === defPreset ? -1 : 0)), { placeHolder: 'Permissions for the delegated session' });
    if (!presetPick) return;
    if (presetPick.k === 'bash') {
      const ok = await vscode.window.showWarningMessage(`Let ${a.label} run shell commands (Bash) in ${ws} without asking?`, { modal: true }, 'Allow Bash');
      if (ok !== 'Allow Bash') return;
    }
    const defModel = a.defaultModel ?? dcfg().get<string>('defaultModel', 'default');
    const modelPick = await vscode.window.showQuickPick(MODELS.map((m) => ({ label: m, description: m === defModel ? '(default)' : '' })).sort((x) => (x.label === defModel ? -1 : 0)), { placeHolder: 'Model' });
    if (!modelPick) return;
    await runTask(a, prompt + ctx, presetPick.k, modelPick.label === 'default' ? undefined : modelPick.label, ws, prompt.split('\n')[0]);
  };

  // ---- commands ----
  const reg = (id: string, fn: (...args: unknown[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(id, async (...args: unknown[]) => {
    reload();
    try { await fn(...args); } catch (e) { void vscode.window.showErrorMessage(`Claude Control Center: ${e instanceof Error ? e.message : 'command failed'}`); }
  }));

  reg('ccc.delegateTask', (arg, uri) => delegate(arg, uri as vscode.Uri | undefined));
  reg('ccc.accounts.add', async () => {
    const label = await vscode.window.showInputBox({ prompt: 'Sub-account label (leave empty to use the login email)', validateInput: (v) => v.length <= 40 ? undefined : 'Max 40 characters' });
    if (label === undefined) return;
    const id = newId();
    const configDir = path.join(ACCOUNTS_DIR, id);
    fs.mkdirSync(configDir, { recursive: true });
    const a: Account = { id, label: label.trim() || PENDING_LABEL, role: 'sub', configDir, enabled: true, color: COLORS[accounts.length % COLORS.length] };
    accounts.push(a); await save();
    await login(a);
  });
  reg('ccc.accounts.login', async (arg) => { const a = await accountOf(arg, 'Log in which account?'); if (a) await login(a); });
  reg('ccc.accounts.rename', async (arg) => {
    const a = await accountOf(arg, 'Rename which account?'); if (!a) return;
    const v = await vscode.window.showInputBox({ prompt: 'New label', value: a.label, validateInput: (x) => x.trim() && x.length <= 40 ? undefined : '1-40 characters' });
    if (v) { a.label = v.trim(); await save(); }
  });
  reg('ccc.accounts.logout', async (arg) => {
    const a = await accountOf(arg, 'Log out which account?'); if (!a) return;
    if (await vscode.window.showWarningMessage(`Log out "${a.label}" (claude auth logout${a.configDir ? ` in ${a.configDir}` : ' for ~/.claude — this also logs out the main CLI login'})?`, { modal: true }, 'Log Out') !== 'Log Out') return;
    const r = await runExe(needExe(), ['auth', 'logout'], accountEnv(a));
    if (r.code !== 0) void vscode.window.showWarningMessage(`claude auth logout exited ${r.code}: ${r.out.trim().slice(0, 300)}`);
    await refreshAccount(a);
  });
  reg('ccc.accounts.edit', async (arg) => {
    const a = await accountOf(arg, 'Edit which account?'); if (!a) return;
    for (;;) {
      const cur = accounts.find((x) => x.id === a.id) ?? a;
      const f = await vscode.window.showQuickPick([
        { label: 'Label', description: cur.label, k: 'label' }, { label: 'Color', description: cur.color.replace('terminal.ansi', ''), k: 'color' },
        { label: 'Role', description: cur.role, k: 'role' }, { label: 'Enabled', description: String(cur.enabled), k: 'enabled' },
        { label: 'Default model', description: cur.defaultModel ?? '(global)', k: 'model' }, { label: 'Default preset', description: cur.defaultPreset ? PRESETS[cur.defaultPreset].label : '(global)', k: 'preset' },
        { label: 'Notes', description: cur.notes ?? '', k: 'notes' }, { label: '$(check) Done', k: 'done' }
      ], { placeHolder: `Edit ${cur.label}` });
      if (!f || f.k === 'done') return;
      let patch: Parameters<typeof applyAccountEdit>[2] | undefined;
      if (f.k === 'label') { const v = await vscode.window.showInputBox({ value: cur.label, validateInput: (x) => x.trim() && x.length <= 40 ? undefined : '1-40 characters' }); if (v) patch = { label: v }; }
      if (f.k === 'color') { const v = await vscode.window.showQuickPick(COLORS.map((c) => ({ label: c.replace('terminal.ansi', ''), c }))); if (v) patch = { color: v.c }; }
      if (f.k === 'role') { const v = await vscode.window.showQuickPick(['main', 'sub'], { placeHolder: 'main = your ~/.claude login (only one)' }); if (v) patch = { role: v as 'main' | 'sub' }; }
      if (f.k === 'enabled') patch = { enabled: !cur.enabled };
      if (f.k === 'model') { const v = await vscode.window.showQuickPick(['(global)', ...MODELS]); if (v) patch = { defaultModel: v === '(global)' ? undefined : v }; }
      if (f.k === 'preset') { const v = await vscode.window.showQuickPick([{ label: '(global)', k: undefined as Preset | undefined }, ...(Object.keys(PRESETS) as Preset[]).map((k) => ({ label: PRESETS[k].label, k: k as Preset | undefined }))]); if (v) patch = { defaultPreset: v.k }; }
      if (f.k === 'notes') { const v = await vscode.window.showInputBox({ value: cur.notes ?? '', prompt: 'Notes (shown in tooltip)' }); if (v !== undefined) patch = { notes: v || undefined }; }
      if (patch) { accounts = applyAccountEdit(accounts, a.id, patch); await save(); }
    }
  });
  reg('ccc.accounts.switchDefault', async () => {
    const pick = await vscode.window.showQuickPick([
      { label: '$(sparkle) Auto', description: 'lowest 5h usage sub-account', id: undefined as string | undefined },
      ...accounts.filter((x) => x.enabled).map((x) => ({ label: x.label, description: `${x.role.toUpperCase()}${status.get(x.id)?.email ? ` · ${status.get(x.id)!.email}` : ''}${x.id === defaultId ? ' · current' : ''}`, id: x.id as string | undefined }))
    ], { placeHolder: 'Default delegation account' });
    if (!pick) return;
    defaultId = pick.id; await context.globalState.update(DEFAULT_KEY, defaultId); emitter.fire();
  });
  reg('ccc.accounts.setDefault', async (...a) => {
    if (!a.length) { await vscode.commands.executeCommand('ccc.accounts.switchDefault'); return; }
    const id = a[0];
    if (id !== undefined && !accounts.some((x) => x.id === id && x.enabled)) return;
    defaultId = id as string | undefined; await context.globalState.update(DEFAULT_KEY, defaultId); emitter.fire();
  });
  reg('ccc.accounts.openClaude', async (arg) => {
    const a = await accountOf(arg, 'Open Claude as which account?'); if (!a) return;
    shellWith(`Claude: ${a.label}`, a, [], vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
  });
  const mcpScript = path.join(BIN_DIR, 'ccc-mcp.js');
  reg('ccc.installMcp', async () => {
    const exe = needExe();
    const args = ['mcp', 'add', '--scope', 'user', MCP_NAME, '--', 'node', mcpScript];
    if (await vscode.window.showWarningMessage(`Register the Control Center MCP server for Claude Code (user scope)?\n\nRuns: claude ${args.map((x) => (/\s/.test(x) ? `"${x}"` : x)).join(' ')}\n\nThe main agent gets tools list_accounts, delegate_task, get_task_result (read/edit presets; Bash only with ccc.delegate.allowRunFromMcp).`, { modal: true }, 'Install') !== 'Install') return;
    syncBin(context.extensionPath); writeAccountsFile();
    const r = await runExe(exe, args);
    if (r.code === 0) void vscode.window.showInformationMessage('MCP server ccc-accounts installed. Restart Claude Code sessions to load it.');
    else throw new Error(`claude mcp add failed (${r.code}): ${r.out.trim().slice(0, 300)}`);
  });
  reg('ccc.uninstallMcp', async () => {
    if (await vscode.window.showWarningMessage(`Remove MCP server ${MCP_NAME}?\n\nRuns: claude mcp remove --scope user ${MCP_NAME}`, { modal: true }, 'Remove') !== 'Remove') return;
    const r = await runExe(needExe(), ['mcp', 'remove', '--scope', 'user', MCP_NAME]);
    if (r.code === 0) void vscode.window.showInformationMessage('MCP server removed.');
    else throw new Error(`claude mcp remove failed (${r.code}): ${r.out.trim().slice(0, 300)}`);
  });
  reg('ccc.accounts.toggle', async (arg) => { const a = await accountOf(arg, 'Enable/disable which account?'); if (a) { a.enabled = !a.enabled; await save(); } });
  reg('ccc.accounts.setMain', async (arg) => {
    const a = await accountOf(arg, 'Set which account as main?'); if (!a) return;
    for (const x of accounts) x.role = x === a ? 'main' : 'sub';
    await save();
  });
  reg('ccc.accounts.remove', async (arg) => {
    const a = await accountOf(arg, 'Remove which account?'); if (!a) return;
    if (await vscode.window.showWarningMessage(`Remove account "${a.label}" from Control Center?`, { modal: true }, 'Remove') !== 'Remove') return;
    accounts = accounts.filter((x) => x !== a); status.delete(a.id); await save();
    const dir = a.configDir;
    if (dir && path.dirname(path.resolve(dir)) === path.resolve(ACCOUNTS_DIR) && fs.existsSync(dir)) {
      const del = await vscode.window.showWarningMessage(`Also permanently delete its config dir (login, history)?\n${dir}`, { modal: true }, 'Delete Folder');
      if (del === 'Delete Folder') fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  reg('ccc.accounts.refresh', async (arg) => { const n = arg as Node | undefined; if (n?.kind === 'account') await refreshAccount(n.a); else await pollAll(); });
  reg('ccc.task.focus', (arg) => { const t = taskOf(arg); const term = t && terms.get(t.meta.id); if (term) term.show(); else void vscode.window.showInformationMessage('That task terminal is no longer open.'); });
  reg('ccc.task.openResult', async (arg) => {
    const t = taskOf(arg); if (!t) return;
    const f = path.join(t.dir, 'result.md');
    if (!fs.existsSync(f)) { terms.get(t.meta.id)?.show(); return; }
    await vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(f));
  });
  reg('ccc.task.cancel', async (arg) => {
    const t = taskOf(arg); if (!t || t.status.state !== 'running') return;
    const pid = readJson<TaskStatus>(path.join(t.dir, 'status.json'))?.pid;
    if (await vscode.window.showWarningMessage(`Cancel delegated task "${t.meta.title}"?`, { modal: true }, 'Cancel Task') !== 'Cancel Task') return;
    fs.writeFileSync(path.join(t.dir, 'cancel'), '');
    if (pid && alive(pid)) process.kill(pid); // only the claude child our runner recorded
    else terms.get(t.meta.id)?.dispose();
  });
  reg('ccc.task.rerun', async (arg) => {
    const t = taskOf(arg); if (!t) return;
    const a = accounts.find((x) => x.id === t.meta.accountId);
    if (!a) throw new Error('The account of that task was removed.');
    if (t.meta.preset === 'bash' && await vscode.window.showWarningMessage(`Re-run with Bash allowed on ${a.label}?`, { modal: true }, 'Allow Bash') !== 'Allow Bash') return;
    await runTask(a, fs.readFileSync(path.join(t.dir, 'prompt.txt'), 'utf8'), t.meta.preset, t.meta.model, t.meta.cwd, t.meta.title);
  });

  // MCP-run tasks are written by another process: watch the tasks dir.
  let dirWatch: fs.FSWatcher | undefined;
  try { fs.mkdirSync(TASKS_DIR, { recursive: true }); dirWatch = fs.watch(TASKS_DIR, () => { loadTasks(); emitter.fire(); watchTasks(); }); } catch { /* polling only */ }
  updateStatusBar(); writeAccountsFile();
  context.subscriptions.push(emitter, statusBar, { dispose: () => dirWatch?.close() },
    vscode.workspace.onDidChangeWorkspaceFolders(() => writeAccountsFile()),
    { dispose: () => { if (pollTimer) clearInterval(pollTimer); if (taskTimer) clearInterval(taskTimer); } },
    vscode.window.onDidCloseTerminal((c) => { for (const [id, t] of terms) if (t === c) terms.delete(id); }),
    vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('ccc.accounts')) schedule(); if (e.affectsConfiguration('ccc.accounts') || e.affectsConfiguration('ccc.delegate')) emitter.fire(); }));
  if ([...tasks.values()].some((t) => t.status.state === 'running')) watchTasks();
  return {
    onDidChange: emitter.event,
    tasks: () => [...tasks].map(([id, t]) => ({ id, state: t.status.state as string, label: t.meta.accountLabel })),
    info: () => {
      const main = accounts.find((a) => a.role === 'main');
      const ms = main && status.get(main.id);
      return {
        enabled: enabled(),
        main: ms ? { email: ms.email, plan: ms.plan } : undefined,
        subs: accounts.filter((a) => a.role === 'sub' && a.enabled).map((a) => ({ label: a.label, fiveHour: status.get(a.id)?.fiveHour, weekly: status.get(a.id)?.weekly })),
        runningTasks: [...tasks.values()].filter((t) => t.status.state === 'running').length
      };
    }
  };
}
