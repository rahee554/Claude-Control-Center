// Pure account / delegation logic (no vscode import) so it can be unit tested.
import * as path from 'path';

export type Role = 'main' | 'sub';
export interface Account {
  id: string;
  label: string;
  role: Role;
  /** undefined = Claude Code's default config dir (no CLAUDE_CONFIG_DIR). */
  configDir?: string;
  enabled: boolean;
  color: string;
  defaultModel?: string;
  defaultPreset?: Preset;
  notes?: string;
}
export interface AccountStatus { loggedIn?: boolean; email?: string; plan?: string; fiveHour?: number; weekly?: number; fiveHourResets?: string; weeklyResets?: string; ts?: number }

export const COLORS = ['terminal.ansiCyan', 'terminal.ansiMagenta', 'terminal.ansiYellow', 'terminal.ansiGreen', 'terminal.ansiBlue', 'terminal.ansiRed'];
export const AUTO_SKIP_PCT = 90;

/** Env for a child `claude` process of this account; main/default account adds nothing. */
export function accountEnv(a: Pick<Account, 'configDir'>): Record<string, string> {
  return a.configDir ? { CLAUDE_CONFIG_DIR: a.configDir } : {};
}

/** "Auto": enabled, logged-in sub-account with the lowest 5h usage, skipping >= 90% (unknown usage sorts last). */
export function pickAutoAccount(accounts: Account[], status: Map<string, AccountStatus>): Account | undefined {
  return accounts
    .filter((a) => a.role === 'sub' && a.enabled && status.get(a.id)?.loggedIn)
    .filter((a) => (status.get(a.id)?.fiveHour ?? 0) < AUTO_SKIP_PCT)
    .sort((a, b) => (status.get(a.id)?.fiveHour ?? 99) - (status.get(b.id)?.fiveHour ?? 99))[0];
}

export type Preset = 'readonly' | 'edit' | 'bash';
export const PRESETS: Record<Preset, { label: string; tools: string[] }> = {
  readonly: { label: 'Read-only', tools: ['Read', 'Glob', 'Grep'] },
  edit: { label: 'Edit files', tools: ['Read', 'Glob', 'Grep', 'Edit', 'Write'] },
  bash: { label: 'Edit + run commands', tools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'] }
};
export const MODELS = ['default', 'haiku', 'sonnet', 'opus'] as const;

/** argv for `claude` (after the executable). The prompt is NEVER in argv; it is piped via stdin. */
export function buildClaudeArgs(o: { preset: Preset; model?: string; settingsFile?: string }): string[] {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--allowedTools', PRESETS[o.preset].tools.join(',')];
  if (o.model && o.model !== 'default' && (MODELS as readonly string[]).includes(o.model)) args.push('--model', o.model);
  if (o.settingsFile) args.push('--settings', o.settingsFile);
  return args;
}

/**
 * Resolves the real claude executable so it can be spawned with shell:false.
 * Windows: claude.exe on PATH, else the npm shim's bundled bin/claude.exe.
 */
export function resolveClaudeExe(claudePath: string, pathEnv: string, platform: string, exists: (p: string) => boolean): string | undefined {
  const win = platform === 'win32';
  const p = win ? path.win32 : path.posix;
  if (p.isAbsolute(claudePath)) {
    if (win && /\.cmd$/i.test(claudePath)) {
      const exe = p.join(p.dirname(claudePath), 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
      return exists(exe) ? exe : undefined;
    }
    return exists(claudePath) ? claudePath : undefined;
  }
  for (const dir of pathEnv.split(win ? ';' : ':').filter(Boolean)) {
    if (win) {
      const exe = p.join(dir, `${claudePath}.exe`);
      if (exists(exe)) return exe;
      const shim = p.join(dir, `${claudePath}.cmd`);
      if (exists(shim)) {
        const r = resolveClaudeExe(shim, '', platform, exists);
        if (r) return r;
      }
    } else {
      const f = p.join(dir, claudePath);
      if (exists(f)) return f;
    }
  }
  return undefined;
}

export type TaskState = 'running' | 'done' | 'failed' | 'cancelled';
export interface TaskMeta {
  id: string; accountId: string; accountLabel: string; preset: Preset; model?: string;
  cwd: string; title: string; createdAt: number;
}
export interface TaskStatus { state: TaskState; pid?: number; startedAt?: number; endedAt?: number; costUsd?: number; error?: string; sessionId?: string; inputTokens?: number; outputTokens?: number }

/** Terminal states never go back to running; running may end in any terminal state. */
export function nextTaskState(cur: TaskState, next: TaskState): TaskState {
  return cur === 'running' ? next : cur;
}

export function newId(now = Date.now(), rnd = Math.random()): string {
  return `${now.toString(36)}${Math.floor(rnd * 1e6).toString(36)}`;
}

/**
 * Command line typed into a normal shell terminal to run the claude exe with fixed args.
 * The exe path is validated (no quotes/shell metacharacters) and quoted; args are constants.
 */
export function shellCommand(exe: string, args: string[], shell: string): string {
  if (!/^[\w .:\\/()@+~-]+$/.test(exe)) throw new Error(`Unsafe Claude CLI path: ${exe}`);
  if (args.some((a) => !/^[\w-]+$/.test(a))) throw new Error('Unsafe argument');
  const tail = args.length ? ` ${args.join(' ')}` : '';
  const sh = path.posix.basename(shell.replace(/\\/g, '/')).toLowerCase();
  if (/^(pwsh|powershell)/.test(sh)) return `& "${exe}"${tail}`;
  if (/^(bash|sh|zsh|fish)/.test(sh) && /^[A-Za-z]:\\/.test(exe)) return `"${exe.replace(/\\/g, '/')}"${tail}`;
  return `"${exe}"${tail}`;
}

export type AccountPatch = Partial<Pick<Account, 'label' | 'color' | 'role' | 'enabled' | 'defaultModel' | 'defaultPreset' | 'notes'>>;
/** Returns a new list with the patch applied; at most one main (making one main demotes the other). */
export function applyAccountEdit(accounts: Account[], id: string, patch: AccountPatch): Account[] {
  if (patch.label !== undefined && (!patch.label.trim() || patch.label.length > 40)) throw new Error('Label must be 1-40 characters');
  if (patch.defaultModel !== undefined && !(MODELS as readonly string[]).includes(patch.defaultModel)) throw new Error('Unknown model');
  if (patch.defaultPreset !== undefined && !(patch.defaultPreset in PRESETS)) throw new Error('Unknown preset');
  if (!accounts.some((a) => a.id === id)) throw new Error('Unknown account');
  return accounts.map((a) => {
    if (a.id === id) return { ...a, ...patch, label: patch.label?.trim() ?? a.label };
    return patch.role === 'main' && a.role === 'main' ? { ...a, role: 'sub' } : a;
  });
}

/** Workload routing: account (id | 'auto' | 'main') and default model per weight, used by MCP delegate_task. */
export interface Routing { heavy: string; light: string; heavyModel: string; lightModel: string }
export const DEFAULT_ROUTING: Routing = { heavy: 'auto', light: 'auto', heavyModel: 'opus', lightModel: 'haiku' };

/** Contents of ~/.claude-control-center/accounts.json read by hooks/ccc-mcp.js. No secrets. */
export function accountsFile(accounts: Account[], status: Map<string, AccountStatus>, o: {
  exe?: string; workspaces: string[]; defaultAccountId?: string; allowRunFromMcp: boolean; allowMainFromMcp: boolean; maxConcurrent: number;
  routing?: Partial<Routing>;
}) {
  return {
    exe: o.exe, workspaces: o.workspaces, defaultAccountId: o.defaultAccountId,
    settings: { allowRunFromMcp: o.allowRunFromMcp, allowMainFromMcp: o.allowMainFromMcp, maxConcurrent: o.maxConcurrent, routing: { ...DEFAULT_ROUTING, ...o.routing } },
    accounts: accounts.map((a) => {
      const s = status.get(a.id) ?? {};
      return { id: a.id, label: a.label, role: a.role, enabled: a.enabled, configDir: a.configDir, loggedIn: s.loggedIn ?? false, email: s.email, plan: s.plan, fiveHour: s.fiveHour, weekly: s.weekly };
    })
  };
}
