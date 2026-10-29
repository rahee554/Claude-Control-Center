import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { isAllowedTranscript } from '../collectors/transcriptCollector';
import { AgentService } from '../services/agentService';
import { AgentInfo, isLive } from '../services/agentState';
import { CCC_HOME } from '../services/usageService';
import { cccBaseline, isOpenablePath, SESSION_ID_RE } from '../services/fileHistory';
import { AgentDetail, buildDetail, SubTail, tailDetail } from './agentDetail';
import { baselineUri } from './dashboardProvider';
import { iconId, iconUri } from './fileIcons';
import type { FileChange } from '../collectors/transcriptCollector';
import { layoutMap } from './agentsMap';
import { CHIP_TEXT, chipOf } from './dashboardState';
import { familyOf, subagentLabel, Timelines } from './timeline';

const ID_RE = /^[\w:.-]{1,80}$/;

interface WireNode { id: string; parent?: string; kind: 'session' | 'subagent' | 'task' | 'recent'; label: string; state: string; stateText: string; family?: string; tool?: string; since?: number; end?: number; account?: string; sessionId?: string }

function readJson(f: string): unknown { try { return fs.statSync(f).size > 1024 * 1024 ? undefined : JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return undefined; } }

type AgentsMsg = { type: 'ready' } | { type: 'closeDetail' } | { type: 'open'; sessionId: string; agentId?: string } | { type: 'detail'; sessionId: string; agentId?: string }
  | { type: 'openFile' | 'diffFile'; sessionId: string; agentId?: string; path: string };

export function parseAgentsMsg(m: unknown): AgentsMsg | undefined {
  if (!m || typeof m !== 'object') return undefined;
  const o = m as Record<string, unknown>;
  if (o.type === 'ready' || o.type === 'closeDetail') return { type: o.type };
  const idOk = typeof o.sessionId === 'string' && SESSION_ID_RE.test(o.sessionId) && (o.agentId === undefined || (typeof o.agentId === 'string' && ID_RE.test(o.agentId)));
  if (!idOk) return undefined;
  if (o.type === 'openFile' || o.type === 'diffFile') return typeof o.path === 'string' && o.path.length <= 1024 ? { type: o.type, sessionId: o.sessionId as string, agentId: o.agentId as string | undefined, path: o.path } : undefined;
  if (o.type === 'open' || o.type === 'detail') return { type: o.type, sessionId: o.sessionId as string, agentId: o.agentId as string | undefined };
  return undefined;
}

/** Agents tab controller (Tree | Map + detail drawer). The shell provider owns the webview and throttling. */
export class AgentsViewProvider {
  private openable = new Set<string>();
  /** Agent whose drawer is open (messages must refer to it). */
  private sel?: { sessionId: string; agentId?: string };
  private cur?: { sessionId: string; agentId: string; file: string; tail: SubTail; watcher?: fs.FSWatcher; timer?: NodeJS.Timeout };
  /** Posts a message to the Agents tab (set by the shell). */
  post: (msg: unknown) => void = () => undefined;
  /** Session the Agents tab scopes to by default (the Activity tab's session; set by extension wiring). */
  currentSession: () => string | undefined = () => undefined;

  constructor(private readonly agents: AgentService, private readonly timelines?: Timelines) {}

  async handle(raw: unknown): Promise<void> {
    const msg = parseAgentsMsg(raw);
    if (msg?.type === 'open') await this.open(msg.sessionId, msg.agentId);
    else if (msg?.type === 'detail') this.detail(msg.sessionId, msg.agentId);
    else if (msg?.type === 'closeDetail') { this.sel = undefined; this.unwatch(); }
    else if ((msg?.type === 'openFile' || msg?.type === 'diffFile') && this.sel && msg.sessionId === this.sel.sessionId && msg.agentId === this.sel.agentId && this.openable.has(msg.path)) {
      const roots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
      if (!isOpenablePath(msg.path, roots)) return;
      if (msg.type === 'diffFile') await this.diffFile(msg.path);
      else await vscode.window.showTextDocument(vscode.Uri.file(msg.path), { preview: true });
    }
  }

  /** Only agents we know about (live session, its subagents, or recent) can be opened. */
  private find(sessionId: string, agentId?: string): AgentInfo | undefined {
    const snap = this.agents.snapshot;
    const s = snap.sessions.find((x) => x.id === sessionId);
    if (!agentId) return s ?? snap.recent.find((x) => x.id === sessionId && x.kind === 'session');
    return s?.subagents.find((x) => x.id === agentId) ?? snap.recent.find((x) => x.id === agentId && x.sessionId === sessionId);
  }

  private async open(sessionId: string, agentId?: string): Promise<void> {
    const agent = this.find(sessionId, agentId) ?? this.find(sessionId);
    if (agent) await vscode.commands.executeCommand('ccc.openTranscript', { kind: agent.kind === 'session' ? 'session' : 'subagent', agent });
  }

  private detail(sessionId: string, agentId?: string): void {
    const a = this.find(sessionId, agentId);
    const tl = this.timelines;
    if (!a || !tl) return;
    const sess = this.agents.snapshot.sessions.find((x) => x.id === sessionId);
    const mainFile = this.agents.getTranscriptStats(sessionId)?.transcriptPath ?? sess?.transcriptPath;
    if (!mainFile || !isAllowedTranscript(mainFile)) return;
    const w = this.wire(a, a.kind === 'session' ? 'session' : 'subagent');
    const base = { id: a.id, sessionId, title: w.label, state: w.state, stateText: w.stateText, since: a.startTime, end: a.endTime };
    let d: AgentDetail;
    if (a.kind === 'session') {
      this.unwatch();
      d = buildDetail({ ...base, model: this.agents.getTranscriptStats(sessionId)?.model, turns: tl.get(mainFile).turns });
    } else {
      const x = tl.agentDetails(mainFile, a.id);
      const sub = Timelines.subagentFile(mainFile, a.id);
      const info = { ...base, title: subagentLabel({ description: x?.description, agentType: a.agentType, id: a.id }), type: x?.type ?? a.agentType, model: x?.model };
      if (sub && fs.existsSync(sub)) {
        if (this.cur?.file !== sub || this.cur.agentId !== a.id) { this.unwatch(); this.cur = { sessionId, agentId: a.id, file: sub, tail: new SubTail(sub) }; }
        const c = this.cur!;
        c.tail.poll();
        d = tailDetail(info, c.tail, x?.files);
        if (!c.watcher && a.status === 'running') this.watch(c);
      } else {
        this.unwatch();
        d = buildDetail({ ...info, turns: [], tools: x?.tools, files: x?.files });
      }
      if (x?.ms !== undefined && d.end === undefined && d.since) d.end = d.since + x.ms;
    }
    this.sel = { sessionId, agentId: a.kind === 'session' ? undefined : a.id };
    this.openable = new Set(d.files.map((f) => f.path));
    const icons: Record<string, string> = {};
    for (const f of d.files) { f.icon = iconId(f.name); icons[f.icon] ??= iconUri(f.icon); }
    this.post({ type: 'detail', detail: d, icons });
  }

  private watch(c: NonNullable<AgentsViewProvider['cur']>): void {
    try {
      c.watcher = fs.watch(c.file, () => {
        if (c.timer) return;
        c.timer = setTimeout(() => { c.timer = undefined; if (this.cur === c) this.detail(c.sessionId, c.agentId); }, 200);
      });
      c.watcher.on('error', () => this.unwatch());
    } catch { /* polled by the 3s refresh instead */ }
  }

  private unwatch(): void {
    if (this.cur?.timer) clearTimeout(this.cur.timer);
    this.cur?.watcher?.close();
    this.cur = undefined;
  }

  dispose(): void { this.unwatch(); }

  /** Diff of an agent-changed file against its baseline (file-history or hook `ccc-<sha1>`); falls back to opening it. */
  private async diffFile(p: string): Promise<void> {
    const s = this.sel;
    if (!s) return;
    const baseline = this.agents.getTranscriptStats(s.sessionId)?.changes.get(p)?.baseline ?? cccBaseline(s.sessionId, p);
    const left = baselineUri(s.sessionId, { path: p, baseline } as FileChange);
    const right = vscode.Uri.file(p);
    if (!left) { void vscode.window.showInformationMessage('No baseline recorded for this file; opening it instead.'); await vscode.window.showTextDocument(right, { preview: true }); return; }
    await vscode.commands.executeCommand('vscode.diff', left, right, `${path.basename(p)} (agent changes)`, { preview: true });
  }

  state() {
    const nodes = this.nodes();
    const current = this.currentSession();
    const live = nodes.filter((n) => n.kind !== 'recent');
    return { nodes, current, layout: layoutMap(live), layoutCurrent: layoutMap(live.filter((n) => n.sessionId === current)), now: Date.now() };
  }

  private wire(a: AgentInfo, kind: WireNode['kind'], parent?: string): WireNode {
    const h = this.agents.getHistory(a.sessionId, a.kind === 'subagent' ? a.id : undefined).filter((e) => a.kind === 'subagent' || !e.agentId);
    const chip = chipOf(a, h[h.length - 1]);
    let label: string, model: string | undefined;
    if (a.kind === 'session') {
      label = this.agents.sessionTitle(a.id, a.cwd);
      model = this.agents.getTranscriptStats(a.id)?.model;
    } else {
      const p = this.agents.getTranscriptStats(a.sessionId)?.transcriptPath;
      const d = p && this.timelines && isAllowedTranscript(p) ? this.timelines.agentDetails(p, a.id) : undefined;
      label = subagentLabel({ description: d?.description, agentType: a.agentType, id: a.id });
      model = d?.model;
    }
    return { id: a.id, parent, kind, label: label.slice(0, 80), state: chip, stateText: CHIP_TEXT[chip], family: model ? familyOf(model) : undefined, tool: a.currentTool?.slice(0, 40), since: a.startTime, end: a.endTime, sessionId: a.sessionId };
  }

  private tasks(): WireNode[] {
    const dir = path.join(CCC_HOME, 'tasks');
    let ids: string[] = [];
    try { ids = fs.readdirSync(dir).slice(-20); } catch { /* none */ }
    const out: WireNode[] = [];
    for (const id of ids) {
      const meta = (readJson(path.join(dir, id, 'task.json')) as { meta?: Record<string, unknown> } | undefined)?.meta;
      const st = readJson(path.join(dir, id, 'status.json')) as Record<string, unknown> | undefined;
      if (!meta || st?.state !== 'running') continue; // only live delegated work
      out.push({
        id: `task:${id.slice(0, 64)}`, kind: 'task', label: String(meta.title ?? id).slice(0, 80), state: 'running', stateText: CHIP_TEXT.running,
        family: typeof meta.model === 'string' ? familyOf(meta.model) : undefined, account: String(meta.accountLabel ?? 'account').slice(0, 40),
        since: typeof st.startedAt === 'number' ? st.startedAt : undefined
      });
    }
    return out;
  }

  private nodes(): WireNode[] {
    const snap = this.agents.snapshot;
    const out: WireNode[] = [];
    for (const s of snap.sessions) {
      out.push(this.wire(s, 'session'));
      for (const a of s.subagents) if (isLive(a) || a.status === 'running') out.push(this.wire(a, 'subagent', s.id));
    }
    const root = snap.sessions[0]?.id;
    for (const t of this.tasks()) out.push({ ...t, parent: root });
    // Recent (finished) agents: shown only in Tree mode, flagged by kind.
    for (const a of snap.recent.slice(0, 20)) out.push({ ...this.wire(a, 'recent'), parent: undefined });
    return out;
  }

}
