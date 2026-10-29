// Pure agent lifecycle logic. No vscode import: unit-tested directly.
import { CccEvent, eventTime } from '../models/events';
import { isNoiseCwd } from '../util/noiseSessions';

export type AgentStatus = 'running' | 'waiting' | 'completed' | 'failed' | 'unknown';
export type AgentKind = 'session' | 'subagent';

export interface AgentInfo {
  /** sessionId for sessions, agentId for subagents. */
  id: string;
  sessionId: string;
  kind: AgentKind;
  agentType?: string;
  status: AgentStatus;
  currentTool?: string;
  lastSummary?: string;
  startTime: number;
  lastActivity: number;
  endTime?: number;
  cwd?: string;
  transcriptPath?: string;
  /** Process ids reported by hook events (parent of the hook process). */
  pids: number[];
  stale: boolean;
  eventCount: number;
}

export interface SessionInfo extends AgentInfo {
  subagents: AgentInfo[];
}

export interface AgentSnapshot {
  sessions: SessionInfo[];
  recent: AgentInfo[];
  activeCount: number;
  staleCount: number;
  lastEventAt?: number;
}

export interface AgentStoreOptions {
  staleAfterMs: number;
  historyLimit: number;
  recentLimit: number;
  maxSessions?: number;
}

interface MutableSession { info: AgentInfo; subs: Map<string, AgentInfo> }

const TERMINAL: ReadonlySet<AgentStatus> = new Set(['completed', 'failed']);
const RESTART_EVENTS = new Set(['SessionStart', 'UserPromptSubmit']);

export function isLive(a: AgentInfo): boolean {
  return !a.stale && !TERMINAL.has(a.status);
}

export class AgentStore {
  private readonly sessions = new Map<string, MutableSession>();
  private recent: AgentInfo[] = [];
  private history: CccEvent[] = [];
  private lastEventAt?: number;
  private readonly ended = new Map<string, number>();

  constructor(private opts: AgentStoreOptions) {}

  setOptions(opts: Partial<AgentStoreOptions>): void {
    this.opts = { ...this.opts, ...opts };
    this.trim();
  }

  /** Applies one event. Out-of-order (older) events go to history but never regress state. */
  apply(e: CccEvent, now = Date.now()): void {
    const t = eventTime(e);
    this.history.push(e);
    this.lastEventAt = Math.max(this.lastEventAt ?? 0, t);
    let s = this.sessions.get(e.sessionId);
    const endedAt = this.ended.get(e.sessionId);
    if (!s && endedAt !== undefined && !(RESTART_EVENTS.has(e.event) && !e.agentId && t > endedAt)) {
      this.trim(); // straggler for an ended session: keep in history only, don't resurrect
      return;
    }
    if (!s) {
      this.ended.delete(e.sessionId);
      s = { info: newAgent(e.sessionId, e.sessionId, 'session', t), subs: new Map() };
      this.sessions.set(e.sessionId, s);
    }
    const sess = s.info;
    if (e.cwd && (!sess.cwd || e.event === 'SessionStart')) sess.cwd = e.cwd; // first cwd = project label (subagents may run elsewhere)
    if (e.transcriptPath) sess.transcriptPath = e.transcriptPath;
    if (e.pid && !sess.pids.includes(e.pid)) sess.pids = [...sess.pids, e.pid].slice(-8);
    sess.startTime = Math.min(sess.startTime, t);

    if (e.agentId && e.event !== 'SessionStart' && e.event !== 'SessionEnd') {
      let sub = s.subs.get(e.agentId);
      if (!sub) {
        sub = newAgent(e.agentId, e.sessionId, 'subagent', t);
        s.subs.set(e.agentId, sub);
      }
      if (e.agentType) sub.agentType = e.agentType;
      if (e.cwd) sub.cwd = e.cwd;
      sub.startTime = Math.min(sub.startTime, t);
      this.transition(sub, e, t);
      if (TERMINAL.has(sub.status)) {
        s.subs.delete(sub.id);
        this.pushRecent(sub);
      }
      touch(sess, t); // subagent activity keeps the parent alive
      if (sess.status === 'waiting' || sess.status === 'unknown') sess.status = 'running';
    } else {
      this.transition(sess, e, t);
      if (TERMINAL.has(sess.status)) {
        for (const sub of s.subs.values()) {
          sub.status = sess.status === 'failed' ? 'failed' : 'completed';
          sub.endTime = sess.endTime;
          this.pushRecent(sub);
        }
        s.subs.clear();
        this.sessions.delete(sess.id);
        this.ended.set(sess.id, sess.endTime ?? t);
        if (this.ended.size > 1000) this.ended.delete(this.ended.keys().next().value as string);
        this.pushRecent(sess);
      }
    }
    this.refreshStale(now);
    this.trim();
  }

  private transition(a: AgentInfo, e: CccEvent, t: number): void {
    a.eventCount++;
    const older = t < a.lastActivity;
    if (TERMINAL.has(a.status) && !(RESTART_EVENTS.has(e.event) && !older)) return;
    if (older) return;
    a.lastActivity = t;
    a.stale = false;
    if (e.summary) a.lastSummary = e.summary;
    switch (e.event) {
      case 'SessionStart':
        a.status = 'waiting'; a.endTime = undefined; a.currentTool = undefined; break;
      case 'UserPromptSubmit':
      case 'SubagentStart':
        a.status = 'running'; a.endTime = undefined; break;
      case 'PreToolUse':
        a.status = 'running'; a.currentTool = e.toolName; break;
      case 'PostToolUse':
      case 'PostToolUseFailure':
        a.status = 'running'; a.currentTool = undefined; break;
      case 'Notification':
        a.status = 'waiting'; break;
      case 'Stop':
        a.status = a.kind === 'subagent' ? 'completed' : 'waiting'; a.currentTool = undefined;
        if (a.kind === 'subagent') a.endTime = t;
        break;
      case 'StopFailure':
        a.status = 'failed'; a.currentTool = undefined; a.endTime = t; break;
      case 'SubagentStop':
        a.status = e.isError ? 'failed' : 'completed'; a.currentTool = undefined; a.endTime = t; break;
      case 'SessionEnd':
        a.status = e.isError ? 'failed' : 'completed'; a.currentTool = undefined; a.endTime = t; break;
      default:
        if (a.status === 'unknown') a.status = 'running';
    }
  }

  private pushRecent(a: AgentInfo): void {
    this.recent = [a, ...this.recent.filter((r) => r.id !== a.id)].slice(0, this.opts.recentLimit);
  }

  /** Marks agents stale when silent for staleAfterMs. Returns true if anything changed. */
  refreshStale(now = Date.now()): boolean {
    let changed = false;
    const check = (a: AgentInfo) => {
      const stale = !TERMINAL.has(a.status) && now - a.lastActivity > this.opts.staleAfterMs;
      if (stale !== a.stale) { a.stale = stale; changed = true; }
    };
    for (const s of this.sessions.values()) { check(s.info); s.subs.forEach(check); }
    return changed;
  }

  private trim(): void {
    if (this.history.length > this.opts.historyLimit) this.history = this.history.slice(-this.opts.historyLimit);
    if (this.recent.length > this.opts.recentLimit) this.recent = this.recent.slice(0, this.opts.recentLimit);
    const max = this.opts.maxSessions ?? 200;
    if (this.sessions.size > max) {
      const oldest = [...this.sessions.values()].sort((a, b) => a.info.lastActivity - b.info.lastActivity);
      for (const s of oldest.slice(0, this.sessions.size - max)) this.sessions.delete(s.info.id);
    }
  }

  getHistory(sessionId?: string, agentId?: string): CccEvent[] {
    return this.history.filter((e) => (!sessionId || e.sessionId === sessionId) && (!agentId || e.agentId === agentId));
  }

  snapshot(): AgentSnapshot {
    const sessions: SessionInfo[] = [...this.sessions.values()]
      .map((s) => ({ ...s.info, subagents: [...s.subs.values()].map((x) => ({ ...x })) }))
      .filter((s) => !isNoiseCwd(s.cwd))
      .sort((a, b) => b.lastActivity - a.lastActivity);
    const all = sessions.flatMap((s) => [s, ...s.subagents]);
    return {
      sessions,
      recent: this.recent.filter((r) => !isNoiseCwd(r.cwd)).map((r) => ({ ...r })),
      activeCount: sessions.filter(isLive).length,
      staleCount: all.filter((a) => a.stale).length,
      lastEventAt: this.lastEventAt
    };
  }
}

function newAgent(id: string, sessionId: string, kind: AgentKind, t: number): AgentInfo {
  return { id, sessionId, kind, status: 'unknown', startTime: t, lastActivity: Number.NEGATIVE_INFINITY, pids: [], stale: false, eventCount: 0 };
}

function touch(a: AgentInfo, t: number): void {
  if (t > a.lastActivity) { a.lastActivity = t; a.stale = false; }
}
