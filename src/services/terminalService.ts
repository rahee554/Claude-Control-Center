import * as vscode from 'vscode';
import { ProcessAdapter } from '../adapters/processAdapter';
import { buildAncestorMap, canTerminateAsGroup, classifyTerminal, OWNER_ENV, Ownership, SESSION_ENV } from '../security/ownership';
import { AgentService } from './agentService';
import { mergePidSources, readSessionPids } from './usageService';


export interface TerminalInfo {
  /** Stable per-window id assigned by this service. */
  id: string;
  terminal: vscode.Terminal;
  name: string;
  pid?: number;
  /** When this service first saw the terminal (creation time for terminals opened after activation). */
  firstSeen: number;
  ownership: Ownership;
  /** Sessions associated by ownership tag or process correlation. */
  sessionIds: string[];
  isActive: boolean;
}

export class TerminalService implements vscode.Disposable {
  private readonly infos = new Map<vscode.Terminal, TerminalInfo>();
  private nextId = 1;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  private classifying?: Promise<void>;
  private pending = false;

  constructor(private readonly agents: AgentService, private readonly processes: ProcessAdapter, private readonly ownerTag: string,
    private readonly mirrorOf: (t: vscode.Terminal) => string | undefined = () => undefined) {
    for (const t of vscode.window.terminals) this.add(t);
    this.disposables.push(
      this._onDidChange,
      vscode.window.onDidOpenTerminal((t) => { this.add(t); this.reclassify(); }),
      vscode.window.onDidCloseTerminal((t) => { this.infos.delete(t); this._onDidChange.fire(); }),
      vscode.window.onDidChangeActiveTerminal(() => this._onDidChange.fire()),
      vscode.window.onDidChangeTerminalState?.(() => this._onDidChange.fire()) ?? { dispose() { /* older API */ } }
    );
    const sub = agents.onDidChange(() => this.reclassify());
    this.disposables.push({ dispose: () => sub.dispose() });
    this.reclassify();
  }

  private add(t: vscode.Terminal): void {
    if (this.infos.has(t)) return;
    this.infos.set(t, { id: `t${this.nextId++}`, terminal: t, name: t.name, firstSeen: Date.now(), ownership: Ownership.Unknown, sessionIds: [], isActive: false });
  }

  /** Re-runs ownership classification (coalesced). */
  reclassify(): Promise<void> {
    if (this.classifying) { this.pending = true; return this.classifying; }
    this.classifying = this.doClassify().finally(() => {
      this.classifying = undefined;
      if (this.pending) { this.pending = false; void this.reclassify(); }
    });
    return this.classifying;
  }

  private async doClassify(): Promise<void> {
    const all = mergePidSources(this.agents.reportedPids(), this.sessionFiles());
    const chains: { sessionId: string; chain: number[] }[] = [];
    for (const [pid, { sessions, fromFile }] of all) {
      const chain = await this.processes.ancestors(pid);
      if (fromFile && chain.length < 2) continue; // stale sessions file (process gone) or correlation disabled
      for (const sessionId of sessions) chains.push({ sessionId, chain });
    }
    const ancestors = buildAncestorMap(chains);
    for (const info of this.infos.values()) {
      let pid: number | undefined;
      if (this.mirrorOf(info.terminal)) pid = undefined; else try { pid = await Promise.race([info.terminal.processId, new Promise<undefined>((r) => setTimeout(() => r(undefined), 2000))]); } catch { pid = undefined; }
      const opts = info.terminal.creationOptions as vscode.TerminalOptions;
      const env = 'env' in opts ? opts.env : undefined;
      const shellHint = 'shellPath' in opts ? [opts.shellPath, ...(Array.isArray(opts.shellArgs) ? opts.shellArgs : [opts.shellArgs ?? ''])].join(' ') : undefined;
      const r = classifyTerminal({ ownerTag: env?.[OWNER_ENV] ?? undefined, expectedTag: this.ownerTag, terminalPid: pid, name: info.terminal.name, mirrorSessionId: this.mirrorOf(info.terminal), shellHint, claudeAncestors: ancestors });
      const tagged = env?.[SESSION_ENV];
      info.pid = pid;
      info.name = info.terminal.name;
      info.ownership = r.ownership;
      info.sessionIds = tagged && !r.sessionIds.includes(tagged) ? [tagged, ...r.sessionIds] : r.sessionIds;
    }
    this._onDidChange.fire();
  }

  private sessionFiles(): Map<number, string> {
    try { return readSessionPids(); } catch { return new Map(); }
  }

  list(): TerminalInfo[] {
    const active = vscode.window.activeTerminal;
    return [...this.infos.values()].map((i) => ({ ...i, name: i.terminal.name, isActive: i.terminal === active }));
  }

  get(id: string): TerminalInfo | undefined { return this.list().find((i) => i.id === id); }

  /** "folder · id8" for tree descriptions (terminal names stay plain "Claude"). */
  sessionLabel(sessionId: string): string {
    const snap = this.agents.snapshot;
    const a = snap.sessions.find((s) => s.id === sessionId) ?? snap.recent.find((r) => r.id === sessionId);
    return this.agents.sessionTitle(sessionId, a?.cwd);
  }

  forSession(sessionId: string): TerminalInfo[] { return this.list().filter((i) => i.sessionIds.includes(sessionId)); }

  createTerminal(opts: { name?: string; sessionId?: string; cwd?: string } = {}): vscode.Terminal {
    const env: Record<string, string> = { [OWNER_ENV]: this.ownerTag };
    if (opts.sessionId && /^[A-Za-z0-9_-]{1,128}$/.test(opts.sessionId)) env[SESSION_ENV] = opts.sessionId;
    const t = vscode.window.createTerminal({ name: opts.name ?? 'Claude Control Center', cwd: opts.cwd, env });
    t.show();
    return t;
  }

  focus(info: TerminalInfo): void { info.terminal.show(false); }

  async openInEditor(info: TerminalInfo): Promise<void> {
    info.terminal.show(false);
    await vscode.commands.executeCommand('workbench.action.terminal.moveToEditor');
  }

  async split(info: TerminalInfo): Promise<void> {
    info.terminal.show(false);
    await vscode.commands.executeCommand('workbench.action.terminal.split');
  }

  async rename(info: TerminalInfo, name: string): Promise<void> {
    info.terminal.show(false);
    await vscode.commands.executeCommand('workbench.action.terminal.renameWithArg', { name });
    this._onDidChange.fire();
  }

  /** Closes one terminal (VS Code terminal only; never kills OS processes). Returns true if disposed. */
  async terminate(info: TerminalInfo, requireConfirmation: boolean): Promise<boolean> {
    if (requireConfirmation) {
      const assoc = info.sessionIds.length ? ` (session ${info.sessionIds.map((s) => s.slice(0, 8)).join(', ')})` : '';
      const ok = await vscode.window.showWarningMessage(
        `Close terminal "${info.terminal.name}"${assoc}? Any process running in it will be ended by VS Code.`,
        { modal: true }, 'Close Terminal');
      if (ok !== 'Close Terminal') return false;
    }
    info.terminal.dispose();
    return true;
  }

  /** Terminals eligible for group termination of a session: ExtensionOwned/ClaudeConfirmed only. */
  groupFor(sessionId: string): TerminalInfo[] {
    return this.forSession(sessionId).filter((i) => canTerminateAsGroup(i.ownership));
  }

  async terminateGroup(sessionId: string, requireConfirmation: boolean): Promise<number> {
    await this.reclassify();
    const group = this.groupFor(sessionId);
    if (!group.length) {
      void vscode.window.showInformationMessage('No terminals are confirmed to belong to this session.');
      return 0;
    }
    if (requireConfirmation) {
      const names = group.map((g) => `"${g.terminal.name}"`).join(', ');
      const ok = await vscode.window.showWarningMessage(
        `Close ${group.length} terminal(s) of session ${sessionId.slice(0, 8)}: ${names}?`, { modal: true }, 'Close Terminals');
      if (ok !== 'Close Terminals') return 0;
    }
    for (const g of group) g.terminal.dispose();
    return group.length;
  }

  dispose(): void { this.disposables.forEach((d) => d.dispose()); }
}
