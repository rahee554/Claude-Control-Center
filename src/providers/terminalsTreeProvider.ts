import * as vscode from 'vscode';
import { Ownership } from '../security/ownership';
import { TerminalInfo, TerminalService } from '../services/terminalService';
import { formatElapsed } from './agentsTreeProvider';

const LABELS: Record<Ownership, string> = {
  [Ownership.ExtensionOwned]: 'created here',
  [Ownership.ClaudeConfirmed]: 'Claude (confirmed)',
  [Ownership.ClaudeLikely]: 'Claude (likely)',
  [Ownership.ClaudeMirror]: 'Claude (mirror)',
  [Ownership.Unrelated]: '',
  [Ownership.Unknown]: ''
};

export class TerminalsTreeProvider implements vscode.TreeDataProvider<TerminalInfo> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly terminals: TerminalService) {}

  refresh(): void { this._onDidChangeTreeData.fire(undefined); }

  getChildren(node?: TerminalInfo): TerminalInfo[] {
    return node ? [] : this.terminals.list();
  }

  getTreeItem(t: TerminalInfo): vscode.TreeItem {
    const item = new vscode.TreeItem(t.name);
    item.id = t.id;
    const claude = t.ownership === Ownership.ClaudeConfirmed || t.ownership === Ownership.ClaudeLikely || t.ownership === Ownership.ClaudeMirror;
    item.iconPath = new vscode.ThemeIcon(claude ? 'sparkle' : 'terminal', claude ? new vscode.ThemeColor('terminal.ansiMagenta') : t.isActive ? new vscode.ThemeColor('terminal.ansiGreen') : undefined);
    item.contextValue = `terminal.${t.ownership}${t.sessionIds.length ? '.session' : ''}`;
    const sessions = t.sessionIds.map((id) => this.terminals.sessionLabel(id));
    item.description = [sessions[0], LABELS[t.ownership], t.isActive ? 'active' : '', formatElapsed(Date.now() - t.firstSeen)].filter(Boolean).join(' · ');
    const md = new vscode.MarkdownString(undefined, false);
    md.isTrusted = false;
    md.appendText(`Terminal: ${t.name}\nOwnership: ${t.ownership}\nPID: ${t.pid ?? 'unknown'}\n`);
    if (t.sessionIds.length) md.appendText(`Sessions: ${t.sessionIds.join(', ')}\n`);
    md.appendText(`First seen: ${new Date(t.firstSeen).toLocaleString()}`);
    item.tooltip = md;
    item.command = { command: 'ccc.focusTerminal', title: 'Focus Terminal', arguments: [t] };
    return item;
  }

  dispose(): void { this._onDidChangeTreeData.dispose(); }
}
