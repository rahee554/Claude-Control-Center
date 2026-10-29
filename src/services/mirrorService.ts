import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { DEFAULT_EVENTS_DIR } from '../collectors/hookCollector';
import { CccEvent, eventTime, parseEventLine } from '../models/events';
import { AgentService } from './agentService';
import { MIRROR_TOOLS, MirrorFormatter, mirrorBanner } from './mirrorFormat';

export interface MirrorOptions { enabled: boolean; focus: 'never' | 'onCreate' }

interface Mirror {
  terminal: vscode.Terminal;
  write: vscode.EventEmitter<string>;
  formatter: MirrorFormatter;
  /** Text written before the pty was opened. */
  buffer?: string[];
}

const READ_ONLY_HINT = '\r\n\x1b[2m(read-only mirror of Claude\'s commands)\x1b[0m\r\n';

/** One read-only pseudoterminal per Claude session that mirrors its Bash/PowerShell tool calls. */
export class MirrorService implements vscode.Disposable {
  private readonly mirrors = new Map<string, Mirror>();
  /** Sessions whose mirror the user closed; not recreated until replayed. */
  private readonly closed = new Set<string>();
  private readonly activatedAt = Date.now();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(agents: AgentService, private opts: () => MirrorOptions) {
    const sub = agents.onDidReceiveEvents((evs) => this.onEvents(evs));
    this.disposables.push({ dispose: () => sub.dispose() }, this._onDidChange,
      vscode.window.onDidCloseTerminal((t) => {
        for (const [sid, m] of this.mirrors) {
          if (m.terminal !== t) continue;
          this.mirrors.delete(sid);
          this.closed.add(sid);
          m.write.dispose();
          this._onDidChange.fire();
        }
      }));
  }

  /** Session id mirrored by `t`, if it is one of ours. */
  sessionOf(t: vscode.Terminal): string | undefined {
    for (const [sid, m] of this.mirrors) if (m.terminal === t) return sid;
    return undefined;
  }

  terminalFor(sessionId: string): vscode.Terminal | undefined { return this.mirrors.get(sessionId)?.terminal; }

  private onEvents(evs: CccEvent[]): void {
    if (!this.opts().enabled) return;
    for (const e of evs) {
      // Only live events: the collector re-reads a tail of history on reload.
      if (eventTime(e) < this.activatedAt - 2000 || !e.toolName || !MIRROR_TOOLS.has(e.toolName)) continue;
      if (this.closed.has(e.sessionId)) continue;
      let m = this.mirrors.get(e.sessionId);
      if (!m && e.event === 'PreToolUse') m = this.create(e.sessionId, e.cwd);
      if (!m) continue;
      const text = m.formatter.render(e);
      if (text) this.write(m, text);
    }
  }

  private write(m: Mirror, text: string): void {
    if (m.buffer) m.buffer.push(text); else m.write.fire(text);
  }

  private create(sessionId: string, cwd?: string): Mirror {
    const write = new vscode.EventEmitter<string>();
    let hinted = false;
    const m: Mirror = { write, formatter: new MirrorFormatter(), buffer: [mirrorBanner(sessionId, cwd)], terminal: undefined as unknown as vscode.Terminal };
    const pty: vscode.Pseudoterminal = {
      onDidWrite: write.event,
      open: () => { const b = m.buffer ?? []; m.buffer = undefined; for (const t of b) write.fire(t); },
      close: () => { /* closing the mirror never touches Claude's processes */ },
      handleInput: () => { if (!hinted) { hinted = true; write.fire(READ_ONLY_HINT); } }
    };
    // Name stays just "Claude"; session/folder live in the Terminals tree description/tooltip.
    m.terminal = vscode.window.createTerminal({
      name: 'Claude', pty, isTransient: true,
      iconPath: new vscode.ThemeIcon('sparkle'), color: new vscode.ThemeColor('terminal.ansiMagenta')
    });
    if (this.opts().focus === 'onCreate') m.terminal.show(true);
    this.mirrors.set(sessionId, m);
    this._onDidChange.fire();
    return m;
  }

  /** Re-renders a session's recorded shell commands (from its event file) into its mirror. */
  replay(sessionId: string, cwd?: string): void {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) throw new Error('Invalid session id');
    const file = path.join(DEFAULT_EVENTS_DIR, `${sessionId}.jsonl`);
    let text = '';
    try {
      const size = fs.statSync(file).size;
      const len = Math.min(size, 4 * 1024 * 1024);
      const buf = Buffer.alloc(len);
      const fd = fs.openSync(file, 'r');
      try { fs.readSync(fd, buf, 0, len, size - len); } finally { fs.closeSync(fd); }
      text = buf.toString('utf8');
    } catch { throw new Error('No recorded events for this session'); }
    this.closed.delete(sessionId);
    const m = this.mirrors.get(sessionId) ?? this.create(sessionId, cwd);
    this.write(m, '\x1b[2m--- replay of recorded commands ---\x1b[0m\r\n');
    const fmt = new MirrorFormatter();
    for (const line of text.split('\n')) {
      const e = parseEventLine(line);
      const out = e && e.sessionId === sessionId ? fmt.render(e) : undefined;
      if (out) this.write(m, out);
    }
    this.write(m, '\x1b[2m--- end of replay ---\x1b[0m\r\n\r\n');
    m.terminal.show(true);
  }

  dispose(): void {
    for (const m of this.mirrors.values()) { m.terminal.dispose(); m.write.dispose(); }
    this.mirrors.clear();
    this.disposables.forEach((d) => d.dispose());
  }
}
