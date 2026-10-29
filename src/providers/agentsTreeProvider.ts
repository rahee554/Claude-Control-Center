import * as vscode from 'vscode';
import { AgentInfo, AgentService, SessionInfo } from '../services/agentService';
import { isAllowedTranscript } from '../collectors/transcriptCollector';
import { CHIP_TEXT, chipOf, fmtTokens } from '../views/dashboardState';
import { familyOf, subagentLabel, Timelines } from '../views/timeline';

export type AgentNode =
  | { kind: 'session'; agent: SessionInfo }
  | { kind: 'subagent'; agent: AgentInfo }
  | { kind: 'recentGroup' }
  | { kind: 'recentAgent'; agent: AgentInfo }
  | { kind: 'empty'; label: string };

export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function icon(a: AgentInfo): vscode.ThemeIcon {
  if (a.stale) return new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('disabledForeground'));
  switch (a.status) {
    case 'running': return new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('charts.blue'));
    case 'waiting': return new vscode.ThemeIcon('bell-dot', new vscode.ThemeColor('charts.orange'));
    case 'completed': return new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'));
    case 'failed': return new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'));
    default: return new vscode.ThemeIcon('question');
  }
}

function typeIcon(type?: string): vscode.ThemeIcon {
  const t = (type ?? '').toLowerCase();
  const id = t.includes('explore') || t.includes('search') ? 'search' : t.includes('plan') ? 'checklist' : t.includes('review') ? 'eye' : t.includes('test') ? 'beaker' : 'hubot';
  return new vscode.ThemeIcon(id, new vscode.ThemeColor('charts.blue'));
}

/** 5-block diffstat like GitHub (green/red/neutral squares). */
export function diffstat(add: number, del: number): string {
  const tot = add + del, g = tot ? Math.round((add / tot) * 5) : 0;
  return '🟩'.repeat(g) + '🟥'.repeat(tot ? 5 - g : 0) + (tot ? '' : '⬜'.repeat(5));
}

function esc(s: string): string { return s.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&'); }

export class AgentsTreeProvider implements vscode.TreeDataProvider<AgentNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<AgentNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private filter = '';

  constructor(private readonly agents: AgentService, private readonly timelines?: Timelines) {}

  private chip(a: AgentInfo): string {
    const h = this.agents.getHistory(a.sessionId, a.kind === 'subagent' ? a.id : undefined).filter((e) => a.kind === 'subagent' || !e.agentId);
    return CHIP_TEXT[chipOf(a, h[h.length - 1])];
  }

  private details(a: AgentInfo) {
    if (a.kind !== 'subagent' || !this.timelines) return undefined;
    const p = this.agents.getTranscriptStats(a.sessionId)?.transcriptPath;
    return p && isAllowedTranscript(p) ? this.timelines.agentDetails(p, a.id) : undefined;
  }

  refresh(): void { this._onDidChangeTreeData.fire(undefined); }

  setFilter(text: string): void { this.filter = text.trim().toLowerCase(); this.refresh(); }
  get filterText(): string { return this.filter; }

  private matches(a: AgentInfo): boolean {
    if (!this.filter) return true;
    return [a.id, a.agentType, a.cwd, a.currentTool, a.status].some((v) => v?.toLowerCase().includes(this.filter));
  }

  getChildren(node?: AgentNode): AgentNode[] {
    const snap = this.agents.snapshot;
    if (!node) {
      const sessions = snap.sessions.filter((s) => this.matches(s) || s.subagents.some((x) => this.matches(x)));
      const out: AgentNode[] = sessions.map((agent) => ({ kind: 'session', agent }));
      if (!out.length) out.push({ kind: 'empty', label: this.filter ? `No agents match "${this.filter}"` : 'No active Claude Code sessions' });
      if (snap.recent.length) out.push({ kind: 'recentGroup' });
      return out;
    }
    if (node.kind === 'session') return node.agent.subagents.filter((a) => this.matches(a) || this.matches(node.agent)).map((agent) => ({ kind: 'subagent', agent }));
    if (node.kind === 'recentGroup') return snap.recent.filter((a) => this.matches(a)).map((agent) => ({ kind: 'recentAgent', agent }));
    return [];
  }

  getTreeItem(node: AgentNode): vscode.TreeItem {
    if (node.kind === 'empty') {
      const item = new vscode.TreeItem(node.label);
      item.iconPath = new vscode.ThemeIcon('info');
      item.contextValue = 'empty';
      return item;
    }
    if (node.kind === 'recentGroup') {
      const item = new vscode.TreeItem('Recent', vscode.TreeItemCollapsibleState.Collapsed);
      item.iconPath = new vscode.ThemeIcon('history');
      item.contextValue = 'recentGroup';
      item.description = `${this.agents.snapshot.recent.length}`;
      return item;
    }
    const a = node.agent;
    const now = Date.now();
    const d = this.details(a);
    const label = a.kind === 'session' ? this.agents.sessionTitle(a.id, a.cwd) : subagentLabel({ description: d?.description, agentType: a.agentType, id: a.id });
    const collapsible = node.kind === 'session' && node.agent.subagents.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None;
    const item = new vscode.TreeItem(a.stale ? `${label} (stale)` : label, collapsible);
    item.id = `${node.kind}:${a.id}`;
    item.iconPath = a.kind === 'subagent' && a.status === 'running' && !a.stale ? typeIcon(a.agentType) : icon(a);
    item.contextValue = node.kind;
    const elapsed = formatElapsed((a.endTime ?? now) - a.startTime);
    const state = this.chip(a);
    const model = a.kind === 'session' ? undefined : d?.model;
    const sModel = a.kind === 'session' ? this.agents.getTranscriptStats(a.id)?.model : model;
    item.description = [a.kind === 'subagent' && a.agentType && a.agentType !== 'general-purpose' && label !== a.agentType ? a.agentType : undefined, state, a.currentTool, elapsed, sModel ? familyOf(sModel) : undefined].filter(Boolean).join(' · ');
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = false;
    md.appendMarkdown(`**${esc(a.kind === 'session' ? 'Session' : 'Subagent')}** — ${esc(state)}\n\n`);
    md.appendMarkdown(`- ID: \`${a.id.replace(/`/g, '')}\`\n`);
    if (a.kind === 'subagent') md.appendMarkdown(`- Session: \`${a.sessionId.replace(/`/g, '')}\`\n`);
    if (a.agentType) md.appendMarkdown(`- Type: ${esc(a.agentType)}\n`);
    if (a.cwd) md.appendMarkdown(`- CWD: ${esc(a.cwd)}\n`);
    if (a.currentTool) md.appendMarkdown(`- Tool: ${esc(a.currentTool)}\n`);
    if (d?.description) md.appendMarkdown(`- Task: ${esc(d.description)}\n`);
    if (d) md.appendMarkdown(`- Tools: ${d.tools.length}${d.tokens ? ` · tokens ${fmtTokens(d.tokens)}` : ''}\n`);
    if (model) md.appendMarkdown(`- Model: ${esc(model)}\n`);
    if (a.lastSummary) md.appendMarkdown(`- Last: ${esc(a.lastSummary)}\n`);
    md.appendMarkdown(`- Started: ${new Date(a.startTime).toLocaleTimeString()} (${elapsed})\n`);
    if (Number.isFinite(a.lastActivity)) md.appendMarkdown(`- Last activity: ${formatElapsed(now - a.lastActivity)} ago\n`);
    if (a.kind === 'session') {
      const st = this.agents.getTranscriptStats(a.id);
      if (st?.model) md.appendMarkdown(`- Model: ${esc(st.model)}\n`);
      if (st && st.changes.size) {
        const add = [...st.changes.values()].reduce((n, c) => n + c.added, 0), del = [...st.changes.values()].reduce((n, c) => n + c.removed, 0);
        md.appendMarkdown(`- Files: ${st.changes.size} · +${add} additions · −${del} deletions ${diffstat(add, del)}
`);
      }
      if (st) md.appendMarkdown(`- Context: ${st.contextTokens.toLocaleString()} tokens · output ${st.usage.outputTokens.toLocaleString()}\n`);
    }
    item.tooltip = md;
    return item;
  }

  dispose(): void { this._onDidChangeTreeData.dispose(); }
}
