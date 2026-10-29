// Markdown report of one Claude Code session. vscode-free. All user-derived text is escaped so it cannot
// break tables or inject links/HTML into the report.

import type { FamilyShare, TlTurn } from './timeline';

export interface SessionExportInput {
  label: string; sessionId: string; startedAt?: number; endedAt?: number;
  turns: Array<{ time: number; text: string; files: Array<{ path: string; added: number; removed: number }>; tools: number }>;
  models: Array<{ family: string; tokensIn: number; tokensOut: number; agents: number }>;
}

const MAX_TITLE = 80;

/** Maps timeline turns + family shares to export input. ponytail: main-session files only (subagent-only edits omitted). */
export function buildExportInput(label: string, sessionId: string, turns: TlTurn[], families: FamilyShare[]): SessionExportInput {
  return {
    label, sessionId, startedAt: turns[0]?.ts, endedAt: turns.length ? turns[turns.length - 1].endTs : undefined,
    turns: turns.map((t) => ({ time: t.ts, text: t.prompt ?? t.system ?? '', tools: t.tools.length, files: t.files.map((f) => ({ path: f.path, added: f.added, removed: f.removed })) })),
    models: families.map((f) => ({ family: f.family, tokensIn: f.tokens.in + f.tokens.cache, tokensOut: f.tokens.out, agents: f.agents.length }))
  };
}

/** Backslash-escapes Markdown/HTML-significant characters and flattens newlines. */
export function escapeMd(s: string): string {
  return s.replace(/\r\n?|\n/g, ' ').replace(/[\\|*_`[\]<>#]/g, (c) => '\\' + c);
}

function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s}s`;
}

function title(text: string): string {
  const first = text.split(/\r\n?|\n/).find((l) => l.trim())?.trim() ?? '';
  if (!first) return '(no text)';
  return escapeMd(first.length > MAX_TITLE ? first.slice(0, MAX_TITLE) + '…' : first);
}

export function sessionToMarkdown(input: SessionExportInput, formatTime: (ms: number) => string = (ms) => new Date(ms).toISOString().slice(11, 16)): string {
  const files = new Map<string, { added: number; removed: number }>();
  let tools = 0;
  for (const t of input.turns) {
    tools += t.tools;
    for (const f of t.files) {
      const x = files.get(f.path) ?? { added: 0, removed: 0 };
      x.added += f.added; x.removed += f.removed;
      files.set(f.path, x);
    }
  }
  let added = 0, removed = 0;
  for (const x of files.values()) { added += x.added; removed += x.removed; }

  const parts: string[] = [];
  if (input.startedAt !== undefined && input.endedAt !== undefined) parts.push(`Duration ${duration(input.endedAt - input.startedAt)}`);
  parts.push(`${input.turns.length} message${input.turns.length === 1 ? '' : 's'}`);
  parts.push(`${files.size} file${files.size === 1 ? '' : 's'} changed (+${added} −${removed})`);
  parts.push(`${tools} tool call${tools === 1 ? '' : 's'}`);

  const out: string[] = [`# ${escapeMd(input.label)} (${escapeMd(input.sessionId.slice(0, 8))})`, '', parts.join(' · '), ''];

  out.push('## Models', '');
  if (input.models.length) {
    out.push('| Model | Agents | Tokens in | Tokens out |', '| --- | --- | --- | --- |');
    for (const m of input.models) out.push(`| ${escapeMd(m.family)} | ${m.agents} | ${m.tokensIn} | ${m.tokensOut} |`);
  } else out.push('No model usage recorded.');
  out.push('', '## Messages', '');

  if (!input.turns.length) out.push('No messages.');
  for (const t of input.turns) {
    out.push(`### ${escapeMd(formatTime(t.time))} — ${title(t.text)}`, '');
    for (const f of t.files) out.push(`- ${escapeMd(f.path)} (+${f.added} −${f.removed})`);
    if (t.files.length) out.push('');
  }
  return out.join('\n').replace(/\n+$/, '') + '\n';
}
