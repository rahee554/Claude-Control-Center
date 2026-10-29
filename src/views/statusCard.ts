// Pure builder for the Copilot-style status bar item (text + hover card markdown). vscode-free for unit tests.

/** Only these command ids may be invoked from the tooltip's command: links (MarkdownString isTrusted.enabledCommands). */
export const CARD_COMMANDS = {
  activity: 'ccc.dashboard.focus',
  changes: 'ccc.openChanges',
  delegate: 'ccc.delegateTask',
  refresh: 'ccc.refreshLimits',
  settings: 'workbench.action.openSettings',
  pause: 'ccc.pauseMonitoring',
  resume: 'ccc.resumeMonitoring',
  toggle: 'ccc.toggle',
  installMcp: 'ccc.installMcp'
} as const;
export const ALLOWED_COMMANDS: string[] = Object.values(CARD_COMMANDS);
/** Feature keys the card may toggle via ccc.toggle (the command re-validates against this list). */
export const CARD_TOGGLES = ['monitoring', 'mirror', 'chatBox', 'delegation', 'limits'] as const;

export interface CardLimit { pct: number; resetsAt?: number }
export interface CardInput {
  now: number;
  account?: { email?: string; plan?: string };
  fiveHour?: CardLimit;
  sevenDay?: CardLimit;
  limitsAt?: number;
  limitsSource?: string;
  staleAfterMs?: number;
  subs?: { label: string; fiveHour?: number; weekly?: number }[];
  context?: { pct: number; tokens: number };
  active: number;
  models: { opus: number; sonnet: number; haiku: number };
  currentTool?: string;
  tasks: number;
  messages?: number;
  files?: { count: number; added: number; removed: number };
  paused: boolean;
  features?: { key: string; label: string; on: boolean }[];
  mcp?: boolean;
}

export function duration(ms: number): string {
  if (ms <= 0) return 'now';
  const m = Math.ceil(ms / 60_000);
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  return d ? `${d}d ${h}h` : h ? `${h}h ${mm}m` : `${mm}m`;
}

/** resetsAt may be epoch seconds (status line, CLI) or ms; normalise to ms. */
export function resetMs(t: number): number { return t < 1e11 ? t * 1000 : t; }

/** Solid bar from two background-colour spans of non-breaking spaces (hex colours on span survive VS Code's sanitizer). */
export function meter(pct: number, cells = 36): string {
  const n = Math.round((Math.min(Math.max(pct, 0), 100) / 100) * cells);
  const col = pct >= 85 ? '#f14c4c' : pct >= 60 ? '#cca700' : '#3794ff';
  const sp = (c: string, k: number) => k > 0 ? `<span style="background-color:${c};">${'&nbsp;'.repeat(k)}</span>` : '';
  return sp(col, n) + sp('#3c3c3c', cells - n);
}

const esc = (s: string) => s.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
const link = (label: string, cmd: string, args?: unknown) => `[${label}](command:${cmd}${args === undefined ? '' : `?${encodeURIComponent(JSON.stringify(args))}`})`;

function limitBlock(name: string, l: CardLimit | undefined, now: number): string[] {
  if (!l) return [`${name} · _Unavailable_`, ''];
  let reset = '';
  if (l.resetsAt) {
    const at = resetMs(l.resetsAt), left = at - now;
    const t = new Date(at).toLocaleString('en-US', left < 24 * 3_600_000 ? { hour: 'numeric', minute: '2-digit' } : { weekday: 'short', hour: 'numeric', minute: '2-digit' });
    reset = ` · _Resets ${t} (in ${duration(left)})_`;
  }
  return [`${name} · ${Math.round(l.pct)}%${reset}  `, meter(l.pct, 30), ''];
}

export function statusText(i: CardInput): string {
  if (i.paused) return '$(ccc-claude) $(debug-pause)';
  if (i.active > 0) return `$(ccc-claude) ${i.active}`;
  return `$(ccc-claude) ${i.fiveHour ? `${Math.round(i.fiveHour.pct)}%` : ''}`.trim();
}

export function buildCard(i: CardInput): string {
  const plan = i.account?.plan ? ` · ${esc(i.account.plan)}` : '';
  const out: string[] = [`**$(ccc-claude) Claude Code${plan}**`, '', ...limitBlock('5h', i.fiveHour, i.now), ...limitBlock('Weekly', i.sevenDay, i.now)];
  out.push(i.context ? `Context · ${Math.round(i.context.pct)}%  ` : 'Context · _Unavailable_  ');
  out.push(`$(sync) ${i.active} active agent${i.active === 1 ? '' : 's'}`, '');
  out.push(`_${[link('Open panel', CARD_COMMANDS.activity), link('Refresh', CARD_COMMANDS.refresh), link('Settings', CARD_COMMANDS.settings, ['@ext:pfxtoolkit.claude-code-control-center'])].join(' · ')}_`);
  return out.join('\n');
}
