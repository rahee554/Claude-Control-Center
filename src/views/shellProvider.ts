import * as crypto from 'crypto';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { CheckpointController } from '../checkpoints/controller';
import { AgentsViewProvider } from './agentsViewProvider';
import { DashboardProvider } from './dashboardProvider';
import { DASH_TABS, isTab, parseShellMsg, routeOf, TabId } from './shellTabs';

const MIN_POST_MS = 150;
const TAB_KEY = 'ccc.activeTab';

/** The single sidebar webview: icon tab bar + one tab body rendered at a time. */
export class ShellProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'ccc.dashboard';
  private view?: vscode.WebviewView;
  private lastPost = 0;
  private timer?: NodeJS.Timeout;
  private active: TabId;
  readonly checkpoints = new CheckpointController();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly dash: DashboardProvider,
    private readonly agents: AgentsViewProvider,
    private readonly runningAgents: () => number
  ) {
    const saved = context.globalState.get<unknown>(TAB_KEY);
    this.active = isTab(saved) ? saved : 'activity';
    dash.rerender = (force) => this.render(force);
    agents.post = (m) => this.post('agents', m);
    this.checkpoints.post = (m) => this.post('checkpoints', m);
  }

  get activeTab(): TabId { return this.active; }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    const nonce = crypto.randomBytes(16).toString('base64');
    const uri = (f: string) => view.webview.asWebviewUri(vscode.Uri.joinPath(media, f)).toString();
    const has = (f: string) => fs.existsSync(vscode.Uri.joinPath(media, f).fsPath);
    const css = ['shell.css', 'dashboard.css', 'agents.css', 'checkpoints.css'].filter(has).map((f) => `<link rel="stylesheet" href="${uri(f)}">`).join('');
    const js = ['shell.js', 'dashboard.js', 'agents.js', 'checkpoints.js'].filter(has).map((f) => `<script nonce="${nonce}" src="${uri(f)}"></script>`).join('');
    view.webview.html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src ${view.webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">${css}</head>
<body><div id="tabs" role="tablist" aria-label="Claude Control Center"></div><div id="root" aria-live="polite"></div>${js}</body></html>`;
    view.webview.onDidReceiveMessage((m) => { void this.onMessage(m); });
    view.onDidChangeVisibility(() => { if (view.visible) this.render(true); });
    view.onDidDispose(() => { this.view = undefined; });
  }

  private async onMessage(m: unknown): Promise<void> {
    const r = routeOf(m);
    try {
      if (r === 'shell') {
        const s = parseShellMsg(m);
        if (s?.type === 'ready') { this.dash.reset(); this.sendShell(); this.render(true); }
        else if (s?.type === 'select') { await this.select(s.id); }
      } else if (r && DASH_TABS.has(r)) await this.dash.handle(m);
      else if (r === 'agents') await this.agents.handle(m);
      else if (r === 'checkpoints') await this.checkpoints.handle(m);
    } catch (e) {
      void vscode.window.showErrorMessage(`Claude Control Center: ${e instanceof Error ? e.message : 'action failed'}`);
    }
  }

  async select(id: TabId): Promise<void> {
    this.active = id;
    await this.context.globalState.update(TAB_KEY, id);
    this.render(true);
  }

  /** Reveals the sidebar on a tab (status bar links, commands). */
  async reveal(id: TabId): Promise<void> {
    await this.select(id);
    this.post('shell', { type: 'show', id: this.activeTab });
    await vscode.commands.executeCommand(`${ShellProvider.viewId}.focus`);
  }

  post(tab: string, msg: unknown): void {
    if (!this.view) return;
    void this.view.webview.postMessage({ ...(msg && typeof msg === 'object' ? msg : {}), tab });
  }

  private sendShell(): void {
    this.post('shell', { type: 'init', active: this.activeTab, badges: { changes: this.dash.changeCount(), agents: this.runningAgents() } });
  }

  /** Throttled push: badges plus the state of the visible tab only. */
  render(force = false): void {
    if (!this.view?.visible) return;
    const wait = this.lastPost + MIN_POST_MS - Date.now();
    if (wait > 0 && !force) { this.timer ??= setTimeout(() => { this.timer = undefined; this.render(); }, wait); return; }
    this.lastPost = Date.now();
    this.sendShell();
    const t = this.activeTab;
    if (DASH_TABS.has(t)) this.post(t, { type: 'state', state: this.dash.state(t) });
    else if (t === 'agents') this.post('agents', { type: 'state', state: this.agents.state() });
    else if (t === 'checkpoints') { this.post('checkpoints', { type: 'state', state: this.checkpoints.state() }); void this.checkpoints.refresh(); }
  }

  dispose(): void { if (this.timer) clearTimeout(this.timer); }
}
