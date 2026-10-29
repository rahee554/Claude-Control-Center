import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Emitter } from '../util/emitter';
import { cccBaseline } from '../services/fileHistory';
import { isNoiseCwd } from '../util/noiseSessions';

export const DEFAULT_PROJECTS_ROOT = path.join(os.homedir(), '.claude', 'projects');
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const MAX_EDITS = 500;
const MAX_LINE = 2 * 1024 * 1024;
const MAX_CHANGES = 300;

/** A file Claude changed in this session, aggregated per path (Copilot-style "changed files"). */
export interface FileChange {
  path: string;
  /** Earliest file-history backup name for this path; null = file was created by Claude; undefined = unknown. */
  baseline?: string | null;
  added: number;
  removed: number;
  lastTs: string;
  agentId?: string;
}

export interface FileEdit {
  path: string;
  tool: string;
  ts: string;
  sessionId: string;
  agentId?: string;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export interface TranscriptStats {
  sessionId: string;
  transcriptPath: string;
  model?: string;
  usage: UsageTotals;
  /** input + cache_read + cache_creation of the latest assistant message. */
  contextTokens: number;
  edits: FileEdit[];
  /** Per-path change aggregation, insertion ordered, bounded. */
  changes: Map<string, FileChange>;
  /** Session cwd (from regular lines); file-history-delta trackingPath is relative to it. */
  cwd?: string;
  /** From the latest `cost-state` line, when present. */
  costUSD?: number;
  firstTs?: string;
  lastTs?: string;
  /** User-set (`custom-title`) / AI (`ai-title`) session title, and the first raw user prompt (clipped). */
  customTitle?: string;
  aiTitle?: string;
  firstPrompt?: string;
  /** Name of the latest main-thread tool_use and whether its result arrived. */
  lastTool?: { name: string; ts: string; done: boolean };
  malformedLines: number;
  updatedAt: number;
}

export function emptyStats(sessionId: string, transcriptPath: string): TranscriptStats {
  return {
    sessionId, transcriptPath, contextTokens: 0, edits: [], changes: new Map(), malformedLines: 0, updatedAt: 0,
    usage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }
  };
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
}

/** Counts +added/-removed lines of an Edit/Write `structuredPatch` (hunk lines prefixed '+', '-', ' '). */
export function countPatch(patch: unknown): { added: number; removed: number } {
  let added = 0, removed = 0;
  if (!Array.isArray(patch)) return { added, removed };
  for (const h of patch) {
    const lines = h && typeof h === 'object' ? (h as { lines?: unknown }).lines : undefined;
    if (!Array.isArray(lines)) continue;
    for (const l of lines) {
      if (typeof l !== 'string') continue;
      if (l.startsWith('+')) added++;
      else if (l.startsWith('-')) removed++;
    }
  }
  return { added, removed };
}

function changeFor(stats: TranscriptStats, p: string, ts: string): FileChange {
  const key = p.slice(0, 1024);
  let c = stats.changes.get(key);
  if (!c) {
    c = { path: key, added: 0, removed: 0, lastTs: ts };
    stats.changes.set(key, c);
    if (stats.changes.size > MAX_CHANGES) stats.changes.delete(stats.changes.keys().next().value as string);
  }
  c.lastTs = ts;
  return c;
}

function applyMeta(stats: TranscriptStats, o: Record<string, unknown>, ts: string): void {
  if (o.type === 'custom-title' && typeof o.customTitle === 'string' && o.customTitle.trim()) stats.customTitle = o.customTitle.slice(0, 200);
  if (o.type === 'ai-title' && typeof o.aiTitle === 'string' && o.aiTitle.trim()) stats.aiTitle = o.aiTitle.slice(0, 200);
  if (o.type === 'user' && !stats.firstPrompt && o.isMeta !== true && o.isSidechain !== true) {
    const c = (o.message as Record<string, unknown> | undefined)?.content;
    if (typeof c === 'string' && c.trim()) stats.firstPrompt = c.slice(0, 600);
  }
  if (o.type === 'cost-state' && typeof o.totalCostUSD === 'number' && Number.isFinite(o.totalCostUSD)) stats.costUSD = o.totalCostUSD;
  if (o.type === 'file-history-delta' && typeof o.trackingPath === 'string') {
    const b = o.backup as Record<string, unknown> | undefined;
    if (!b || typeof b !== 'object') return;
    const name = b.backupFileName;
    if (name !== null && typeof name !== 'string') return;
    // trackingPath is relative to the session cwd; resolve it so it merges with toolUseResult.filePath (absolute).
    const abs = !path.isAbsolute(o.trackingPath) && stats.cwd ? path.resolve(stats.cwd, o.trackingPath) : o.trackingPath;
    const c = changeFor(stats, abs, ts);
    if (c.baseline === undefined) c.baseline = name; // earliest version seen wins
  }
  if (o.type === 'user' && o.toolUseResult && typeof o.toolUseResult === 'object' && o.isSidechain !== true) {
    if (stats.lastTool) stats.lastTool.done = true;
    const r = o.toolUseResult as Record<string, unknown>;
    if (typeof r.filePath !== 'string' || !Array.isArray(r.structuredPatch)) return;
    const counted = countPatch(r.structuredPatch);
    const removed = counted.removed;
    let added = counted.added;
    if (r.type === 'create' && !r.structuredPatch.length && typeof r.content === 'string') added = r.content.split('\n').length;
    const c = changeFor(stats, r.filePath, ts);
    c.added += added;
    c.removed += removed;
  }
}

/**
 * Applies one transcript JSONL line to stats. `seenMessages` dedupes usage: Claude Code writes one line
 * per content block, each repeating the same message.id + usage. Returns false for malformed lines.
 */
export function applyTranscriptLine(stats: TranscriptStats, line: string, seenMessages: Set<string>): boolean {
  if (!line.trim()) return true;
  if (line.length > MAX_LINE) { stats.malformedLines++; return false; }
  let o: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(line);
    if (!parsed || typeof parsed !== 'object') throw new Error('not object');
    o = parsed as Record<string, unknown>;
  } catch { stats.malformedLines++; return false; }
  const msg = o.message as Record<string, unknown> | undefined;
  const ts = typeof o.timestamp === 'string' ? o.timestamp : new Date().toISOString();
  if (typeof o.timestamp === 'string') { stats.firstTs ??= o.timestamp; stats.lastTs = o.timestamp; }
  if (typeof o.cwd === 'string' && !stats.cwd) stats.cwd = o.cwd.slice(0, 1024);
  applyMeta(stats, o, ts);
  if (o.type !== 'assistant' || !msg || typeof msg !== 'object') return true;
  const agentId = o.isSidechain === true && typeof o.agentId === 'string' ? o.agentId : undefined;
  if (typeof msg.model === 'string' && !msg.model.startsWith('<')) stats.model = msg.model.slice(0, 100);
  const usage = msg.usage as Record<string, unknown> | undefined;
  const id = typeof msg.id === 'string' ? msg.id : undefined;
  if (usage && typeof usage === 'object' && (!id || !seenMessages.has(id))) {
    if (id) seenMessages.add(id);
    const input = num(usage.input_tokens), cr = num(usage.cache_read_input_tokens), cc = num(usage.cache_creation_input_tokens);
    stats.usage.inputTokens += input;
    stats.usage.outputTokens += num(usage.output_tokens);
    stats.usage.cacheReadInputTokens += cr;
    stats.usage.cacheCreationInputTokens += cc;
    if (!agentId) stats.contextTokens = input + cr + cc;
  }
  if (Array.isArray(msg.content)) {
    for (const block of msg.content as unknown[]) {
      if (!block || typeof block !== 'object') continue;
      const b = block as Record<string, unknown>;
      if (b.type === 'tool_use' && typeof b.name === 'string' && !agentId) stats.lastTool = { name: b.name.slice(0, 100), ts, done: false };
      if (b.type !== 'tool_use' || typeof b.name !== 'string' || !EDIT_TOOLS.has(b.name)) continue;
      const input = b.input as Record<string, unknown> | undefined;
      const p = input && (typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : undefined);
      if (!p) continue;
      stats.edits.push({ path: p.slice(0, 1024), tool: b.name, ts, sessionId: stats.sessionId, ...(agentId ? { agentId } : {}) });
      if (stats.edits.length > MAX_EDITS) stats.edits.splice(0, stats.edits.length - MAX_EDITS);
    }
  }
  return true;
}

function lines(s: unknown): string[] { return typeof s === 'string' && s ? s.split('\n') : []; }
/** +/− for one replacement, trimming common leading/trailing lines (approximates a diff). */
function replaceCount(oldS: unknown, newS: unknown): { added: number; removed: number } {
  const a = lines(oldS), b = lines(newS);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  let j = 0;
  while (j < a.length - i && j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
  return { added: b.length - i - j, removed: a.length - i - j };
}

/**
 * Estimated +/− of an edit tool call from its input. Subagent transcripts carry no toolUseResult
 * (no structuredPatch), so this is the only source there. Write counts content lines as added.
 */
export function estimateEdit(name: string, input: unknown): { path: string; added: number; removed: number } | undefined {
  const i = input && typeof input === 'object' ? input as Record<string, unknown> : undefined;
  const p = i && (typeof i.file_path === 'string' ? i.file_path : typeof i.notebook_path === 'string' ? i.notebook_path : undefined);
  if (!i || !p || !EDIT_TOOLS.has(name)) return undefined;
  if (name === 'Write') return { path: p, added: lines(i.content).length, removed: 0 };
  if (name === 'MultiEdit' && Array.isArray(i.edits)) {
    let added = 0, removed = 0;
    for (const e of i.edits) { const c = replaceCount((e as Record<string, unknown>)?.old_string, (e as Record<string, unknown>)?.new_string); added += c.added; removed += c.removed; }
    return { path: p, added, removed };
  }
  if (name === 'NotebookEdit') return { path: p, ...replaceCount('', i.new_source) };
  return { path: p, ...replaceCount(i.old_string, i.new_string) };
}

interface SubTail { offset: number; agentId: string; pending: Map<string, { path: string; added: number; removed: number; tool: string }> }

/** Applies one subagent transcript line: successful edit tool calls become changes of the parent session. */
export function applySubagentLine(stats: TranscriptStats, line: string, sub: SubTail, baselineOf: (p: string) => string | null | undefined): boolean {
  if (!line.trim() || line.length > MAX_LINE) return false;
  let o: Record<string, unknown>;
  try { o = JSON.parse(line) as Record<string, unknown>; } catch { return false; }
  const msg = o?.message as Record<string, unknown> | undefined;
  if (!msg || typeof msg !== 'object' || !Array.isArray(msg.content)) return false;
  const ts = typeof o.timestamp === 'string' ? o.timestamp : new Date().toISOString();
  let changed = false;
  for (const block of msg.content as unknown[]) {
    const b = block as Record<string, unknown>;
    if (!b || typeof b !== 'object') continue;
    if (o.type === 'assistant' && b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') {
      const e = estimateEdit(b.name, b.input);
      if (e && sub.pending.size < 500) sub.pending.set(b.id, { ...e, tool: b.name });
    }
    if (o.type === 'user' && b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
      const e = sub.pending.get(b.tool_use_id);
      sub.pending.delete(b.tool_use_id);
      if (!e || b.is_error === true) continue;
      const c = changeFor(stats, e.path, ts);
      c.added += e.added; c.removed += e.removed; c.agentId = sub.agentId;
      if (c.baseline === undefined) { const bl = baselineOf(c.path); if (bl !== undefined) c.baseline = bl; }
      stats.edits.push({ path: c.path, tool: e.tool, ts, sessionId: stats.sessionId, agentId: sub.agentId });
      if (stats.edits.length > MAX_EDITS) stats.edits.splice(0, stats.edits.length - MAX_EDITS);
      changed = true;
    }
  }
  return changed;
}

let extraRoots: string[] = [];
/** Additional allowed roots: each account's `<CLAUDE_CONFIG_DIR>/projects` (delegated sessions). */
export function setExtraTranscriptRoots(roots: string[]): void { extraRoots = roots.slice(0, 50); }

/** True only for existing .jsonl files that really live under the projects root or an account's projects dir (symlinks resolved). */
export function isAllowedTranscript(p: string, root: string = DEFAULT_PROJECTS_ROOT): boolean {
  if (!p.endsWith('.jsonl')) return false;
  let real: string;
  try { real = fs.realpathSync(p); } catch { return false; }
  return [root, ...extraRoots].some((r) => {
    try {
      const rel = path.relative(fs.realpathSync(r), real);
      return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
    } catch { return false; }
  });
}

interface Tracked { stats: TranscriptStats; offset: number; seen: Set<string>; watcher?: fs.FSWatcher; subWatcher?: fs.FSWatcher; debounce?: NodeJS.Timeout; subs: Map<string, SubTail> }

export class TranscriptCollector {
  private readonly tracked = new Map<string, Tracked>();
  private readonly _onDidUpdate = new Emitter<TranscriptStats>();
  /** Fired with the session's updated stats whenever new transcript lines were applied. */
  readonly onDidUpdate = this._onDidUpdate.event;

  constructor(private readonly root: string = DEFAULT_PROJECTS_ROOT, private readonly maxChunk = 4 * 1024 * 1024) {}

  /** Start tailing a transcript for a session. Paths outside the projects root are ignored. */
  track(sessionId: string, transcriptPath: string): boolean {
    const cur = this.tracked.get(sessionId);
    if (cur && cur.stats.transcriptPath === transcriptPath) return true;
    if (!isAllowedTranscript(transcriptPath, this.root)) return false;
    if (cur) this.unwatch(cur);
    const t: Tracked = { stats: emptyStats(sessionId, transcriptPath), offset: 0, seen: new Set(), subs: new Map() };
    this.tracked.set(sessionId, t);
    // Event-driven tailing: re-read ~150ms after the file changes (poll stays as fallback).
    try { t.watcher = fs.watch(transcriptPath, () => { if (t.debounce) return; t.debounce = setTimeout(() => { t.debounce = undefined; this.pollOne(sessionId); }, 150); }); t.watcher.on('error', () => this.unwatch(t)); } catch { /* polling only */ }
    this.pollOne(sessionId);
    return true;
  }

  untrack(sessionId: string): void { const t = this.tracked.get(sessionId); if (t) this.unwatch(t); this.tracked.delete(sessionId); }

  private unwatch(t: Tracked): void { try { t.watcher?.close(); t.subWatcher?.close(); } catch { /* ignore */ } t.watcher = undefined; t.subWatcher = undefined; if (t.debounce) clearTimeout(t.debounce); t.debounce = undefined; }

  /** Re-tail one session now (e.g. right after a PostToolUse edit hook). */
  pollSession(sessionId: string): void { this.pollOne(sessionId); }

  getStats(sessionId: string): TranscriptStats | undefined { return this.tracked.get(sessionId)?.stats; }

  allStats(): TranscriptStats[] { return [...this.tracked.values()].map((t) => t.stats).filter((s) => !isNoiseCwd(s.cwd)); }

  /** All file edits across tracked sessions, newest last. */
  getFileEdits(sessionId?: string): FileEdit[] {
    const all = sessionId ? (this.getStats(sessionId)?.edits ?? []) : this.allStats().flatMap((s) => s.edits);
    return [...all].sort((a, b) => a.ts.localeCompare(b.ts));
  }

  poll(): void { for (const id of this.tracked.keys()) this.pollOne(id); }

  /** Complete new lines of `file` from `offset` (bounded chunk); undefined when nothing new. */
  private readNew(file: string, offset: number): { lines: string[]; offset: number; reset?: boolean; skipped?: boolean } | undefined {
    let size: number;
    try { size = fs.statSync(file).size; } catch { return undefined; }
    let reset = false;
    if (size < offset) { offset = 0; reset = true; } // rewritten: start over
    if (size === offset) return reset ? { lines: [], offset, reset } : undefined;
    const len = Math.min(size - offset, this.maxChunk);
    const buf = Buffer.alloc(len);
    let fd: number | undefined;
    try { fd = fs.openSync(file, 'r'); fs.readSync(fd, buf, 0, len, offset); } catch { return undefined; } finally { if (fd !== undefined) fs.closeSync(fd); }
    const lastNl = buf.lastIndexOf(0x0a);
    if (lastNl < 0) return len === this.maxChunk ? { lines: [], offset: offset + len, reset, skipped: true } : undefined; // oversized line: skip it
    return { lines: buf.subarray(0, lastNl).toString('utf8').split('\n'), offset: offset + lastNl + 1, reset };
  }

  private pollOne(sessionId: string): void {
    const t = this.tracked.get(sessionId);
    if (!t) return;
    let changed = false;
    const r = this.readNew(t.stats.transcriptPath, t.offset);
    if (r) {
      if (r.reset) { t.seen.clear(); t.subs.clear(); const old = t.stats; t.stats = emptyStats(old.sessionId, old.transcriptPath); }
      if (r.skipped) t.stats.malformedLines++;
      t.offset = r.offset;
      for (const line of r.lines) applyTranscriptLine(t.stats, line, t.seen);
      if (t.seen.size > 50000) t.seen.clear();
      changed = true;
    }
    if (this.pollSubagents(t)) changed = true;
    if (!changed) return;
    t.stats.updatedAt = Date.now();
    this._onDidUpdate.fire(t.stats);
  }

  /** Tails `<session>/subagents/agent-*.jsonl` so subagent edits count as the session's changes. */
  private pollSubagents(t: Tracked): boolean {
    const main = t.stats.transcriptPath;
    const dir = path.join(path.dirname(main), path.basename(main, '.jsonl'), 'subagents');
    let names: string[];
    try { names = fs.readdirSync(dir); } catch { return false; }
    if (!t.subWatcher) {
      try {
        t.subWatcher = fs.watch(dir, () => { if (t.debounce) return; t.debounce = setTimeout(() => { t.debounce = undefined; this.pollOne(t.stats.sessionId); }, 150); });
        t.subWatcher.on('error', () => { try { t.subWatcher?.close(); } catch { /* ignore */ } t.subWatcher = undefined; });
      } catch { /* polling only */ }
    }
    let changed = false;
    for (const nm of names.slice(-200)) {
      const id = /^agent-([\w-]{1,128})\.jsonl$/.exec(nm)?.[1];
      if (!id) continue;
      const file = path.join(dir, nm);
      if (!isAllowedTranscript(file, this.root)) continue;
      let s = t.subs.get(file);
      if (!s) { s = { offset: 0, agentId: id, pending: new Map() }; t.subs.set(file, s); }
      // Drain the whole file (bounded chunks) so long-running subagents catch up in one poll.
      for (let i = 0; i < 64; i++) {
        const r = this.readNew(file, s.offset);
        if (!r) break;
        if (r.reset) s.pending.clear();
        s.offset = r.offset;
        for (const line of r.lines) if (applySubagentLine(t.stats, line, s, (p) => cccBaseline(t.stats.sessionId, p))) changed = true;
      }
    }
    return changed;
  }
  dispose(): void { for (const t of this.tracked.values()) this.unwatch(t); this._onDidUpdate.dispose(); this.tracked.clear(); }
}
