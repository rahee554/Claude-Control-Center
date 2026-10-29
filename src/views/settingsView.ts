// Schema + validation for the Settings page in the Activity webview. vscode-free; mirrors package.json contributes
// (test/unit/routing.test.ts keeps both in sync). Keys are relative to the `ccc` section.
export type SettingDef = { key: string; group: string; label: string; desc: string } & (
  | { type: 'bool'; def: boolean }
  | { type: 'enum'; def: string; options: string[] }
  | { type: 'number'; def: number; min: number; max: number }
  | { type: 'path'; def: string }
  | { type: 'account'; def: string }
);
const ACCOUNT_ID_RE = /^[\w-]{1,64}$/;
const A = 'Accounts & Delegation';
const MODELS = ['default', 'haiku', 'sonnet', 'opus'];
const b = (key: string, group: string, label: string, desc: string, def: boolean): SettingDef => ({ key, group, label, desc, type: 'bool', def });
const n = (key: string, group: string, label: string, desc: string, def: number, min: number, max: number): SettingDef => ({ key, group, label, desc, type: 'number', def, min, max });
const e = (key: string, group: string, label: string, desc: string, def: string, options: string[]): SettingDef => ({ key, group, label, desc, type: 'enum', def, options });
const acct = (key: string, label: string, desc: string): SettingDef => ({ key, group: A, label, desc, type: 'account', def: 'auto' });

export const SETTINGS: SettingDef[] = [
  b('checkpoints.autoOnPrompt', 'Checkpoints', 'Auto-checkpoint on prompt', 'Create a checkpoint on each prompt (debounced 30s).', false),
  n('checkpoints.keep', 'Checkpoints', 'Keep', 'Checkpoints to keep; oldest automatic ones are pruned.', 50, 1, 1000),
  n('checkpoints.maxFileKB', 'Checkpoints', 'Max file size (KB)', 'Larger files are skipped.', 2048, 1, 102400),
  n('checkpoints.maxTotalMB', 'Checkpoints', 'Max total size (MB)', 'Checkpoint is refused above this workspace size.', 200, 1, 10000),
  n('refreshIntervalSeconds', 'Monitoring', 'Refresh interval (s)', 'Fallback poll interval in addition to file watching.', 5, 1, 300),
  n('staleAfterSeconds', 'Monitoring', 'Stale after (s)', 'Agents with no events for this long are marked stale.', 120, 10, 86400),
  n('historyLimit', 'Monitoring', 'History limit', 'Maximum number of events kept in memory.', 500, 50, 10000),
  n('recentAgentsLimit', 'Monitoring', 'Recent agents', 'How many finished agents to keep listed.', 20, 0, 200),
  b('processCorrelation.enabled', 'Monitoring', 'Process correlation', 'Look up parent processes to confirm which terminals run Claude Code.', true),
  b('timeline.enabled', 'Monitoring', 'Messages timeline', 'Show the Messages timeline in the Activity view.', true),
  b('models.enabled', 'Monitoring', 'Models section', 'Show token share per model in the Activity view.', true),
  n('changes.lookbackHours', 'Changes', 'Lookback (hours)', 'Show sessions with activity in the last N hours.', 24, 1, 720),
  b('chatBox.enabled', 'Changes', 'Changes in chat box', 'Show Claude’s file changes inside the Claude Code chat.', true),
  b('mirror.enabled', 'Terminals', 'Terminal mirror', 'Mirror Bash/PowerShell calls into a read-only terminal per session.', true),
  b('mirror.showOutput', 'Terminals', 'Mirror command output', 'Let the hook record command output for the mirror.', true),
  n('mirror.maxOutputKB', 'Terminals', 'Max output (KB)', 'Maximum command output recorded per call.', 64, 1, 128),
  e('mirror.focus', 'Terminals', 'Reveal mirror', 'When to reveal the mirror terminal (never steals keyboard focus).', 'never', ['never', 'onCreate']),
  b('terminate.requireConfirmation', 'Terminals', 'Confirm closing', 'Ask before closing terminals.', true),
  b('views.terminals', 'Terminals', 'Terminals tree', 'Show the Terminals tree in the sidebar.', false),
  n('limits.pollMinutes', 'Limits', 'Poll interval (min)', 'How often to read 5h/weekly limits via `claude -p /usage`. 0 disables.', 5, 0, 120),
  { key: 'limits.claudePath', group: 'Limits', label: 'Claude CLI path', desc: 'Claude Code CLI used for /usage. Plain path only.', type: 'path', def: 'claude' },
  b('accounts.enabled', A, 'Accounts', 'Enable multiple accounts and task delegation.', true),
  n('accounts.pollMinutes', A, 'Account poll (min)', 'How often to check login and usage of each account. 0 disables.', 10, 0, 240),
  b('delegate.enabled', A, 'Delegation', 'Allow delegating tasks to sub-accounts (UI and MCP).', true),
  e('delegate.defaultPreset', A, 'Default preset', 'Default permission preset for delegated tasks.', 'readonly', ['readonly', 'edit', 'bash']),
  e('delegate.defaultModel', A, 'Default model', 'Default model for delegated tasks.', 'default', MODELS),
  n('delegate.maxConcurrent', A, 'Max concurrent', 'Maximum delegated tasks running at once.', 2, 1, 10),
  b('delegate.allowRunFromMcp', A, 'Allow run/full via MCP', 'Let delegate_task use presets run (Bash) and full.', false),
  b('delegate.allowMainFromMcp', A, 'Allow main account via MCP', 'Let delegate_task target the main account.', false),
  acct('delegate.routing.heavy', 'Heavy work goes to', 'Account for heavy delegated work: an account, Auto, or Main.'),
  acct('delegate.routing.light', 'Light work goes to', 'Account for light delegated work: an account, Auto, or Main.'),
  e('delegate.routing.heavyModel', A, 'Heavy model', 'Default model for heavy delegated work.', 'opus', MODELS),
  e('delegate.routing.lightModel', A, 'Light model', 'Default model for light delegated work.', 'haiku', MODELS),
  b('alerts.enabled', 'Alerts', 'Alerts', 'Notify when Claude needs you or a delegated task finishes.', true),
  b('alerts.permission', 'Alerts', 'Permission prompts', 'Alert on permission prompts.', true),
  b('alerts.input', 'Alerts', 'Waiting for input', 'Alert when Claude waits for your input.', true),
  b('alerts.tasks', 'Alerts', 'Delegated tasks', 'Alert when a delegated task finishes or fails.', true),
  b('alerts.whenFocused', 'Alerts', 'While focused', 'Also alert while the VS Code window is focused.', false),
  b('statusBar.enabled', 'Status bar', 'Status bar item', 'Show limits and running agents in the status bar.', true),
  b('collectPromptText', 'Privacy', 'Record prompt text', 'Let the hook record truncated prompt text (applies when hooks are reinstalled).', false),
  b('timeline.showText', 'Privacy', 'Show message text', 'Show prompt and reply text in the timeline (read locally, never sent).', true)
];

/** Returns the checked value for a known key, or undefined when the key is unknown or the value is invalid. */
export function validateSetting(key: unknown, value: unknown): unknown {
  const d = typeof key === 'string' ? SETTINGS.find((s) => s.key === key) : undefined;
  if (!d) return undefined;
  switch (d.type) {
    case 'bool': return typeof value === 'boolean' ? value : undefined;
    case 'enum': return typeof value === 'string' && d.options.includes(value) ? value : undefined;
    case 'number': return typeof value === 'number' && Number.isInteger(value) && value >= d.min && value <= d.max ? value : undefined;
    case 'path': return typeof value === 'string' && value.length <= 260 && /^[\w .:\\/()@+~-]+$/.test(value) ? value : undefined;
    case 'account': return typeof value === 'string' && (value === 'auto' || value === 'main' || ACCOUNT_ID_RE.test(value)) ? value : undefined;
  }
}
