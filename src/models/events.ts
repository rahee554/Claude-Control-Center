import { createHash } from 'crypto';

/** Normalized line written by hooks/ccc-hook.js. Everything read from disk is untrusted. */
export interface CccEvent {
  v: 1;
  ts: string;
  event: string;
  sessionId: string;
  agentId?: string;
  agentType?: string;
  toolName?: string;
  toolUseId?: string;
  summary?: string;
  filePath?: string;
  cwd?: string;
  transcriptPath?: string;
  pid?: number;
  isError?: boolean;
  /** Shell tools (Bash/PowerShell) only. */
  command?: string;
  description?: string;
  runInBackground?: boolean;
  stdout?: string;
  stderr?: string;
  interrupted?: boolean;
  exitCode?: number;
  backgroundTaskId?: string;
}

export const KNOWN_EVENTS = [
  'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'SubagentStart', 'SubagentStop', 'Stop', 'StopFailure', 'Notification', 'PreCompact'
] as const;

export const MAX_LINE = 160 * 1024;
const LIMITS: Record<string, number> = {
  ts: 64, event: 64, sessionId: 128, agentId: 128, agentType: 128, toolName: 128, toolUseId: 128,
  summary: 400, filePath: 1024, cwd: 1024, transcriptPath: 1024,
  command: 4096, description: 400, stdout: 140 * 1024, stderr: 140 * 1024, backgroundTaskId: 128
};
const FLAGS = ['isError', 'runInBackground', 'interrupted'] as const;

export function validateEvent(x: unknown): CccEvent | undefined {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return undefined;
  const o = x as Record<string, unknown>;
  if (o.v !== 1) return undefined;
  const out: Record<string, unknown> = { v: 1 };
  for (const [k, max] of Object.entries(LIMITS)) {
    const val = o[k];
    if (val === undefined) continue;
    if (typeof val !== 'string') return undefined;
    if (val.length > 0) out[k] = val.slice(0, max);
  }
  if (!out.ts || !out.event || !out.sessionId) return undefined;
  if (Number.isNaN(Date.parse(out.ts as string))) return undefined;
  if (o.pid !== undefined) {
    if (!Number.isInteger(o.pid) || (o.pid as number) <= 0) return undefined;
    out.pid = o.pid;
  }
  for (const f of FLAGS) {
    if (o[f] === undefined) continue;
    if (typeof o[f] !== 'boolean') return undefined;
    if (o[f]) out[f] = true;
  }
  if (o.exitCode !== undefined) {
    if (!Number.isInteger(o.exitCode)) return undefined;
    out.exitCode = o.exitCode;
  }
  return out as unknown as CccEvent;
}

export function parseEventLine(line: string): CccEvent | undefined {
  const t = line.trim();
  if (!t || t.length > MAX_LINE) return undefined;
  try { return validateEvent(JSON.parse(t)); } catch { return undefined; }
}

export function eventKey(e: CccEvent): string {
  // Tool events dedupe by tool_use_id so a hook registered twice (user + project settings) counts once.
  return createHash('sha1').update([e.sessionId, e.event, e.toolUseId ?? e.ts, e.agentId ?? '', e.toolName ?? ''].join('\u0000')).digest('hex');
}

export function eventTime(e: CccEvent): number {
  return Date.parse(e.ts);
}
