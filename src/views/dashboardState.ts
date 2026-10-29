// Pure view-model for the Overview webview. vscode-free so it can be unit-tested.
import * as path from 'path';
import { FileChange, TranscriptStats } from '../collectors/transcriptCollector';
import { AgentInfo, AgentSnapshot, isLive } from '../services/agentState';
import { isInside } from '../services/fileHistory';
import { iconId } from './fileIcons';
import { cleanPrompt } from './timeline';
import { limitView, StatusCapture } from '../services/usageService';
import type { CliUsage } from '../services/usageCli';

export interface ChangeRow { path: string; name: string; dir: string; added: number; removed: number; created: boolean; /** Not on disk now. */ gone: boolean; icon: string }
export interface Tile {
  id: string; label: string; value: string; sub?: string;
  /** Where the value comes from (shown in tooltip/footer). */
  source: string;
  /** Epoch ms of the underlying data; undefined = n/a. */
  at?: number;
  /** Percentage 0..100 for a meter, when meaningful. */
  pct?: number;
  /** Elapsed timer: webview counts up from this epoch ms. */
  since?: number;
  tooltip?: string;
  unavailable?: boolean;
  /** Limit reset (epoch ms) for a "resets in …" countdown. */
  resetsAt?: number;
}
export interface ChangeGroup { id: string; label: string; /** Dim secondary text: folder · time. */ sub?: string; at?: number; live: boolean; added: number; removed: number; changes: ChangeRow[]; /** Account label when this is a delegated task's session. */ delegated?: string }
export interface Toggles {
  monitoring: boolean; mirror: boolean; changes: boolean; chatBox: boolean; timeline: boolean; timelineText: boolean;
  models: boolean; limits: boolean; statusBar: boolean; accounts: boolean; delegation: boolean;
}
/** Each on/off switch → the VS Code setting it writes and the value for on/off. 'monitoring' is a command, not a setting. */
export const TOGGLE_SETTINGS: Record<Exclude<keyof Toggles, 'monitoring'>, [key: string, on: unknown, off: unknown]> = {
  mirror: ['mirror.enabled', true, false],
  changes: ['changes.enabled', true, false],
  chatBox: ['chatBox.enabled', true, false],
  timeline: ['timeline.enabled', true, false],
  timelineText: ['timeline.showText', true, false],
  models: ['models.enabled', true, false],
  limits: ['limits.pollMinutes', 5, 0],
  statusBar: ['statusBar.enabled', true, false],
  accounts: ['accounts.enabled', true, false],
  delegation: ['delegate.enabled', true, false]
};
/** Reads every toggle from a `ccc` configuration getter (defaults = package.json defaults). */
export function readToggles(get: <T>(k: string, d: T) => T, monitoring: boolean): Toggles {
  return {
    monitoring, mirror: get('mirror.enabled', true), changes: get('changes.enabled', true), chatBox: get('chatBox.enabled', true),
    timeline: get('timeline.enabled', true), timelineText: get('timeline.showText', true), models: get('models.enabled', true),
    limits: get<number>('limits.pollMinutes', 5) > 0, statusBar: get('statusBar.enabled', true), accounts: get('accounts.enabled', true), delegation: get('delegate.enabled', true)
  };
}
/** ~/.claude-control-center/config.json body, read by the hook script and the mod (key `chatBox`). */
export function hookConfigJson(o: { mirror: boolean; showOutput: boolean; maxOutputKB: number; chatBox: boolean; delegation?: boolean }): string {
  return JSON.stringify({ mirrorOutput: o.mirror && o.showOutput, maxOutputKB: o.maxOutputKB, chatBox: o.chatBox, delegation: o.delegation !== false });
}
export interface DashboardState {
  sessions: { id: string; label: string }[];
  selected?: string;
  changes: ChangeRow[];
  tiles: Tile[];
  staleAfterMs: number;
  paused: boolean;
  /** Changes view: all recent sessions in this workspace, grouped. */
  groups?: ChangeGroup[];
  /** Icon id -> data: URI for the rows in `groups`. */
  icons?: Record<string, string>;
  toggles?: Toggles;
}

export function contextWindowFor(model: string | undefined): number {
  return model && model.includes('[1m]') ? 1_000_000 : 200_000;
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(Math.round(n));
}

export function relDir(p: string, roots: string[]): string {
  const dir = path.dirname(p);
  for (const r of roots) {
    const rel = path.relative(r, dir);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) return rel.replace(/\\/g, '/');
  }
  return dir.replace(/\\/g, '/');
}

/** Visible change rows: drops kept/undone entries unless edited again after that. */
export function changeRows(changes: Iterable<FileChange>, hidden: Record<string, string>, sessionId: string, roots: string[], missing?: (p: string) => boolean): ChangeRow[] {
  const out: ChangeRow[] = [];
  for (const c of changes) {
    if (hidden[`${sessionId}|${c.path}`] === c.lastTs) continue;
    out.push({ path: c.path, name: path.basename(c.path), dir: relDir(c.path, roots), added: c.added, removed: c.removed, created: c.baseline === null, gone: missing?.(c.path) ?? false, icon: iconId(path.basename(c.path)) });
  }
  return out.reverse(); // newest first
}

/**
 * Changes view model: every tracked transcript (live OR ended — ended sessions only live in `recent`)
 * active within the lookback, with files inside the workspace, grouped by session, newest first.
 */
export function changeGroups(i: {
  stats: Iterable<TranscriptStats>; snapshot: AgentSnapshot; hidden: Record<string, string>; roots: string[];
  lookbackMs: number; now?: number; delegated?: ReadonlyMap<string, string>; missing?: (p: string) => boolean;
}): ChangeGroup[] {
  const now = i.now ?? Date.now();
  const out: ChangeGroup[] = [];
  for (const st of i.stats) {
    const at = st.lastTs ? Date.parse(st.lastTs) : undefined;
    if (at !== undefined && Number.isFinite(at) && now - at > i.lookbackMs) continue;
    const rows = changeRows([...st.changes.values()].filter((c) => !i.roots.length || isInside(c.path, i.roots)), i.hidden, st.sessionId, i.roots, i.missing);
    if (!rows.length) continue;
    const info = i.snapshot.sessions.find((x) => x.id === st.sessionId);
    const cwd = st.cwd ?? info?.cwd ?? i.snapshot.recent.find((x) => x.id === st.sessionId)?.cwd;
    out.push({
      id: st.sessionId, label: sessionTitle(st, cwd), sub: `${cwd ? path.basename(cwd) : st.sessionId.slice(0, 8)}${at ? ' · ' + new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''}`, at, live: !!info && isLive(info),
      added: rows.reduce((n, r) => n + r.added, 0), removed: rows.reduce((n, r) => n + r.removed, 0), changes: rows, delegated: i.delegated?.get(st.sessionId)
    });
  }
  return out.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
}

/** custom title > AI title > first user prompt (60 chars) > "folder · id8". */
export function sessionTitle(st: Pick<TranscriptStats, 'sessionId'> & Partial<Pick<TranscriptStats, 'customTitle' | 'aiTitle' | 'firstPrompt'>>, cwd?: string): string {
  const t = st.customTitle?.trim() || st.aiTitle?.trim();
  if (t) return t.slice(0, 80);
  const p = st.firstPrompt ? cleanPrompt(st.firstPrompt).text.replace(/\s+/g, ' ').trim() : '';
  if (p) return p.length > 60 ? p.slice(0, 60) + '…' : p;
  return `${cwd ? `${path.basename(cwd)} · ` : ''}${st.sessionId.slice(0, 8)}`;
}

export function buildState(i: {
  snapshot: AgentSnapshot; paused: boolean; staleAfterMs: number;
  selected?: string; stats?: TranscriptStats; capture?: StatusCapture; accountCapture?: StatusCapture; cli?: CliUsage;
  hidden: Record<string, string>; roots: string[]; now?: number; titleOf?: (id: string, cwd?: string) => string;
}): DashboardState {
  const s = i.snapshot;
  const sessionIds = new Set(s.sessions.map((x) => x.id));
  if (i.selected) sessionIds.add(i.selected);
  const sessions = [...sessionIds].map((id) => {
    const info = s.sessions.find((x) => x.id === id);
    return { id, label: `${i.titleOf ? i.titleOf(id, info?.cwd) : `${id.slice(0, 8)}${info?.cwd ? ` · ${path.basename(info.cwd)}` : ''}`}${info && !isLive(info) ? ' (idle)' : ''}` };
  });
  const sel = i.selected;
  const st = i.stats;
  const session = s.sessions.find((x) => x.id === sel);
  const tiles: Tile[] = [];

  const all = s.sessions.flatMap((x) => [x, ...x.subagents]);
  const running = all.filter((a) => a.status === 'running' && !a.stale).length;
  tiles.push({ id: 'agents', label: 'Active agents', value: `${running}/${all.filter(isLive).length}`, sub: s.staleCount ? `${s.staleCount} stale` : 'running/live', source: 'hooks', at: s.lastEventAt });

  const hookTool = session?.currentTool ?? session?.subagents.find((a) => a.currentTool)?.currentTool;
  const tTool = st?.lastTool && !st.lastTool.done ? st.lastTool : undefined;
  tiles.push({ id: 'tool', label: 'Current tool', value: hookTool ?? tTool?.name ?? 'idle', source: hookTool ? 'hooks' : 'transcript', at: hookTool ? session?.lastActivity : tTool ? Date.parse(tTool.ts) : st?.updatedAt });

  const at = st?.updatedAt || undefined;
  // Transcript model ids never carry the "[1m]" suffix; prefer the status line's real window size.
  const window = i.capture?.contextWindowSize ?? (st && st.contextTokens > 200_000 ? 1_000_000 : contextWindowFor(st?.model));
  if (st && st.contextTokens) {
    const pct = Math.min(100, (st.contextTokens / window) * 100);
    tiles.push({ id: 'context', label: 'Context', value: `${pct.toFixed(0)}%`, sub: `${fmtTokens(st.contextTokens)} / ${fmtTokens(window)} context`, pct, source: 'transcript', at });
  } else tiles.push({ id: 'context', label: 'Context', value: '—', sub: 'context', source: 'transcript', unavailable: true, tooltip: 'No assistant usage in the transcript yet.' });

  const u = st?.usage;
  tiles.push(u
    ? { id: 'tokens', label: 'Tokens', value: `${fmtTokens(u.inputTokens)} in · ${fmtTokens(u.outputTokens)} out`, sub: `cache ${fmtTokens(u.cacheReadInputTokens)} read · ${fmtTokens(u.cacheCreationInputTokens)} write`, source: 'transcript', at }
    : { id: 'tokens', label: 'Tokens', value: '—', source: 'transcript', unavailable: true, tooltip: 'No transcript tracked for this session.' });

  const cost = st?.costUSD ?? i.capture?.costUSD;
  tiles.push(cost !== undefined
    ? { id: 'cost', label: 'Est. cost', value: `$${cost.toFixed(2)}`, sub: st?.costUSD !== undefined ? 'transcript cost-state' : 'status line', source: st?.costUSD !== undefined ? 'transcript cost-state' : 'status line', at: st?.costUSD !== undefined ? at : i.capture?.ts }
    : { id: 'cost', label: 'Est. cost', value: '—', source: 'transcript cost-state', unavailable: true, tooltip: 'No cost-state line in the transcript yet.' });

  const model = st?.model ?? i.capture?.model;
  tiles.push({ id: 'model', label: 'Model', value: model ?? '—', source: st?.model ? 'transcript' : 'status line', at: st?.model ? at : i.capture?.ts, unavailable: !model });

  const start = st?.firstTs ? Date.parse(st.firstTs) : session?.startTime;
  const live = !!session && isLive(session);
  const end = live ? undefined : (st?.lastTs ? Date.parse(st.lastTs) : session?.endTime ?? session?.lastActivity);
  tiles.push(start && Number.isFinite(start)
    ? { id: 'duration', label: 'Session', value: fmtDuration((end ?? i.now ?? Date.now()) - start), sub: live ? 'running' : 'ended/idle', since: live ? start : undefined, source: st?.firstTs ? 'transcript' : 'hooks', at: st?.updatedAt || session?.lastActivity }
    : { id: 'duration', label: 'Session', value: '—', source: 'hooks', unavailable: true });

  const acct = i.capture ?? i.accountCapture;
  for (const [id, label, which] of [['limit5h', '5h limit', 'fiveHour'], ['limitWeek', 'Weekly limit', 'sevenDay']] as const) {
    const v = limitView(acct, which);
    const c = i.cli?.[which];
    const nowSec = (i.now ?? Date.now()) / 1000;
    // Status-line capture is per-response fresh; fall back to the polled `claude /usage` CLI output.
    if (!v.available && c && (c.resetsAt === undefined || c.resetsAt > nowSec)) {
      tiles.push({ id, label, value: `${c.usedPercentage.toFixed(0)}%`, pct: c.usedPercentage, resetsAt: c.resetsAt ? c.resetsAt * 1000 : undefined, sub: c.resetsAt ? `resets ${new Date(c.resetsAt * 1000).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : (c.resetsText ? `resets ${c.resetsText}` : 'used'), source: 'claude /usage', at: i.cli!.ts });
      continue;
    }
    tiles.push(v.available
      ? { id, label, value: `${v.usedPercentage.toFixed(0)}%`, pct: v.usedPercentage, resetsAt: v.resetsAt ? v.resetsAt * 1000 : undefined, sub: v.resetsAt ? `resets ${new Date(v.resetsAt * 1000).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : 'used', source: 'status line', at: v.capturedAt }
      : { id, label, value: 'Unavailable', source: 'status line', unavailable: true, tooltip: v.reason });
  }

  return {
    sessions, selected: sel, tiles, staleAfterMs: i.staleAfterMs, paused: i.paused,
    changes: st && sel ? changeRows(st.changes.values(), i.hidden, sel, i.roots) : []
  };
}

export type Chip = 'running' | 'input' | 'permission' | 'idle' | 'done' | 'failed' | 'stale';
export const CHIP_TEXT: Record<Chip, string> = {
  running: 'running', input: 'waiting for input', permission: 'waiting permission', idle: 'idle', done: 'done', failed: 'failed', stale: 'stale'
};

/** Live state chip from hook status + the agent's last hook event (Notification text tells input vs permission). */
export function chipOf(a: Pick<AgentInfo, 'status' | 'stale'>, last?: { event: string; summary?: string }): Chip {
  if (a.stale) return 'stale';
  switch (a.status) {
    case 'running': return 'running';
    case 'completed': return 'done';
    case 'failed': return 'failed';
    case 'waiting':
      if (last?.event !== 'Notification') return 'idle';
      return /permission|approv|allow/i.test(last.summary ?? '') ? 'permission' : 'input';
    default: return 'idle';
  }
}

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}h ${m}m` : m ? `${m}m ${sec}s` : `${sec}s`;
}

/** Marks changes as handled. A change without a real lastTs (revert) clears any stale kept entry instead of overwriting it. */
export function applyHide(h: Record<string, string>, sessionId: string, cs: { path: string; lastTs: string }[]): void {
  for (const c of cs) { const k = `${sessionId}|${c.path}`; if (c.lastTs) h[k] = c.lastTs; else delete h[k]; }
}
