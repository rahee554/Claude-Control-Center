import * as vscode from 'vscode';
import { CccEvent } from '../models/events';
import { DEFAULT_EXCLUDE, DiffEntry, ID_RE, Manifest, resolveRel, Trigger } from './logic';
import { CheckpointStore, Limits } from './store';

export const SCHEME = 'ccc-checkpoint';
const DEBOUNCE_MS = 30_000;
const STALE_MS = 60_000;

interface Item { id: string; name: string; createdAt: string; trigger: Trigger; fileCount: number; size: number; changed?: number }
type Msg = { type: string; id?: unknown; path?: unknown };

/** Checkpoints tab controller: thin vscode glue over CheckpointStore. */
export class CheckpointController implements vscode.TextDocumentContentProvider {
  post: (m: unknown) => void = () => undefined;
  private items: Item[] = [];
  private busy = false;
  private lastAuto = 0;
  private changedAt = new Map<string, number>();
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  private get root(): string | undefined { return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath; }
  private store(): CheckpointStore | undefined { const r = this.root; return r ? new CheckpointStore(r) : undefined; }
  private cfg() { return vscode.workspace.getConfiguration('ccc.checkpoints'); }
  private limits(): Limits {
    const c = this.cfg();
    const ex = c.get<unknown>('exclude', DEFAULT_EXCLUDE);
    return {
      exclude: Array.isArray(ex) ? ex.filter((x): x is string => typeof x === 'string').slice(0, 200) : DEFAULT_EXCLUDE,
      maxFileBytes: Math.max(1, c.get<number>('maxFileKB', 2048)) * 1024,
      maxTotalBytes: Math.max(1, c.get<number>('maxTotalMB', 200)) * 1048576
    };
  }

  register(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      vscode.workspace.registerTextDocumentContentProvider(SCHEME, this),
      vscode.commands.registerCommand('ccc.checkpoint.create', () => this.create()),
      vscode.commands.registerCommand('ccc.checkpoint.restore', async () => {
        const list = await this.store()?.list() ?? [];
        if (!list.length) { void vscode.window.showInformationMessage('No checkpoints yet.'); return; }
        const pick = await vscode.window.showQuickPick(list.map((m) => ({ label: m.name, description: `${new Date(m.createdAt).toLocaleString()} - ${m.files.length} files`, id: m.id })), { placeHolder: 'Restore which checkpoint?' });
        if (pick) await this.restoreAll(pick.id);
      }));
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const [, id, ...rest] = uri.path.split('/');
    const st = this.store();
    const m = st && ID_RE.test(id ?? '') ? await st.get(id) : undefined;
    const f = m?.files.find((x) => x.path === rest.join('/'));
    const buf = f && st ? await st.readBlob(f.sha) : undefined;
    return buf ? buf.toString('utf8') : '';
  }

  /** Auto checkpoint on UserPromptSubmit (debounced, off by default). */
  onEvents(evs: CccEvent[]): void {
    if (!this.cfg().get<boolean>('autoOnPrompt', false) || !this.root) return;
    const e = evs.find((x) => x.event === 'UserPromptSubmit' && (!x.cwd || x.cwd.toLowerCase().startsWith(this.root!.toLowerCase())));
    if (!e || Date.now() - this.lastAuto < DEBOUNCE_MS) return;
    this.lastAuto = Date.now();
    const showText = vscode.workspace.getConfiguration('ccc.timeline').get<boolean>('showText', true);
    const name = showText && e.summary ? e.summary.replace(/\s+/g, ' ').trim().slice(0, 60) : 'Before prompt';
    void this.make(name || 'Before prompt', 'auto-prompt', e.sessionId, false).catch(() => undefined);
  }

  private async make(name: string, trigger: Trigger, sessionId: string | undefined, progress: boolean): Promise<Manifest | undefined> {
    const st = this.store();
    if (!st || this.busy) return undefined;
    this.busy = true; this.push();
    try {
      const run = () => st.create(name, trigger, this.limits(), sessionId);
      const m = progress ? await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Creating checkpoint...' }, run) : await run();
      await st.prune(this.cfg().get<number>('keep', 50));
      return m;
    } finally { this.busy = false; await this.refresh(); }
  }

  async create(): Promise<void> {
    if (!this.root) { void vscode.window.showWarningMessage('Open a folder to create checkpoints.'); return; }
    const name = await vscode.window.showInputBox({ prompt: 'Checkpoint name', value: new Date().toLocaleString(), validateInput: (v) => (v.trim() ? undefined : 'Name required') });
    if (!name) return;
    try { await this.make(name.trim(), 'manual', undefined, true); } catch (e) { void vscode.window.showErrorMessage(`Checkpoint failed: ${e instanceof Error ? e.message : 'error'}`); }
  }

  async restoreAll(id: string): Promise<void> {
    const st = this.store(); const m = st && await st.get(id);
    if (!st || !m) return;
    const diff = await st.changedSince(m, this.limits());
    const added = diff.filter((d) => d.kind === 'added').length;
    const modified = diff.filter((d) => d.kind === 'modified').length;
    const deleted = diff.filter((d) => d.kind === 'deleted').length;
    if (!diff.length) { void vscode.window.showInformationMessage('Workspace already matches this checkpoint.'); return; }
    const detail = `Will restore ${modified} modified and ${deleted} deleted file(s). ${added} file(s) were added since; they are kept unless you choose to delete them. A "before-restore" checkpoint is created first.`;
    const btns = added ? ['Restore', `Restore and delete ${added} new file(s)`] : ['Restore'];
    const ans = await vscode.window.showWarningMessage(`Restore checkpoint "${m.name}"?`, { modal: true, detail }, ...btns);
    if (!ans) return;
    try {
      await this.make(`Before restore of ${m.name}`.slice(0, 120), 'before-restore', undefined, true);
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Restoring checkpoint...' }, async () => {
        for (const d of diff) {
          if (d.kind === 'added') { if (ans !== 'Restore') await st.deleteWorkspaceFile(d.path); } else await st.restoreFile(m, d.path);
        }
      });
      void vscode.window.showInformationMessage(`Restored "${m.name}".`);
    } catch (e) { void vscode.window.showErrorMessage(`Restore failed: ${e instanceof Error ? e.message : 'error'}`); }
    await this.refresh();
  }

  async handle(raw: unknown): Promise<void> {
    if (!raw || typeof raw !== 'object') return;
    const m = raw as Msg;
    const id = typeof m.id === 'string' && ID_RE.test(m.id) ? m.id : undefined;
    const rel = typeof m.path === 'string' ? m.path : undefined;
    const st = this.store();
    switch (m.type) {
      case 'ready': case 'refresh': await this.refresh(true); break;
      case 'create': await this.create(); break;
      case 'restoreAll': if (id) await this.restoreAll(id); break;
      case 'delete': {
        if (!id || !st) break;
        const ok = await vscode.window.showWarningMessage('Delete this checkpoint?', { modal: true }, 'Delete');
        if (ok) { await st.remove(id); await this.refresh(); }
        break;
      }
      case 'expand': {
        const mf = id && st ? await st.get(id) : undefined;
        if (mf && st) this.post({ type: 'detail', id, changes: await st.changedSince(mf, this.limits()) satisfies DiffEntry[] });
        break;
      }
      case 'diff': case 'restoreFile': {
        const mf = id && st ? await st.get(id) : undefined;
        const root = this.root;
        if (!mf || !st || !root || !rel || !resolveRel(root, rel)) break;
        const abs = vscode.Uri.file(resolveRel(root, rel)!);
        if (m.type === 'restoreFile') {
          const ok = await vscode.window.showWarningMessage(`Restore ${rel} from "${mf.name}"?`, { modal: true }, 'Restore');
          if (ok && await st.restoreFile(mf, rel)) void vscode.window.showInformationMessage(`Restored ${rel}.`);
          else if (ok) void vscode.window.showWarningMessage(`${rel} is not in this checkpoint.`);
          break;
        }
        if (!mf.files.some((f) => f.path === rel)) { void vscode.window.showInformationMessage('File did not exist in this checkpoint.'); break; }
        const left = vscode.Uri.from({ scheme: SCHEME, path: `/${mf.id}/${rel}` });
        await vscode.commands.executeCommand('vscode.diff', left, abs, `${rel} (checkpoint "${mf.name}" vs workspace)`);
        break;
      }
    }
  }

  state(): unknown { return { items: this.items, busy: this.busy, noWorkspace: !this.root }; }
  private push(): void { this.post({ type: 'state', state: this.state() }); }

  /** Reloads the list; "changed since" counts are cached for a minute unless forced. */
  async refresh(force = false): Promise<void> {
    const st = this.store();
    if (!st) { this.items = []; this.push(); return; }
    const list = await st.list();
    const prev = new Map(this.items.map((i) => [i.id, i]));
    this.items = list.map((m) => ({ id: m.id, name: m.name, createdAt: m.createdAt, trigger: m.trigger, fileCount: m.files.length, size: m.files.reduce((s, f) => s + f.size, 0), changed: prev.get(m.id)?.changed }));
    this.push();
    if (this.busy) return;
    const lim = this.limits();
    // ponytail: one tree scan per stale item, newest 10 only; share one scan if lists get long
    for (const m of list.slice(0, 10)) {
      if (!force && Date.now() - (this.changedAt.get(m.id) ?? 0) < STALE_MS) continue;
      const it = this.items.find((i) => i.id === m.id);
      if (!it) continue;
      it.changed = (await st.changedSince(m, lim)).length;
      this.changedAt.set(m.id, Date.now());
      this.push();
    }
  }
}
