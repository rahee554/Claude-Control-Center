import { HookCollector } from '../collectors/hookCollector';
import { FileEdit, TranscriptCollector, TranscriptStats } from '../collectors/transcriptCollector';
import { CccEvent } from '../models/events';
import { sessionTitle } from '../views/dashboardState';
import { Emitter } from '../util/emitter';
import { AgentSnapshot, AgentStore, AgentStoreOptions, SessionInfo } from './agentState';

export * from './agentState';

export interface AgentServiceOptions extends AgentStoreOptions {
  refreshIntervalMs: number;
}

/** Glue: hook events -> AgentStore, transcript paths -> TranscriptCollector. vscode-free. */
export class AgentService {
  private readonly store: AgentStore;
  private snap: AgentSnapshot;
  private paused = false;
  private timer?: NodeJS.Timeout;
  private readonly subs: { dispose(): void }[] = [];
  private readonly _onDidChange = new Emitter<void>();
  /** Fired when sessions/subagents/staleness change. */
  readonly onDidChange = this._onDidChange.event;
  private readonly _onDidReceiveEvents = new Emitter<CccEvent[]>();
  /** Raw (sanitized, deduped) hook events as they arrive. */
  readonly onDidReceiveEvents = this._onDidReceiveEvents.event;
  /** Transcript stats updates (model, usage, context tokens, file edits). */
  readonly onDidUpdateTranscript;

  constructor(readonly hooks: HookCollector, readonly transcripts: TranscriptCollector, private opts: AgentServiceOptions) {
    this.store = new AgentStore(opts);
    this.snap = this.store.snapshot();
    this.onDidUpdateTranscript = transcripts.onDidUpdate;
    this.subs.push(hooks.onEvents((evs) => this.ingest(evs)));
  }

  start(): void {
    this.hooks.start();
    this.restartTimer();
  }

  private restartTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), Math.max(1000, this.opts.refreshIntervalMs));
  }

  private tick(): void {
    if (this.paused) return;
    this.transcripts.poll();
    if (this.store.refreshStale()) this.publish();
  }

  ingest(evs: CccEvent[]): void {
    const sorted = [...evs].sort((a, b) => a.ts.localeCompare(b.ts));
    for (const e of sorted) {
      // Shell output can be large; keep it out of the in-memory history (the mirror reads it from the event stream).
      this.store.apply(e.stdout || e.stderr ? { ...e, stdout: undefined, stderr: undefined } : e);
      if (e.transcriptPath && !e.agentId) this.transcripts.track(e.sessionId, e.transcriptPath);
    }
    this._onDidReceiveEvents.fire(sorted);
    this.publish();
  }

  private publish(): void {
    this.snap = this.store.snapshot();
    this._onDidChange.fire();
  }

  updateOptions(opts: Partial<AgentServiceOptions>): void {
    this.opts = { ...this.opts, ...opts };
    this.store.setOptions(this.opts);
    this.hooks.setPollInterval(this.opts.refreshIntervalMs);
    this.restartTimer();
    this.store.refreshStale();
    this.publish();
  }

  get snapshot(): AgentSnapshot { return this.snap; }
  get isPaused(): boolean { return this.paused; }
  /** True when there are live-looking sessions but nothing has arrived for staleAfter. */
  get isStale(): boolean {
    const last = this.snap.lastEventAt;
    return last !== undefined && this.snap.sessions.length > 0 && Date.now() - last > this.opts.staleAfterMs;
  }

  setPaused(p: boolean): void {
    this.paused = p;
    this.hooks.setPaused(p);
    this._onDidChange.fire();
  }

  refresh(): void {
    this.hooks.scan();
    this.transcripts.poll();
    this.store.refreshStale();
    this.publish();
  }

  getSession(sessionId: string): SessionInfo | undefined { return this.snap.sessions.find((s) => s.id === sessionId); }
  getHistory(sessionId?: string, agentId?: string): CccEvent[] { return this.store.getHistory(sessionId, agentId); }
  getTranscriptStats(sessionId: string): TranscriptStats | undefined { return this.transcripts.getStats(sessionId); }
  /** Human session label (custom/AI title, first prompt, else folder · id8). */
  sessionTitle(id: string, cwd?: string): string { return sessionTitle(this.getTranscriptStats(id) ?? { sessionId: id }, cwd ?? this.getSession(id)?.cwd); }
  getFileEdits(sessionId?: string): FileEdit[] { return this.transcripts.getFileEdits(sessionId); }

  /** pid -> sessionIds reported by hooks for live (non-terminal) sessions. */
  reportedPids(): Map<number, string[]> {
    const m = new Map<number, string[]>();
    for (const s of this.snap.sessions) for (const p of s.pids) m.set(p, [...(m.get(p) ?? []), s.id]);
    return m;
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.subs.forEach((d) => d.dispose());
    this._onDidChange.dispose();
    this._onDidReceiveEvents.dispose();
  }
}
