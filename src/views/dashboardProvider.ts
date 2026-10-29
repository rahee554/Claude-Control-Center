import * as path from 'path';
import * as vscode from 'vscode';
import { FileChange } from '../collectors/transcriptCollector';
import { AgentService } from '../services/agentService';
import { BACKUP_NAME_RE, isInside, isOpenablePath, readBaseline, SESSION_ID_RE } from '../services/fileHistory';
import { UsageService } from '../services/usageService';
import { applyHide, buildState, changeGroups, Chip, chipOf, readToggles, TOGGLE_SETTINGS, Toggles } from './dashboardState';
import { iconUri } from './fileIcons';
import { buildExportInput, sessionToMarkdown } from './sessionExport';
import { aggregateModels, familyShares, revertPlan, subagentLabel, TlFile, TlTool, Timelines } from './timeline';
import { isAllowedTranscript } from '../collectors/transcriptCollector';
import { isLive } from '../services/agentState';
import { CCC_HOME } from '../services/usageService';
import * as fs from 'fs';
import { mcpRegistered } from '../services/mcpStatus';
import { locateTranscript } from '../accounts/delegatedSessions';
import { SETTINGS, validateSetting } from './settingsView';
import { TabId } from './shellTabs';

interface NowItem { id: string; sessionId?: string; kind: 'session' | 'subagent' | 'task'; label: string; chip: Chip; tool?: string; since?: number; account?: string; role?: string; parent?: string; type?: string; model?: string; hint?: string }
type AccountRow = { id?: string; label?: string; role?: string; configDir?: string; enabled?: boolean; loggedIn?: boolean; email?: string; plan?: string; fiveHour?: number; weekly?: number };

function readJson(f: string): unknown { try { return fs.statSync(f).size > 1024 * 1024 ? undefined : JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return undefined; } }
function alive(pid: unknown): boolean { if (!Number.isInteger(pid) || (pid as number) <= 0) return false; try { process.kill(pid as number, 0); return true; } catch { return false; } }
function accountsJson(): AccountRow[] {
  const a = (readJson(path.join(CCC_HOME, 'accounts.json')) as { accounts?: unknown } | undefined)?.accounts;
  return Array.isArray(a) ? a.filter((x): x is AccountRow => !!x && typeof x === 'object') : [];
}
/** Turn files + files its subagents edited (subagent edits have no per-turn backup: backup stays undefined). */
function mergeFiles(own: TlFile[], fromSubs: TlFile[]): TlFile[] {
  const m = new Map(own.map((f) => [f.path, { ...f }]));
  for (const f of fromSubs) { const c = m.get(f.path); if (c) { c.added += f.added; c.removed += f.removed; } else m.set(f.path, { path: f.path, added: f.added, removed: f.removed, sub: true }); }
  return [...m.values()];
}
interface TaskEntry { item: NowItem; model?: string; tokens: number; files: number }
function clip(s: string | undefined, max: number): string | undefined { return s && s.length > max ? s.slice(0, max) + '…' : s; }

export const BASELINE_SCHEME = 'ccc-baseline';
const HIDDEN_KEY = 'ccc.hiddenChanges';
const PREV_POLL_KEY = 'ccc.limits.prevPollMinutes';

/** Read-only "before" side of Claude's changes: ccc-baseline:/<sessionId>/<backupName|created>/<file name>. */
export class BaselineContentProvider implements vscode.TextDocumentContentProvider {
  provideTextDocumentContent(uri: vscode.Uri): string {
    const [, sessionId, backup] = uri.path.split('/');
    const b = readBaseline(sessionId ?? '', backup === 'created' ? null : backup);
    if (b.kind === 'created') return '';
    if (b.kind === 'unavailable') throw new Error(b.reason);
    return Buffer.from(b.data).toString('utf8');
  }
}

export function baselineUri(sessionId: string, c: FileChange): vscode.Uri | undefined {
  if (!SESSION_ID_RE.test(sessionId)) return undefined;
  if (c.baseline === undefined) return undefined;
  if (c.baseline !== null && !BACKUP_NAME_RE.test(c.baseline)) return undefined;
  return vscode.Uri.from({ scheme: BASELINE_SCHEME, path: `/${sessionId}/${c.baseline ?? 'created'}/${path.basename(c.path)}` });
}

type PathMsg = { type: 'openDiff' | 'keep' | 'undo' | 'open'; sessionId: string; path: string };
type InMsg = { type: 'ready' } | { type: 'select'; sessionId: string } | PathMsg | { type: 'keepAll' | 'undoAll'; sessionId: string }
  | { type: 'bulk'; op: 'keep' | 'undo'; items: { sessionId: string; path: string }[] }
  | { type: 'setSetting'; key: string; value: unknown }
  | { type: 'command'; id: string } | { type: 'toggle'; key: keyof Toggles; on: boolean } | { type: 'setAccount'; id?: string } | { type: 'openSettings' } | { type: 'exportSession' }
  | { type: 'revertTurn'; sessionId: string; line: number; path?: string }
  | { type: 'openFile'; sessionId: string; path: string } | { type: 'focusMirror'; sessionId: string } | { type: 'openTurn'; sessionId: string; line: number };
const ALLOWED_COMMANDS = new Set(['ccc.installHooks', 'ccc.installStatusLine', 'ccc.refresh', 'ccc.accounts.add', 'ccc.accounts.edit', 'ccc.delegateTask', 'ccc.installMcp', 'ccc.uninstallMcp']);
const TOGGLE_KEYS = new Set<keyof Toggles>(['monitoring', ...Object.keys(TOGGLE_SETTINGS) as (keyof Toggles)[]]);
const ACCOUNT_ID_RE = /^[\w-]{1,64}$/;

export function parseMsg(m: unknown): InMsg | undefined {
  if (!m || typeof m !== 'object') return undefined;
  const o = m as Record<string, unknown>;
  const sid = typeof o.sessionId === 'string' && SESSION_ID_RE.test(o.sessionId) ? o.sessionId : undefined;
  switch (o.type) {
    case 'ready': return { type: 'ready' };
    case 'setSetting': return validateSetting(o.key, o.value) !== undefined ? { type: 'setSetting', key: o.key as string, value: o.value } : undefined;
    case 'openSettings': return { type: 'openSettings' };
    case 'exportSession': return { type: 'exportSession' };
    case 'setAccount': return o.id === undefined || (typeof o.id === 'string' && ACCOUNT_ID_RE.test(o.id)) ? { type: 'setAccount', id: o.id as string | undefined } : undefined;
    case 'select': return sid ? { type: 'select', sessionId: sid } : undefined;
    case 'keepAll': case 'undoAll': return sid ? { type: o.type, sessionId: sid } : undefined;
    case 'bulk': {
      if ((o.op !== 'keep' && o.op !== 'undo') || !Array.isArray(o.items) || o.items.length > 2000) return undefined;
      const items: { sessionId: string; path: string }[] = [];
      for (const it of o.items as Record<string, unknown>[]) {
        if (it && typeof it.sessionId === 'string' && SESSION_ID_RE.test(it.sessionId) && typeof it.path === 'string' && it.path.length <= 1024) items.push({ sessionId: it.sessionId, path: it.path });
      }
      return items.length ? { type: 'bulk', op: o.op, items } : undefined;
    }
    case 'openDiff': case 'keep': case 'undo': case 'open':
      return sid && typeof o.path === 'string' && o.path.length <= 1024 ? { type: o.type, sessionId: sid, path: o.path } : undefined;
    case 'openFile': return sid && typeof o.path === 'string' && o.path.length <= 1024 ? { type: 'openFile', sessionId: sid, path: o.path } : undefined;
    case 'focusMirror': return sid ? { type: 'focusMirror', sessionId: sid } : undefined;
    case 'revertTurn': return sid && Number.isInteger(o.line) && (o.line as number) >= 1 && (o.path === undefined || (typeof o.path === 'string' && o.path.length <= 1024)) ? { type: 'revertTurn', sessionId: sid, line: o.line as number, path: o.path as string | undefined } : undefined;
    case 'openTurn': return sid && Number.isInteger(o.line) && (o.line as number) >= 1 && (o.line as number) <= 1e8 ? { type: 'openTurn', sessionId: sid, line: o.line as number } : undefined;
    case 'command': return typeof o.id === 'string' && ALLOWED_COMMANDS.has(o.id) ? { type: 'command', id: o.id } : undefined;
    case 'toggle': return typeof o.key === 'string' && TOGGLE_KEYS.has(o.key as keyof Toggles) && typeof o.on === 'boolean' ? { type: 'toggle', key: o.key as keyof Toggles, on: o.on } : undefined;
    default: return undefined;
  }
}

/** Controller for the Activity / Changes / Accounts / Settings tabs; the shell provider owns the webview. */
export class DashboardProvider {
  static readonly viewId = 'ccc.dashboard';
  private selected?: string;
  /** Set by the shell: asks for an immediate state push. */
  rerender: (force?: boolean) => void = () => undefined;

  constructor(
    private readonly agents: AgentService,
    private readonly usage: UsageService,
    private readonly context: vscode.ExtensionContext,
    private readonly opts: () => { staleAfterMs: number },
    private readonly timelines?: Timelines
  ) {}
  private tlKey?: string;
  private allowedFiles = new Set<string>();
  /** Delegated task sessions (tracked transcripts): sessionId -> account label. */
  private delegatedSessions = new Map<string, string>();
  private taskCache?: { at: number; items: TaskEntry[] };

  /** Forgets what was sent so the next state carries the full timeline. */
  reset(): void { this.tlKey = undefined; }

  /** Number of changed files shown in the Changes tab (badge). */
  changeCount(): number { return this.groups().reduce((n, g) => n + g.changes.length, 0); }

  sessionId(): string | undefined {
    const s = this.agents.snapshot.sessions;
    if (this.selected && (s.some((x) => x.id === this.selected) || this.agents.getTranscriptStats(this.selected) || this.transcriptOf(this.selected))) return this.selected;
    return [...s].sort((a, b) => b.lastActivity - a.lastActivity)[0]?.id;
  }

  private hidden(): Record<string, string> { return this.context.workspaceState.get<Record<string, string>>(HIDDEN_KEY, {}); }

  private async hide(sessionId: string, cs: FileChange[]): Promise<void> {
    const h = { ...this.hidden() };
    applyHide(h, sessionId, cs);
    const keys = Object.keys(h);
    for (const k of keys.slice(0, Math.max(0, keys.length - 2000))) delete h[k]; // bounded
    await this.context.workspaceState.update(HIDDEN_KEY, h);
  }

  private roots(): string[] { return (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath); }

  private toggles(): Toggles {
    const c = vscode.workspace.getConfiguration('ccc');
    return readToggles((k, d) => c.get(k, d), !this.agents.isPaused);
  }

  private gone = new Map<string, { at: number; v: boolean }>();
  /** "Removed" = missing on disk now; fs.existsSync cached 3s, bounded. */
  private isGone = (p: string): boolean => {
    const now = Date.now(), c = this.gone.get(p);
    if (c && now - c.at < 3000) return c.v;
    if (this.gone.size > 2000) this.gone.clear();
    const v = path.isAbsolute(p) && !fs.existsSync(p);
    this.gone.set(p, { at: now, v });
    return v;
  };

  private groups() {
    this.tasks(); // refreshes delegatedSessions + starts tracking their transcripts
    const hours = Math.min(Math.max(vscode.workspace.getConfiguration('ccc.changes').get<number>('lookbackHours', 24), 1), 24 * 30);
    return changeGroups({ stats: this.agents.transcripts.allStats(), snapshot: this.agents.snapshot, hidden: this.hidden(), roots: this.roots(), lookbackMs: hours * 3600_000, delegated: this.delegatedSessions, missing: this.isGone });
  }

  state(tab: TabId) {
    const sel = this.sessionId();
    if (tab === 'settings') return { sessions: [], changes: [], tiles: [], staleAfterMs: this.opts().staleAfterMs, paused: this.agents.isPaused, settings: this.settingsPayload() };
    if (tab === 'changes') { const groups = this.groups(); return { sessions: [], changes: [], tiles: [], staleAfterMs: this.opts().staleAfterMs, paused: this.agents.isPaused, groups, icons: Object.fromEntries([...new Set(groups.flatMap((g) => g.changes.map((c) => c.icon)))].map((id) => [id, iconUri(id)])) }; }
    const base = buildState({
      snapshot: this.agents.snapshot, paused: this.agents.isPaused, staleAfterMs: this.opts().staleAfterMs,
      selected: sel, stats: sel ? this.agents.getTranscriptStats(sel) : undefined,
      capture: sel ? this.usage.get(sel) : undefined, accountCapture: this.usage.latest(), cli: this.usage.cli,
      hidden: this.hidden(), roots: this.roots(), titleOf: (id, cwd) => this.agents.sessionTitle(id, cwd)
    });
    const tasks = this.tasks();
    const running = tasks.filter((t) => t.item.chip === 'running');
    const toggles = this.toggles();
    const tl = toggles.timeline || toggles.models ? this.timeline(sel, running) : undefined;
    const mst = sel ? this.agents.getTranscriptStats(sel) : undefined;
    const mfile = sel ? this.transcriptOf(sel) : undefined;
    const cs = mst ? [...mst.changes.values()] : [];
    const compare = toggles.accounts && toggles.delegation ? {
      main: { tokens: mst ? mst.usage.inputTokens + mst.usage.outputTokens : 0, messages: mfile && this.timelines ? this.timelines.get(mfile).turns.length : 0, files: cs.length },
      deleg: { running: running.length, done: tasks.filter((t) => t.item.chip === 'done').length, failed: tasks.filter((t) => t.item.chip === 'failed').length, tasks: tasks.length, tokens: tasks.reduce((n, t) => n + t.tokens, 0), files: tasks.reduce((n, t) => n + t.files, 0) }
    } : undefined;
    return {
      ...base, compare, mcp: mcpRegistered(vscode.workspace.getConfiguration('ccc.limits').get<string>('claudePath', 'claude')), tiles: base.tiles.filter((t) => t.id !== 'cost'), sessions: this.sessionList(), toggles,
      now: [...this.nowItems(), ...running.map((t) => t.item)],
      delegated: toggles.accounts && toggles.delegation ? tasks.map((t) => t.item) : [],
      timeline: toggles.timeline ? tl?.timeline : undefined, models: toggles.models ? tl?.models : undefined,
      families: toggles.models && tl?.models ? familyShares(tl.models) : undefined,
      selectedDelegated: sel ? this.delegatedSessions.get(sel) : undefined,
      accounts: toggles.accounts ? this.accountList() : undefined,
      lastActivity: Math.max(0, ...this.agents.snapshot.sessions.map((x) => x.lastActivity).filter(Number.isFinite))
    };
  }

  // ---- Activity ----
  private transcriptOf(id: string): string | undefined {
    const s = this.agents.snapshot;
    const p = this.agents.getTranscriptStats(id)?.transcriptPath ?? s.sessions.find((x) => x.id === id)?.transcriptPath ?? s.recent.find((x) => x.id === id)?.transcriptPath;
    return p && isAllowedTranscript(p) ? p : undefined;
  }

  private sessionList(): { id: string; label: string; live: boolean; delegated?: string }[] {
    const snap = this.agents.snapshot;
    const dm = this.delegatedSessions;
    const lbl = (id: string, cwd?: string) => this.agents.sessionTitle(id, cwd);
    const live = [...snap.sessions].sort((a, b) => b.lastActivity - a.lastActivity).map((s) => ({ id: s.id, label: lbl(s.id, s.cwd), live: isLive(s), delegated: dm.get(s.id) }));
    const seen = new Set(live.map((x) => x.id));
    const recent = [
      ...this.agents.transcripts.allStats().map((st) => ({ id: st.sessionId, cwd: st.cwd, at: st.lastTs ? Date.parse(st.lastTs) || 0 : 0 })),
      ...snap.recent.filter((a) => a.kind === 'session').map((a) => ({ id: a.id, cwd: a.cwd, at: a.lastActivity }))
    ].sort((a, b) => b.at - a.at).filter((x) => !seen.has(x.id) && !!seen.add(x.id));
    const row = (x: { id: string; cwd?: string }) => ({ id: x.id, label: lbl(x.id, x.cwd), live: false, delegated: dm.get(x.id) });
    return [...live, ...recent.filter((x) => !dm.has(x.id)).slice(0, 8).map(row), ...recent.filter((x) => dm.has(x.id)).slice(0, 8).map(row)];
  }

  private accountFor(transcript?: string): { account?: string; role?: string } {
    const accts = accountsJson();
    const norm = (p: string) => path.resolve(p).toLowerCase();
    const a = (transcript && accts.find((x) => typeof x.configDir === 'string' && norm(transcript).startsWith(norm(x.configDir) + path.sep)))
      || accts.find((x) => !x.configDir && x.role === 'main') || accts.find((x) => !x.configDir);
    return a ? { account: typeof a.label === 'string' ? a.label.slice(0, 40) : undefined, role: a.role === 'sub' ? 'sub' : 'main' } : { role: 'main' };
  }

  /** Accounts for the header switcher (labels/plan/limits only, from accounts.json). */
  private accountList() {
    const j = readJson(path.join(CCC_HOME, 'accounts.json')) as { defaultAccountId?: unknown } | undefined;
    const pct = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : undefined;
    return {
      defaultId: typeof j?.defaultAccountId === 'string' ? j.defaultAccountId : undefined,
      list: accountsJson().filter((a) => typeof a.id === 'string' && ACCOUNT_ID_RE.test(a.id)).slice(0, 20).map((a) => ({
        id: a.id as string, label: String(a.label ?? a.id).slice(0, 40), role: a.role === 'main' ? 'main' : 'sub', enabled: a.enabled !== false,
        loggedIn: a.loggedIn === true, plan: typeof a.plan === 'string' ? a.plan.slice(0, 30) : undefined, fiveHour: pct(a.fiveHour), weekly: pct(a.weekly)
      }))
    };
  }

  private nowItems(): NowItem[] {
    const out: NowItem[] = [];
    for (const s of this.agents.snapshot.sessions) {
      const file = this.transcriptOf(s.id);
      const acct = this.accountFor(file);
      for (const a of [s, ...s.subagents]) {
        if (a.kind === 'subagent' && !isLive(a)) continue;
        const h = this.agents.getHistory(a.sessionId, a.kind === 'subagent' ? a.id : undefined).filter((e) => a.kind === 'subagent' || !e.agentId);
        const d = a.kind === 'subagent' && file && this.timelines ? this.timelines.agentDetails(file, a.id) : undefined;
        out.push({
          id: a.id, sessionId: a.sessionId, kind: a.kind, chip: chipOf(a, h[h.length - 1]), tool: a.currentTool,
          label: a.kind === 'session' ? this.agents.sessionTitle(a.id, a.cwd) : subagentLabel({ description: d?.description, agentType: a.agentType, id: a.id }),
          hint: a.kind === 'session' ? a.id : d?.description, parent: a.kind === 'subagent' ? a.sessionId : undefined,
          type: a.kind === 'subagent' && a.agentType !== 'general-purpose' ? a.agentType : undefined, model: d?.model,
          since: a.currentTool ? a.lastActivity : a.startTime, ...acct
        });
      }
    }
    return out.slice(0, 40);
  }

  /** Delegated tasks currently running on sub-accounts (read from ~/.claude-control-center/tasks, cached 2s). */
  private tasks(): TaskEntry[] {
    if (this.taskCache && Date.now() - this.taskCache.at < 2000) return this.taskCache.items;
    const dir = path.join(CCC_HOME, 'tasks');
    const items: TaskEntry[] = [];
    let ids: string[] = [];
    try { ids = fs.readdirSync(dir).slice(-50); } catch { /* none */ }
    const accts = accountsJson();
    const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
    const dm = new Map<string, string>();
    for (const [n, id] of ids.entries()) {
      const meta = (readJson(path.join(dir, id, 'task.json')) as { meta?: Record<string, unknown> } | undefined)?.meta;
      const st = readJson(path.join(dir, id, 'status.json')) as Record<string, unknown> | undefined;
      if (!meta) continue;
      const running = st?.state === 'running' && alive(st.pid);
      const chip: Chip = running ? 'running' : st?.state === 'done' ? 'done' : st?.state === 'failed' || st?.state === 'running' ? 'failed' : 'idle';
      const acc = accts.find((a) => a.id === meta.accountId);
      const account = String(meta.accountLabel ?? acc?.label ?? 'account').slice(0, 40);
      // Session id: status.json (runner writes it at init), else result.json (older tasks).
      let sid = typeof st?.sessionId === 'string' ? st.sessionId : undefined;
      if (!sid && chip !== 'running') sid = (readJson(path.join(dir, id, 'result.json')) as { session_id?: string } | undefined)?.session_id;
      if (typeof sid !== 'string' || !SESSION_ID_RE.test(sid)) sid = undefined;
      let files = 0;
      if (sid) {
        if (!this.agents.getTranscriptStats(sid) && n >= ids.length - 15) { const f = locateTranscript(acc?.configDir, sid); if (f) this.agents.transcripts.track(sid, f); }
        const ts = this.agents.getTranscriptStats(sid);
        if (ts) { dm.set(sid, account); files = ts.changes.size; } else sid = undefined;
      }
      items.push({
        model: typeof meta.model === 'string' ? meta.model.slice(0, 60) : undefined,
        tokens: num(st?.inputTokens) + num(st?.outputTokens), files,
        item: {
          id: `task:${id.slice(0, 64)}`, sessionId: sid, kind: 'task', chip, label: String(meta.title ?? id).slice(0, 80),
          since: running && typeof st?.startedAt === 'number' ? st.startedAt : undefined,
          account, role: acc?.role === 'main' ? 'main' : 'sub'
        }
      });
    }
    items.reverse(); // newest first
    this.delegatedSessions = dm;
    this.taskCache = { at: Date.now(), items };
    return items;
  }

  private settingsPayload() {
    const c = vscode.workspace.getConfiguration('ccc');
    const values: Record<string, unknown> = {};
    for (const d of SETTINGS) values[d.key] = c.get(d.key, d.def);
    return { defs: SETTINGS, values, accounts: this.accountList().list.map((a) => ({ id: a.id, label: a.label })) };
  }

  private timeline(sel: string | undefined, tasks: { item: NowItem; model?: string }[]) {
    if (!this.timelines || !sel) return undefined;
    const showText = vscode.workspace.getConfiguration('ccc.timeline').get<boolean>('showText', true);
    const file = this.transcriptOf(sel);
    const taskSources = this.delegatedSessions.has(sel) ? [] : tasks.filter((t) => t.model).map((t) => ({ label: t.item.label, active: true, model: t.model }));
    if (!file) {
      const key = `${sel}:none`;
      const models = aggregateModels(taskSources);
      if (key === this.tlKey) return { models };
      this.tlKey = key; this.allowedFiles = new Set();
      return { timeline: { sessionId: sel, turns: [], showText, missing: true }, models };
    }
    const r = this.timelines.get(file);
    this.timelines.linkAgents(file, r);
    const ids = [...new Set(r.turns.flatMap((t) => t.tools).map((t) => t.agentId).filter((x): x is string => !!x))].slice(-60);
    const subs = new Map(ids.map((id) => [id, this.timelines!.agentDetails(file, id)] as const));
    const session = this.agents.snapshot.sessions.find((s) => s.id === sel);
    const liveSub = new Set(session?.subagents.filter(isLive).map((a) => a.id) ?? []);
    const models = aggregateModels([
      { label: 'main', active: !!session && isLive(session), model: r.model, byModel: r.byModel },
      ...ids.map((id) => { const d = subs.get(id); return { label: subagentLabel({ description: d?.description, agentType: d?.type, id }), active: liveSub.has(id) || !!d?.tools.some((t) => t.status === 'run'), model: d?.model, byModel: d?.byModel }; }),
      ...taskSources
    ]);
    const key = `${sel}:${r.version}:${showText}:${ids.map((id) => { const d = subs.get(id); return d ? `${d.tools.length}/${d.tokens}/${d.tools.filter((t) => t.status === 'run').length}` : '-'; }).join(',')}`;
    if (key === this.tlKey) return { models };
    this.tlKey = key;
    const files = new Set<string>();
    const tool = (t: TlTool) => { if (t.file) files.add(t.file); return { id: t.id, name: t.name, ts: t.ts, status: t.status, ms: t.ms, target: t.target, file: t.file, command: t.command ? clip(t.command, 300) : undefined, agentType: t.agentType }; };
    const turns = r.turns.map((t) => ({
      line: t.line, ts: t.ts, endTs: t.endTs, tokIn: t.tokIn, tokOut: t.tokOut,
      files: mergeFiles(t.files, t.tools.flatMap((x) => (x.agentId && subs.get(x.agentId)?.files) || [])).slice(0, 100).map((x) => { files.add(x.path); return { path: x.path, name: path.basename(x.path), added: x.added, removed: x.removed, created: x.backup === null, sub: x.sub }; }),
      prompt: showText ? clip(t.prompt, 2000) : undefined, system: t.system, reply: showText ? clip(t.reply, 2000) : undefined, hasText: !!(t.prompt || t.reply),
      tools: t.tools.map((x) => {
        const d = x.agentId ? subs.get(x.agentId) : undefined;
        return { ...tool(x), sub: d ? { agentId: x.agentId, description: d.description, type: d.type, tokens: d.tokens, model: d.model, tools: d.tools.map(tool) } : undefined };
      })
    }));
    this.allowedFiles = files;
    return { timeline: { sessionId: sel, turns, showText, model: r.model }, models };
  }

  /** Restores files changed in the turn at line and all later turns to their content before that turn. */
  private async revertTurn(sessionId: string, line: number, only?: string): Promise<void> {
    const file = this.transcriptOf(sessionId);
    if (!file || !this.timelines) return;
    const turns = this.timelines.get(file).turns;
    const from = turns.findIndex((t) => t.line === line);
    if (from < 0) return;
    const plan = revertPlan(turns, from, only);
    const ids = new Set(turns.slice(from).flatMap((t) => t.tools).map((t) => t.agentId).filter((x): x is string => !!x));
    const own = new Set(turns.slice(from).flatMap((t) => t.files.map((f) => f.path)));
    const subOnly = new Set([...ids].flatMap((id) => this.timelines!.agentDetails(file, id)?.files.map((f) => f.path) ?? []).filter((p) => !own.has(p) && (only === undefined || p === only)));
    const note = subOnly.size ? ` ${subOnly.size} subagent-edited file(s) can't be reverted from here; use Undo in Claude Changes if a baseline exists.` : '';
    const roots = this.roots();
    const inWs = plan.filter((p) => path.isAbsolute(p.path) && isInside(p.path, roots));
    if (!inWs.length) { void vscode.window.showWarningMessage((plan.length ? 'Nothing to revert inside the open workspace folders.' : only !== undefined && subOnly.size ? 'This file was edited by a subagent, so there is no per-message backup.' : 'No file changes recorded from this message on.') + (only === undefined ? note : '')); return; }
    await this.undo(sessionId, inWs.map((p) => ({ path: p.path, baseline: p.backup, added: 0, removed: 0, lastTs: '' })), 'their content before the selected message' + note);
  }

  private async jump(m: InMsg): Promise<void> {
    if (m.type === 'openFile') {
      if (!this.allowedFiles.has(m.path) || !isOpenablePath(m.path, this.roots())) return;
      await vscode.window.showTextDocument(vscode.Uri.file(m.path), { preview: true });
    } else if (m.type === 'focusMirror') {
      await vscode.commands.executeCommand('ccc.focusTerminal', { kind: 'session', agent: { sessionId: m.sessionId } });
    } else if (m.type === 'openTurn') {
      const f = this.transcriptOf(m.sessionId);
      if (!f) { void vscode.window.showWarningMessage('No transcript available for this session.'); return; }
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(f));
      const line = Math.min(m.line, doc.lineCount) - 1;
      const range = new vscode.Range(line, 0, line, 0);
      await vscode.window.showTextDocument(doc, { preview: true, selection: range });
    }
  }

  /** Opens the selected session as an untitled Markdown document (no file writes). */
  async exportSession(): Promise<void> {
    const sel = this.sessionId();
    const file = sel ? this.transcriptOf(sel) : undefined;
    if (!sel || !file || !this.timelines) { void vscode.window.showWarningMessage('No session transcript to export.'); return; }
    const r = this.timelines.get(file);
    this.timelines.linkAgents(file, r);
    const ids = [...new Set(r.turns.flatMap((t) => t.tools).map((t) => t.agentId).filter((x): x is string => !!x))].slice(-60);
    const session = this.agents.snapshot.sessions.find((s) => s.id === sel);
    const models = aggregateModels([
      { label: 'main', active: false, model: r.model, byModel: r.byModel },
      ...ids.map((id) => { const d = this.timelines!.agentDetails(file, id); return { label: subagentLabel({ description: d?.description, agentType: d?.type, id }), active: false, model: d?.model, byModel: d?.byModel }; })
    ]);
    const label = this.agents.sessionTitle(sel, session?.cwd);
    const pad = (n: number) => String(n).padStart(2, '0');
    const md = sessionToMarkdown(buildExportInput(label, sel, r.turns, familyShares(models)), (ms) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; });
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: 'markdown', content: md }));
  }

  toggleState(): Toggles { return this.toggles(); }

  async setToggle(key: keyof Toggles, on: boolean): Promise<void> {
    if (key === 'monitoring') { await vscode.commands.executeCommand(on ? 'ccc.resumeMonitoring' : 'ccc.pauseMonitoring'); return; }
    if (key === 'timeline' || key === 'timelineText') this.tlKey = undefined;
    const [k, vOn, vOff] = TOGGLE_SETTINGS[key];
    const cfg = vscode.workspace.getConfiguration('ccc');
    if (key === 'limits') {
      const prev = cfg.get<number>(k, 5);
      if (!on && prev > 0) await this.context.globalState.update(PREV_POLL_KEY, prev);
      else if (on) { await this.writeSetting(k, Math.max(1, this.context.globalState.get<number>(PREV_POLL_KEY, 5))); return; }
    }
    await this.writeSetting(k, on ? vOn : vOff);
  }

  /** Writes to the workspace when it overrides the key there (else the write would be shadowed), otherwise globally. */
  private async writeSetting(k: string, v: unknown): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('ccc');
    const t = cfg.inspect(k)?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    await cfg.update(k, v, t);
  }

  async handle(raw: unknown): Promise<void> {
    const m = parseMsg(raw);
    if (m?.type === 'ready') { this.reset(); this.rerender(true); return; }
    await this.run(m);
  }

  private async run(m: InMsg | undefined): Promise<void> {
    if (!m || m.type === 'ready') return;
    try {
      if (m.type === 'setSetting') { await this.writeSetting(m.key, m.value); this.rerender(true); return; }
      if (m.type === 'select') { this.selected = m.sessionId; this.rerender(true); return; }
      if (m.type === 'openFile' || m.type === 'focusMirror' || m.type === 'openTurn') { await this.jump(m); return; }
      if (m.type === 'revertTurn') { await this.revertTurn(m.sessionId, m.line, m.path); this.tlKey = undefined; this.rerender(true); return; }
      if (m.type === 'command') { await vscode.commands.executeCommand(m.id); return; }
      if (m.type === 'exportSession') { await this.exportSession(); return; }
      if (m.type === 'openSettings') { await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:artflow-studio.claude-code-control-center'); return; }
      if (m.type === 'setAccount') { await vscode.commands.executeCommand('ccc.accounts.setDefault', m.id); this.rerender(true); return; }
      if (m.type === 'toggle') { await this.setToggle(m.key, m.on); this.rerender(true); return; }
      if (m.type === 'bulk') { await this.bulk(m.op, m.items); this.rerender(true); return; }
      // Only changes currently shown are actionable (validates webview input against our own state).
      const g = this.groups().find((x) => x.id === m.sessionId);
      const st = g && this.agents.getTranscriptStats(g.id);
      if (!g || !st) return;
      const shown = new Set(g.changes.map((r) => r.path));
      const changes = [...st.changes.values()].filter((c) => shown.has(c.path));
      if (!('path' in m)) {
        if (m.type === 'keepAll') await this.hide(g.id, changes);
        else await this.undo(g.id, changes);
      } else {
        const target = m.path;
        const c = changes.find((x) => x.path === target);
        if (!c) return;
        if (m.type === 'open') await vscode.window.showTextDocument(vscode.Uri.file(c.path), { preview: true });
        else if (m.type === 'openDiff') await this.diff(g.id, c);
        else if (m.type === 'keep') await this.hide(g.id, [c]);
        else await this.undo(g.id, [c]);
      }
      this.rerender(true);
    } catch (e) {
      void vscode.window.showErrorMessage(`Claude Control Center: ${e instanceof Error ? e.message : 'action failed'}`);
    }
  }

  /** Opens the baseline diff for a file Claude changed (used by the mod bridge). */
  async openDiffFor(sessionId: string, file: string): Promise<void> {
    const c = this.agents.getTranscriptStats(sessionId)?.changes.get(file);
    if (c) await this.diff(sessionId, c);
  }

  private async diff(sessionId: string, c: FileChange): Promise<void> {
    const left = baselineUri(sessionId, c);
    if (!left) { void vscode.window.showWarningMessage('No baseline backup recorded for this file; opening it instead.'); await vscode.window.showTextDocument(vscode.Uri.file(c.path)); return; }
    await vscode.commands.executeCommand('vscode.diff', left, vscode.Uri.file(c.path), `${path.basename(c.path)} (Claude changes)`, { preview: true });
  }

  /** Keep/Undo across sessions (filtered "All files" view); only currently shown changes qualify. */
  private async bulk(op: 'keep' | 'undo', items: { sessionId: string; path: string }[]): Promise<void> {
    const groups = this.groups();
    const per = new Map<string, FileChange[]>();
    for (const it of items) {
      const g = groups.find((x) => x.id === it.sessionId);
      const c = g?.changes.some((r) => r.path === it.path) ? this.agents.getTranscriptStats(it.sessionId)?.changes.get(it.path) : undefined;
      if (c) per.set(it.sessionId, [...(per.get(it.sessionId) ?? []), c]);
    }
    const total = [...per.values()].reduce((n, a) => n + a.length, 0);
    if (!total) return;
    if (op === 'keep') {
      const names = [...per.values()].flat().slice(0, 8).map((c) => path.basename(c.path)).join(', ') + (total > 8 ? ', …' : '');
      const ok = await vscode.window.showWarningMessage(`Keep ${total} file(s): ${names}? They will be dismissed from this list.`, { modal: true }, 'Keep');
      if (ok !== 'Keep') return;
      for (const [sid, cs] of per) await this.hide(sid, cs);
    } else {
      for (const [sid, cs] of per) await this.undo(sid, cs); // ponytail: one modal per session; merge if that annoys
    }
  }

  private async undo(sessionId: string, cs: FileChange[], what = "their content before this session's first edit"): Promise<void> {
    const plans: { c: FileChange; data?: Uint8Array }[] = [];
    const skipped: string[] = [];
    for (const c of cs) {
      if (!path.isAbsolute(c.path)) { skipped.push(`${path.basename(c.path)}: path is not absolute`); continue; }
      const b = readBaseline(sessionId, c.baseline);
      if (b.kind === 'unavailable') skipped.push(`${path.basename(c.path)}: ${b.reason}`);
      else plans.push({ c, data: b.kind === 'content' ? b.data : undefined });
    }
    if (!plans.length) { void vscode.window.showWarningMessage(`Nothing to undo. ${skipped.join('; ')}`); return; }
    const created = plans.filter((p) => !p.data).length;
    const names = plans.slice(0, 5).map((p) => path.basename(p.c.path)).join(', ') + (plans.length > 5 ? ', …' : '');
    const ok = await vscode.window.showWarningMessage(
      `Undo Claude's changes to ${plans.length} file(s): ${names}? Files are restored to ${what}${created ? `; ${created} newly created file(s) will be DELETED` : ''}. Unsaved editor changes for these files are lost.${skipped.length ? ` Skipped: ${skipped.join('; ')}` : ''}`,
      { modal: true }, 'Undo Changes');
    if (ok !== 'Undo Changes') return;
    const outside = plans.filter((p) => !isInside(p.c.path, this.roots()));
    if (outside.length) {
      const ok2 = await vscode.window.showWarningMessage(
        `${outside.length} file(s) are outside the open workspace folders: ${outside.slice(0, 5).map((p) => p.c.path).join(', ')}. Modify them anyway?`,
        { modal: true }, 'Modify Outside Workspace');
      if (ok2 !== 'Modify Outside Workspace') { for (const o of outside) plans.splice(plans.indexOf(o), 1); }
    }
    const done: FileChange[] = [];
    for (const p of plans) {
      const uri = vscode.Uri.file(p.c.path);
      try {
        if (p.data) await vscode.workspace.fs.writeFile(uri, p.data);
        else await vscode.workspace.fs.delete(uri, { useTrash: true });
        done.push(p.c);
      } catch (e) {
        void vscode.window.showErrorMessage(`Could not undo ${path.basename(p.c.path)}: ${e instanceof Error ? e.message : 'error'}`);
      }
    }
    await this.hide(sessionId, done);
  }

}
