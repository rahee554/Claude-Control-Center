import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { registerAccounts } from './accounts/accounts';
import { ProcessAdapter } from './adapters/processAdapter';
import { HookCollector } from './collectors/hookCollector';
import { isAllowedTranscript, TranscriptCollector } from './collectors/transcriptCollector';
import { AgentNode, AgentsTreeProvider } from './providers/agentsTreeProvider';
import { TerminalsTreeProvider } from './providers/terminalsTreeProvider';
import { AgentInfo, AgentService } from './services/agentService';
import { MirrorService } from './services/mirrorService';
import { hookCommand, mergeHooks, staleHookCommands, readSettings, statusLineCommand, unwrapStatusLine, wrapStatusLine, writeSettingsAtomic } from './services/hookSettings';
import { CCC_HOME, limitView, UsageService } from './services/usageService';
import { mcpRegistered, invalidateMcp } from './services/mcpStatus';
import { CARD_TOGGLES } from './views/statusCard';
import { runUsageCli } from './services/usageCli';
import { TerminalInfo, TerminalService } from './services/terminalService';
import { watchRequests } from './services/modBridge';
import { BASELINE_SCHEME, BaselineContentProvider, DashboardProvider } from './views/dashboardProvider';
import { AgentsViewProvider } from './views/agentsViewProvider';
import { ShellProvider } from './views/shellProvider';
import { familyOf, Timelines } from './views/timeline';
import { contextWindowFor, hookConfigJson } from './views/dashboardState';
import { ALLOWED_COMMANDS, buildCard, CARD_COMMANDS, CardInput, statusText } from './views/statusCard';
import { isLive } from './services/agentState';
import { Alert, AlertFlags, AttentionDecider } from './services/attention';

export const OWNER_TAG = 'claude-control-center';

export interface CccApi {
  agents: AgentService;
  terminals: TerminalService;
  transcripts: TranscriptCollector;
  usage: UsageService;
}

function cfg() {
  const c = vscode.workspace.getConfiguration('ccc');
  return {
    refreshIntervalMs: Math.min(Math.max(c.get<number>('refreshIntervalSeconds', 5), 1), 300) * 1000,
    staleAfterMs: Math.max(c.get<number>('staleAfterSeconds', 120), 10) * 1000,
    historyLimit: Math.min(Math.max(c.get<number>('historyLimit', 500), 50), 10000),
    recentLimit: Math.min(Math.max(c.get<number>('recentAgentsLimit', 20), 0), 200),
    requireConfirmation: c.get<boolean>('terminate.requireConfirmation', true),
    collectPromptText: c.get<boolean>('collectPromptText', false),
    processCorrelation: c.get<boolean>('processCorrelation.enabled', true),
    mirror: {
      enabled: c.get<boolean>('mirror.enabled', true),
      showOutput: c.get<boolean>('mirror.showOutput', true),
      maxOutputKB: Math.min(Math.max(c.get<number>('mirror.maxOutputKB', 64), 1), 128),
      focus: c.get<string>('mirror.focus', 'never') === 'onCreate' ? 'onCreate' as const : 'never' as const
    }
  };
}

/** Config read by the hook script (tmp + rename so the hook never sees a partial file). */
function writeHookConfig(): void {
  const m = cfg().mirror;
  const file = path.join(CCC_HOME, 'config.json');
  const data = hookConfigJson({ mirror: m.enabled, showOutput: m.showOutput, maxOutputKB: m.maxOutputKB, chatBox: vscode.workspace.getConfiguration('ccc').get<boolean>('chatBox.enabled', true), delegation: vscode.workspace.getConfiguration('ccc').get<boolean>('delegate.enabled', true) });
  try { if (fs.readFileSync(file, 'utf8') === data) return; } catch { /* missing */ }
  fs.mkdirSync(CCC_HOME, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Copies the bundled hook to ~/.claude-control-center/hooks so settings.json survives extension updates. */
function syncHookScript(extensionPath: string): string {
  const src = path.join(extensionPath, 'hooks', 'ccc-hook.js');
  const dst = path.join(CCC_HOME, 'hooks', 'ccc-hook.js');
  const body = fs.readFileSync(src);
  let cur: Buffer | undefined;
  try { cur = fs.readFileSync(dst); } catch { cur = undefined; }
  if (!cur || !cur.equals(body)) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    const tmp = `${dst}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, dst);
  }
  return dst;
}

function agentOf(node: unknown): AgentInfo | undefined {
  const n = node as AgentNode | undefined;
  return n && 'agent' in n ? n.agent : undefined;
}

export function activate(context: vscode.ExtensionContext): CccApi {
  const log = vscode.window.createOutputChannel('Claude Control Center', { log: true });
  const c = cfg();
  const hooks = new HookCollector({ pollMs: c.refreshIntervalMs });
  const transcripts = new TranscriptCollector();
  const agents = new AgentService(hooks, transcripts, c);
  const processes = new ProcessAdapter(() => cfg().processCorrelation);
  const mirror = new MirrorService(agents, () => cfg().mirror);
  const terminals = new TerminalService(agents, processes, OWNER_TAG, (t) => mirror.sessionOf(t));
  try { writeHookConfig(); } catch (e) { log.warn(`could not write hook config: ${e instanceof Error ? e.message : e}`); }
  let hookScript: string | undefined;
  try { hookScript = syncHookScript(context.extensionPath); } catch (e) { log.warn(`could not copy hook script: ${e instanceof Error ? e.message : e}`); }
  const timelines = new Timelines();
  const agentsTree = new AgentsTreeProvider(agents, timelines);
  const agentsWeb = new AgentsViewProvider(agents, timelines);
  context.subscriptions.push({ dispose: () => agentsWeb.dispose() });
  const terminalsTree = new TerminalsTreeProvider(terminals);
  const usage = new UsageService();
  const dashboard = new DashboardProvider(agents, usage, context, () => ({ staleAfterMs: cfg().staleAfterMs }), timelines);
  let acc: ReturnType<typeof registerAccounts> | undefined = undefined; // set once accounts register (end of activate)
  const shell: ShellProvider = new ShellProvider(context, dashboard, agentsWeb, () => agents.snapshot.activeCount);
  shell.checkpoints.register(context);
  context.subscriptions.push(hooks.onEvents((evs) => shell.checkpoints.onEvents(evs)));
  // Account limits via the user's own `claude -p /usage` (subscription plans). 0 disables.
  let limitsTimer: NodeJS.Timeout | undefined;
  const pollLimits = async () => {
    const c = vscode.workspace.getConfiguration('ccc.limits');
    const u = await runUsageCli(c.get<string>('claudePath', 'claude'));
    if (u) { usage.cli = u; shell.render(); updateStatus(); }
    else log.info('claude /usage returned no limits (API-key plan, not logged in, or CLI not found)');
  };
  const scheduleLimits = () => {
    if (limitsTimer) clearInterval(limitsTimer);
    const mins = vscode.workspace.getConfiguration('ccc.limits').get<number>('pollMinutes', 5);
    if (mins > 0) { void pollLimits(); limitsTimer = setInterval(() => void pollLimits(), Math.max(1, mins) * 60_000); }
  };
  scheduleLimits();
  context.subscriptions.push({ dispose: () => limitsTimer && clearInterval(limitsTimer) },
    vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('ccc.limits')) scheduleLimits(); }),
    vscode.commands.registerCommand('ccc.refreshLimits', pollLimits));

  const terminalsView = vscode.window.createTreeView('ccc.terminals', { treeDataProvider: terminalsTree });
  // Copilot-style item: Claude glyph + 5h % (or running agents), rich hover card built by statusCard.ts.
  const status = vscode.window.createStatusBarItem('ccc.status', vscode.StatusBarAlignment.Right, 100);
  status.name = 'Claude Code';
  status.command = 'ccc.statusMenu';
  let lastTip = '';
  const cardInput = (): CardInput => {
    const s = agents.snapshot;
    const now = Date.now();
    const cap = usage.latest();
    const lim = (w: 'fiveHour' | 'sevenDay') => {
      const v = limitView(cap, w);
      if (v.available) return { l: { pct: v.usedPercentage, resetsAt: v.resetsAt }, at: v.capturedAt, src: 'status line' };
      const c = usage.cli?.[w];
      return c ? { l: { pct: c.usedPercentage, resetsAt: c.resetsAt }, at: usage.cli!.ts, src: 'claude /usage' } : undefined;
    };
    const five = lim('fiveHour'), week = lim('sevenDay');
    const live = s.sessions.filter(isLive);
    const main = [...live].sort((a, b) => b.lastActivity - a.lastActivity)[0] ?? [...s.sessions].sort((a, b) => b.lastActivity - a.lastActivity)[0];
    const st = main ? agents.getTranscriptStats(main.sessionId) : undefined;
    const models = { opus: 0, sonnet: 0, haiku: 0 };
    const bump = (m?: string) => { const f = m ? familyOf(m) : 'other'; if (f !== 'other') models[f]++; };
    let tool = main?.currentTool;
    for (const se of live) {
      bump(agents.getTranscriptStats(se.sessionId)?.model);
      const file = se.transcriptPath ?? agents.getTranscriptStats(se.sessionId)?.transcriptPath;
      for (const sub of se.subagents.filter(isLive)) {
        bump(file ? timelines.agentDetails(file, sub.id)?.model : undefined);
        tool ??= sub.currentTool;
      }
    }
    const file = main && (main.transcriptPath ?? st?.transcriptPath);
    const changes = st ? [...st.changes.values()] : [];
    const window = cap?.contextWindowSize ?? (st && st.contextTokens > 200_000 ? 1_000_000 : contextWindowFor(st?.model));
    const ctxPct = cap && cap.sessionId === main?.sessionId && cap.contextUsedPercentage !== undefined ? cap.contextUsedPercentage : st && st.contextTokens ? (st.contextTokens / window) * 100 : undefined;
    const ai = acc?.info();
    const at = five?.at ?? week?.at;
    return {
      now, account: ai?.main, fiveHour: five?.l, sevenDay: week?.l, limitsAt: at, limitsSource: five?.src ?? week?.src,
      subs: ai?.enabled ? ai.subs : undefined,
      context: ctxPct !== undefined ? { pct: ctxPct, tokens: st?.contextTokens ?? 0 } : undefined,
      active: s.activeCount, models, currentTool: tool, tasks: ai?.runningTasks ?? 0,
      messages: file && isAllowedTranscript(file) ? timelines.get(file).turns.length : undefined,
      files: changes.length ? { count: changes.length, added: changes.reduce((n, c) => n + c.added, 0), removed: changes.reduce((n, c) => n + c.removed, 0) } : undefined,
      paused: agents.isPaused,
      features: (() => { const t = dashboard.toggleState(); return [['monitoring', 'Monitoring', t.monitoring], ['mirror', 'Terminal mirror', t.mirror], ['chatBox', 'Chat changes box', t.chatBox], ['delegation', 'Delegation', t.delegation], ['limits', 'Limits polling', t.limits]].map(([key, label, on]) => ({ key: key as string, label: label as string, on: on as boolean })); })(),
      mcp: mcpRegistered(vscode.workspace.getConfiguration('ccc.limits').get<string>('claudePath', 'claude'))
    };
  };
  const renderStatus = () => {
    const i = cardInput();
    status.text = statusText(i) + (agents.isStale || agents.snapshot.staleCount > 0 ? ' $(warning)' : '');
    const md = buildCard(i);
    if (md !== lastTip) {
      lastTip = md;
      const t = new vscode.MarkdownString(md, true);
      t.isTrusted = { enabledCommands: ALLOWED_COMMANDS };
      status.tooltip = t;
    }
    if (vscode.workspace.getConfiguration('ccc').get<boolean>('statusBar.enabled', true)) status.show(); else status.hide();
  };
  // Throttle: at most one rebuild per second; bursts of events coalesce into the trailing call.
  let statusTimer: NodeJS.Timeout | undefined;
  let lastRender = 0;
  const updateStatus = () => {
    if (statusTimer) return;
    const wait = Math.max(0, 1000 - (Date.now() - lastRender));
    statusTimer = setTimeout(() => { statusTimer = undefined; lastRender = Date.now(); renderStatus(); }, wait);
  };
  context.subscriptions.push({ dispose: () => statusTimer && clearTimeout(statusTimer) });

  context.subscriptions.push(
    log, terminalsView, { dispose: () => { shell.dispose(); } }, status, terminals, mirror,
    mirror.onDidChange(() => void terminals.reclassify()), agentsTree, terminalsTree,
    { dispose: () => { agents.dispose(); hooks.dispose(); transcripts.dispose(); } },
    vscode.window.registerWebviewViewProvider(ShellProvider.viewId, shell),
    vscode.workspace.registerTextDocumentContentProvider(BASELINE_SCHEME, new BaselineContentProvider()),
    terminals.onDidChange(() => terminalsTree.refresh())
  );
  {
    const stop = watchRequests(() => (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath), (r) => { void dashboard.openDiffFor(r.sessionId, r.path).catch(() => undefined); }, (m) => log.info(m));
    context.subscriptions.push({ dispose: stop });
  }
  const sub1 = agents.onDidChange(() => { agentsTree.refresh(); shell.render(); updateStatus(); });
  const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
  const attention = new AttentionDecider(Date.now());
  const alertCfg = () => vscode.workspace.getConfiguration('ccc.alerts');
  const alertFlags = (): AlertFlags => { const c = alertCfg(); return { enabled: c.get('enabled', true), permission: c.get('permission', true), input: c.get('input', true), tasks: c.get('tasks', true) }; };
  let waitingSession: string | undefined;
  const raise = async (a: Alert) => {
    if (a.kind === 'permission' || a.kind === 'input') { waitingSession = a.sessionId; status.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground'); }
    if (vscode.window.state.focused && !alertCfg().get('whenFocused', false)) return;
    const show = a.kind === 'taskFailed' ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
    const pick = await show(`${a.title}${a.detail ? `: ${a.detail}` : ''}`, 'Focus Claude', 'Dismiss');
    if (pick !== 'Focus Claude') return;
    const cmds = await vscode.commands.getCommands(true);
    await vscode.commands.executeCommand(cmds.includes('claude-vscode.focus') ? 'claude-vscode.focus' : `${ShellProvider.viewId}.focus`);
  };
  const sub2 = agents.onDidReceiveEvents((evs) => {
    log.debug(`received ${evs.length} event(s); malformed so far: ${hooks.malformedLines}`);
    for (const e of evs) {
      if (e.event === 'Notification') { const a = attention.fromEvent(e, alertFlags()); if (a) void raise(a); }
      else if (waitingSession === e.sessionId) { waitingSession = undefined; status.backgroundColor = undefined; }
    }
    // Changes show up as soon as an edit lands: re-tail that session's transcript now instead of waiting for the poll.
    for (const id of new Set(evs.filter((e) => e.event === 'PostToolUse' && e.toolName && EDIT_TOOLS.has(e.toolName)).map((e) => e.sessionId))) transcripts.pollSession(id);
  });
  const sub3 = agents.onDidUpdateTranscript(() => { agentsTree.refresh(); shell.render(); updateStatus(); });
  context.subscriptions.push(sub1, sub2, sub3);

  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (!e.affectsConfiguration('ccc')) return;
    agents.updateOptions(cfg());
    if (e.affectsConfiguration('ccc.mirror') || e.affectsConfiguration('ccc.chatBox') || e.affectsConfiguration('ccc.delegate')) { try { writeHookConfig(); } catch { /* logged on activation */ } }
    void terminals.reclassify();
  }));

  const reg = (id: string, fn: (...args: unknown[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, async (...args: unknown[]) => {
      try { await fn(...args); } catch (e) {
        log.error(`${id} failed: ${e instanceof Error ? e.message : 'unknown error'}`);
        void vscode.window.showErrorMessage(`Claude Control Center: ${e instanceof Error ? e.message : 'command failed'}`);
      }
    }));

  const pickTerminal = async (arg: unknown): Promise<TerminalInfo | undefined> => {
    const t = arg as TerminalInfo | undefined;
    if (t && typeof t === 'object' && 'terminal' in t) return terminals.get(t.id) ?? t;
    const items = terminals.list().map((i) => ({ label: i.name, description: i.ownership, info: i }));
    return (await vscode.window.showQuickPick(items, { placeHolder: 'Select a terminal' }))?.info;
  };

  reg('ccc.exportSession', () => dashboard.exportSession());
  reg('ccc.refresh', async () => { agents.refresh(); await terminals.reclassify(); agentsTree.refresh(); terminalsTree.refresh(); });
  reg('ccc.statusMenu', async () => {
    const items: (vscode.QuickPickItem & { cmd: string; args?: unknown[] })[] = [
      { label: '$(pulse) Open Activity', cmd: CARD_COMMANDS.activity },
      { label: '$(diff) Claude Changes', cmd: CARD_COMMANDS.changes },
      { label: '$(rocket) Delegate task…', cmd: CARD_COMMANDS.delegate },
      { label: '$(refresh) Refresh limits', cmd: CARD_COMMANDS.refresh },
      { label: '$(gear) Settings', cmd: CARD_COMMANDS.settings, args: ['@ext:pfxtoolkit.claude-code-control-center'] },
      agents.isPaused ? { label: '$(debug-start) Resume monitoring', cmd: CARD_COMMANDS.resume } : { label: '$(debug-pause) Pause monitoring', cmd: CARD_COMMANDS.pause }
    ];
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Claude Code' });
    if (pick) await vscode.commands.executeCommand(pick.cmd, ...(pick.args ?? []));
  });
  reg('ccc.toggle', async (key) => {
    if (typeof key !== 'string' || !(CARD_TOGGLES as readonly string[]).includes(key)) return;
    const k = key as (typeof CARD_TOGGLES)[number];
    await dashboard.setToggle(k, !dashboard.toggleState()[k]);
    invalidateMcp(); updateStatus();
  });
  reg('ccc.pauseMonitoring', async () => { agents.setPaused(true); await vscode.commands.executeCommand('setContext', 'ccc.paused', true); updateStatus(); });
  reg('ccc.resumeMonitoring', async () => { agents.setPaused(false); await vscode.commands.executeCommand('setContext', 'ccc.paused', false); updateStatus(); });

  reg('ccc.installHooks', async () => {
    const file = path.join(os.homedir(), '.claude', 'settings.json');
    const command = hookCommand(hookScript ? CCC_HOME : context.extensionPath, cfg().collectPromptText);
    const current = readSettings(file);
    const { settings, changed } = mergeHooks(current, command);
    if (!changed) { void vscode.window.showInformationMessage('Claude Control Center hooks are already installed.'); return; }
    const preview = await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify({ hooks: settings.hooks }, null, 2) });
    await vscode.window.showTextDocument(preview, { preview: true });
    const ok = await vscode.window.showWarningMessage(
      `Merge the shown "hooks" section into ${file}? Existing hooks are kept and a backup is written first.`, { modal: true }, 'Install Hooks');
    if (ok !== 'Install Hooks') return;
    const backup = writeSettingsAtomic(file, settings);
    log.info(`hooks installed${backup ? '; backup written' : ''}`);
    void vscode.window.showInformationMessage(`Hooks installed. ${backup ? `Backup: ${backup}` : ''} Restart running Claude Code sessions to pick them up.`);
  });

  const settingsFile = path.join(os.homedir(), '.claude', 'settings.json');
  const slConfig = path.join(CCC_HOME, 'statusline-config.json');
  reg('ccc.installStatusLine', async () => {
    const current = readSettings(settingsFile);
    const script = path.join(CCC_HOME, 'bin', 'ccc-statusline.js');
    const { settings, original, alreadyWrapped } = wrapStatusLine(current, statusLineCommand(script));
    const origCmd = (original as { command?: unknown } | null)?.command;
    const ok = await vscode.window.showWarningMessage(
      `Install rate-limit capture into ${settingsFile}? Your status line ${alreadyWrapped ? 'is already wrapped; the script will be refreshed' : typeof origCmd === 'string' ? `command "${origCmd.slice(0, 120)}" keeps working (wrapped)` : 'is not set; a short default line will be shown'}. The wrapper saves rate limits, model, context and cost per session to ${path.join(CCC_HOME, 'statusline')}. A backup of settings.json is written first.`,
      { modal: true }, 'Install Status Line');
    if (ok !== 'Install Status Line') return;
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.copyFileSync(path.join(context.extensionPath, 'hooks', 'ccc-statusline.js'), script);
    if (!alreadyWrapped) writeSettingsAtomic(slConfig, { original });
    const backup = writeSettingsAtomic(settingsFile, settings);
    log.info('status line wrapper installed');
    void vscode.window.showInformationMessage(`Status line capture installed.${backup ? ` Backup: ${backup}` : ''}`);
  });
  reg('ccc.uninstallStatusLine', async () => {
    let original: unknown = null;
    try { original = (readSettings(slConfig) as { original?: unknown } | undefined)?.original ?? null; } catch { original = null; }
    const { settings, changed } = unwrapStatusLine(readSettings(settingsFile), original);
    if (!changed) { void vscode.window.showInformationMessage('Status line capture is not installed.'); return; }
    const ok = await vscode.window.showWarningMessage(`Restore your original status line in ${settingsFile}? A backup is written first.`, { modal: true }, 'Restore');
    if (ok !== 'Restore') return;
    const backup = writeSettingsAtomic(settingsFile, settings);
    try { fs.rmSync(slConfig, { force: true }); } catch { /* ignore */ }
    void vscode.window.showInformationMessage(`Original status line restored.${backup ? ` Backup: ${backup}` : ''}`);
  });

  reg('ccc.focusTerminal', async (arg) => {
    const a = agentOf(arg);
    if (a) {
      // Prefer a terminal proven to host the session; otherwise its command mirror.
      const real = terminals.forSession(a.sessionId).find((i) => i.ownership === 'claudeConfirmed' || i.ownership === 'extensionOwned');
      if (real) { terminals.focus(real); return; }
      const m = mirror.terminalFor(a.sessionId);
      if (m) { m.show(false); return; }
      void vscode.window.showInformationMessage('No terminal or command mirror for this session yet.');
      return;
    }
    const t = await pickTerminal(arg);
    if (t) terminals.focus(t);
  });
  reg('ccc.openChanges', () => shell.reveal('changes'));
  reg('ccc.mirror.replaySession', async (arg) => {
    let a: { sessionId: string; cwd?: string } | undefined = agentOf(arg);
    if (!a) {
      const items = agents.snapshot.sessions.map((s) => ({ label: s.sessionId.slice(0, 8), description: s.cwd, s }));
      a = (await vscode.window.showQuickPick(items, { placeHolder: 'Replay recorded commands of session' }))?.s;
    }
    if (a) mirror.replay(a.sessionId, a.cwd);
  });
  reg('ccc.openTerminalInEditor', async (arg) => { const t = await pickTerminal(arg); if (t) await terminals.openInEditor(t); });
  reg('ccc.splitTerminal', async (arg) => { const t = await pickTerminal(arg); if (t) await terminals.split(t); });
  reg('ccc.newTerminal', async (arg) => {
    const a = agentOf(arg);
    terminals.createTerminal(a ? { name: `Claude ${a.sessionId.slice(0, 8)}`, sessionId: a.sessionId, cwd: a.cwd } : {});
  });
  reg('ccc.renameTerminal', async (arg) => {
    const t = await pickTerminal(arg);
    if (!t) return;
    const name = await vscode.window.showInputBox({ prompt: 'New terminal name', value: t.name, validateInput: (v) => v.trim() && v.length <= 100 ? undefined : '1-100 characters' });
    if (name) await terminals.rename(t, name.trim());
  });
  reg('ccc.terminateTerminal', async (arg) => {
    const t = await pickTerminal(arg);
    if (t && await terminals.terminate(t, cfg().requireConfirmation)) log.info(`terminal ${t.id} closed by user`);
  });
  reg('ccc.terminateClaudeGroup', async (arg) => {
    let sessionId = agentOf(arg)?.sessionId;
    const t = arg as TerminalInfo | undefined;
    if (!sessionId && t && 'sessionIds' in t) sessionId = t.sessionIds[0];
    if (!sessionId) return;
    const n = await terminals.terminateGroup(sessionId, cfg().requireConfirmation);
    if (n) log.info(`closed ${n} terminal(s) for a session`);
  });
  reg('ccc.copyId', async (arg) => {
    const a = agentOf(arg);
    const t = arg as TerminalInfo | undefined;
    const id = a?.id ?? (t && 'terminal' in t ? String(t.pid ?? t.id) : undefined);
    if (id) await vscode.env.clipboard.writeText(id);
  });
  reg('ccc.openTranscript', async (arg) => {
    const a = agentOf(arg);
    const p = a ? (a.transcriptPath ?? agents.getTranscriptStats(a.sessionId)?.transcriptPath) : undefined;
    if (!p || !isAllowedTranscript(p)) { void vscode.window.showWarningMessage('No transcript available for this agent.'); return; }
    await vscode.window.showTextDocument(vscode.Uri.file(p), { preview: true });
  });
  reg('ccc.showEventHistory', async (arg) => {
    const a = agentOf(arg);
    const evs = agents.getHistory(a?.sessionId, a?.kind === 'subagent' ? a.id : undefined).slice().reverse();
    await vscode.window.showQuickPick(evs.map((e) => ({
      label: e.event,
      description: [e.toolName, e.agentType, e.filePath].filter(Boolean).join(' · '),
      detail: `${new Date(e.ts).toLocaleTimeString()} · ${e.sessionId.slice(0, 8)}${e.agentId ? ` / ${e.agentId.slice(0, 8)}` : ''}${e.summary ? ` · ${e.summary}` : ''}`
    })), { placeHolder: `${evs.length} event(s)`, matchOnDescription: true, matchOnDetail: true });
  });
  reg('ccc.filter', async () => {
    const v = await vscode.window.showInputBox({ prompt: 'Filter agents by id, type, cwd, tool or status (empty clears)', value: agentsTree.filterText });
    if (v === undefined) return;
    agentsTree.setFilter(v);
  });

  void vscode.commands.executeCommand('setContext', 'ccc.paused', false);
  const syncViewContext = () => void vscode.commands.executeCommand('setContext', 'ccc.showTerminals', vscode.workspace.getConfiguration('ccc').get<boolean>('views.terminals', false));
  syncViewContext();
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('ccc.views.terminals')) syncViewContext(); if (e.affectsConfiguration('ccc.timeline') || e.affectsConfiguration('ccc.models') || e.affectsConfiguration('ccc.accounts')) shell.render(true);
    if (e.affectsConfiguration('ccc.statusBar')) updateStatus(); }));
  agents.start();
  updateStatus();
  log.info(`activated; watching ${hooks.dir}`);
  if (hookScript) {
    try {
      const stale = staleHookCommands(readSettings(settingsFile), hookScript);
      if (stale.length) {
        void vscode.window.showInformationMessage('Claude Code hooks point to an old Control Center path. Update them to the stable copy?', 'Update Hooks')
          .then((c) => { if (c === 'Update Hooks') void vscode.commands.executeCommand('ccc.installHooks'); });
      }
    } catch { /* unreadable settings: leave alone */ }
  }
  const api = { agents, terminals, transcripts, usage };
  acc = registerAccounts(context, api);
  const seenTasks = new Map<string, string>(acc.tasks().map((t) => [t.id, t.state]));
  context.subscriptions.push(acc.onDidChange(() => {
    updateStatus(); shell.render();
    for (const t of acc!.tasks()) {
      const prev = seenTasks.get(t.id);
      seenTasks.set(t.id, t.state);
      if (prev === 'running') { const a = attention.fromTask(t.id, t.state, `Account: ${t.label}`, alertFlags()); if (a) void raise(a); }
    }
  }));
  updateStatus();
  return api;
}

export function deactivate(): void { /* disposables handle cleanup */ }
