import * as fs from 'fs';
import * as path from 'path';
import { estimateEdit } from '../collectors/transcriptCollector';
import { cleanPrompt, TlFile, TlTool, TlTurn } from './timeline';

export interface DetailTool { id?: string; name: string; target?: string; status: string; ms?: number; input?: string; out?: string }
export interface AgentDetail {
  id: string; sessionId: string; title: string; type?: string; model?: string; state: string; stateText: string; since?: number; end?: number; tokens: number;
  promptHead: string; prompt: string;
  tools: DetailTool[];
  files: { path: string; name: string; added: number; removed: number; icon?: string }[];
  result: string; resultMore: boolean; resultFull: string;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);
const MAX_OUT = 20 * 1024;
const MAX_CHUNK = 8 * 1024 * 1024;

/** Removes a leading `cd <path> &&` (quoted or bare) that Claude prepends to shell commands. */
export function stripCd(cmd: string): string {
  return cmd.replace(/^\s*cd\s+(?:\/d\s+)?(?:"[^"]*"|'[^']*'|[^\s&;|]+)\s*&&\s*/, '');
}

/** First command segment before a pipe / `&&` / `;` (so `npm run compile 2>&1 | grep x` -> `npm run compile`). */
export function firstSegment(cmd: string): string {
  const seg = stripCd(cmd).split(/\s*(?:\|\||\||&&|;)\s*/)[0] ?? '';
  return seg.replace(/\s+2>&1\s*$/, '').trim() || cmd;
}

/** One-line row label: Bash → description, else the command without `cd … &&`; other tools → file/pattern/etc. */
export function toolLabel(name: string, input: unknown): string {
  const i = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined);
  const one = (x: string) => clip(x.replace(/\s+/g, ' ').trim(), 160);
  if (typeof i.command === 'string') return one(s(i.description) ?? firstSegment(i.command));
  const f = s(i.file_path) ?? s(i.notebook_path);
  if (f) return path.basename(f);
  const t = s(i.description) ?? s(i.pattern) ?? s(i.url) ?? s(i.query) ?? s(i.path) ?? s(i.prompt);
  return t ? one(t) : name;
}

function fmtInput(input: unknown): string {
  const i = input && typeof input === 'object' ? input as Record<string, unknown> : undefined;
  if (i && typeof i.command === 'string') return clip(stripCd(i.command), 4000);
  try { return clip(JSON.stringify(input, null, 2) ?? '', 4000); } catch { return ''; }
}

function rec(v: unknown): Record<string, unknown> | undefined { return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined; }

/** Incremental (byte-offset) reader of one subagent transcript with tool IN/OUT, files, result and tokens. vscode-free. */
export class SubTail {
  prompt = ''; reply = ''; tokens = 0; model?: string;
  tools: DetailTool[] = [];
  readonly files = new Map<string, { added: number; removed: number }>();
  private offset = 0;
  private skipFirst = false;
  private readonly byId = new Map<string, { t: DetailTool; ts: number }>();
  private readonly est = new Map<string, { path: string; added: number; removed: number }>();
  private readonly seen = new Set<string>();
  constructor(readonly file: string) {}

  /** Reads newly appended complete lines (bounded). True when anything changed. */
  poll(): boolean {
    let size: number;
    try { size = fs.statSync(this.file).size; } catch { return false; }
    if (size < this.offset) { this.reset(); }
    if (size === this.offset) return false;
    let changed = false, fd: number | undefined;
    try {
      fd = fs.openSync(this.file, 'r');
      if (this.offset === 0 && size > MAX_CHUNK) { this.offset = size - MAX_CHUNK; this.skipFirst = true; }
      while (this.offset < size) {
        const len = Math.min(size - this.offset, MAX_CHUNK);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, this.offset);
        const nl = buf.lastIndexOf(0x0a);
        if (nl < 0) { if (len === MAX_CHUNK) { this.offset += len; continue; } break; }
        this.offset += nl + 1;
        const lines = buf.subarray(0, nl).toString('utf8').split('\n');
        if (this.skipFirst) { lines.shift(); this.skipFirst = false; }
        for (const l of lines) if (this.apply(l)) changed = true;
      }
    } catch { /* unreadable: keep what we have */ } finally { if (fd !== undefined) fs.closeSync(fd); }
    if (this.seen.size > 5000) this.seen.clear();
    return changed;
  }

  private reset(): void {
    this.offset = 0; this.prompt = ''; this.reply = ''; this.tokens = 0; this.tools = [];
    this.files.clear(); this.byId.clear(); this.est.clear(); this.seen.clear();
  }

  /** Applies one JSONL line; true when state changed. Exposed for tests. */
  apply(raw: string): boolean {
    if (!raw.trim() || raw.length > 4 * 1024 * 1024) return false;
    let o: Record<string, unknown> | undefined;
    try { o = rec(JSON.parse(raw)); } catch { return false; }
    const msg = rec(o?.message);
    if (!o || !msg) return false;
    const p = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN;
    const ts = Number.isFinite(p) ? p : Date.now();
    const c = msg.content;
    if (o.type === 'user') {
      if (Array.isArray(c) && c.some((b) => rec(b)?.type === 'tool_result')) {
        for (const b of c) {
          const x = rec(b);
          const e = x?.type === 'tool_result' && typeof x.tool_use_id === 'string' ? this.byId.get(x.tool_use_id) : undefined;
          if (!x || !e) continue;
          e.t.status = x.is_error === true ? 'err' : 'ok';
          e.t.ms = Math.max(0, ts - e.ts);
          const r = x.content;
          const text = typeof r === 'string' ? r : Array.isArray(r) ? r.map((y) => (typeof rec(y)?.text === 'string' ? rec(y)!.text as string : '')).join('\n') : '';
          e.t.out = clip(text, MAX_OUT);
          const ed = this.est.get(x.tool_use_id as string);
          if (ed && x.is_error !== true) { const f = this.files.get(ed.path) ?? { added: 0, removed: 0 }; f.added += ed.added; f.removed += ed.removed; if (this.files.size < 200 || this.files.has(ed.path)) this.files.set(ed.path, f); }
          this.est.delete(x.tool_use_id as string);
        }
        return true;
      }
      if (this.prompt || o.isMeta === true) return false;
      const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (typeof rec(b)?.text === 'string' ? rec(b)!.text as string : '')).join('\n') : '';
      const t = cleanPrompt(text).text;
      if (!t) return false;
      this.prompt = clip(t, 4000);
      return true;
    }
    if (o.type !== 'assistant') return false;
    const u = rec(msg.usage), id = typeof msg.id === 'string' ? msg.id : undefined;
    if (typeof msg.model === 'string' && !msg.model.startsWith('<')) this.model = msg.model.slice(0, 100);
    if (u && (!id || !this.seen.has(id))) {
      if (id) this.seen.add(id);
      const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
      this.tokens += n(u.input_tokens) + n(u.output_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens);
    }
    if (Array.isArray(c)) {
      for (const b of c) {
        const x = rec(b);
        if (x?.type === 'text' && typeof x.text === 'string' && x.text.trim()) this.reply = clip(x.text.trim(), 8000);
        if (x?.type === 'tool_use' && typeof x.id === 'string' && typeof x.name === 'string' && !this.byId.has(x.id)) {
          const t: DetailTool = { id: x.id.slice(0, 128), name: x.name.slice(0, 40), target: toolLabel(x.name, x.input), status: 'run', input: fmtInput(x.input) };
          this.tools.push(t);
          this.byId.set(x.id, { t, ts });
          const e = estimateEdit(x.name, x.input);
          if (e && this.est.size < 500) this.est.set(x.id, e);
          if (this.tools.length > 120) { const d = this.tools.shift()!; if (d.id) this.byId.delete(d.id); }
        }
      }
    }
    return true;
  }
}

export type DetailBase = { id: string; sessionId: string; title: string; type?: string; model?: string; state: string; stateText: string; since?: number; end?: number };

function textParts(prompt: string, reply: string) {
  const lines = reply.split('\n');
  return {
    promptHead: clip(prompt.split('\n').filter((l) => l.trim()).slice(0, 3).join('\n'), 400), prompt: clip(prompt, 4000),
    result: clip(lines.slice(0, 20).join('\n'), 2000), resultMore: lines.length > 20 || reply.length > 2000, resultFull: clip(reply, 8000)
  };
}

/** Detail of a running/finished subagent from its tailed transcript (tools carry IN/OUT). */
export function tailDetail(i: DetailBase, t: SubTail, taskFiles?: TlFile[]): AgentDetail {
  const fm = new Map(t.files);
  for (const f of taskFiles ?? []) if (!fm.has(f.path)) fm.set(f.path, { added: f.added, removed: f.removed });
  return {
    ...i, title: clip(i.title, 200), type: i.type?.slice(0, 64), model: (i.model ?? t.model)?.slice(0, 60), tokens: t.tokens,
    tools: t.tools.slice(-60).map((x) => ({ ...x })),
    files: [...fm].slice(0, 50).map(([p, c]) => ({ path: p, name: path.basename(p), ...c })),
    ...textParts(t.prompt, t.reply)
  };
}

/** Bounded, plain-text detail of one agent from its parsed turns (vscode-free; all text is clipped). */
export function buildDetail(i: DetailBase & { turns: TlTurn[]; tools?: TlTool[]; files?: TlFile[] }): AgentDetail {
  const turns = i.turns;
  const prompt = (turns.find((t) => t.prompt)?.prompt ?? '').trim();
  const reply = ([...turns].reverse().find((t) => t.reply)?.reply ?? '').trim();
  const tools = (i.tools ?? turns.flatMap((t) => t.tools)).slice(-60);
  const fm = new Map<string, { added: number; removed: number }>();
  for (const f of i.files ?? turns.flatMap((t) => t.files)) { const c = fm.get(f.path) ?? { added: 0, removed: 0 }; c.added += f.added; c.removed += f.removed; fm.set(f.path, c); }
  return {
    id: i.id, sessionId: i.sessionId, title: clip(i.title, 200), type: i.type?.slice(0, 64), model: i.model?.slice(0, 60), state: i.state, stateText: i.stateText, since: i.since, end: i.end,
    tokens: turns.reduce((s, t) => s + t.tokIn + t.tokOut, 0),
    tools: tools.map((t) => ({ id: t.id, name: t.name.slice(0, 40), target: t.target ? clip(firstSegment(t.target), 160) : undefined, status: t.status, ms: t.ms, input: t.command ? clip(stripCd(t.command), 4000) : undefined })),
    files: [...fm].slice(0, 50).map(([p, c]) => ({ path: p, name: path.basename(p), ...c })),
    ...textParts(prompt, reply)
  };
}
