// Reads data captured by hooks/ccc-statusline.js and ~/.claude/sessions/<pid>.json. vscode-free.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SESSION_ID_RE } from './fileHistory';

export const CCC_HOME = path.join(os.homedir(), '.claude-control-center');
export const STATUSLINE_DIR = path.join(CCC_HOME, 'statusline');
export const SESSIONS_DIR = path.join(os.homedir(), '.claude', 'sessions');
const MAX_FILE = 256 * 1024;

export interface LimitWindow { usedPercentage: number; resetsAt?: number }
export interface StatusCapture {
  ts: number;
  sessionId: string;
  fiveHour?: LimitWindow;
  sevenDay?: LimitWindow;
  model?: string;
  contextUsedPercentage?: number;
  contextWindowSize?: number;
  costUSD?: number;
}

function readJson(file: string): unknown {
  try {
    if (fs.statSync(file).size > MAX_FILE) return undefined;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return undefined; }
}

function win(v: unknown, nowSec: number): LimitWindow | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const pct = o.used_percentage;
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return undefined;
  const resetsAt = typeof o.resets_at === 'number' && Number.isFinite(o.resets_at) ? o.resets_at : undefined;
  if (resetsAt !== undefined && resetsAt < nowSec) return undefined; // window already reset: value is meaningless
  return { usedPercentage: Math.max(0, Math.min(100, pct)), resetsAt };
}

/** Parses one capture file's JSON; undefined if malformed. */
export function parseCapture(raw: unknown, now = Date.now()): StatusCapture | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  if (typeof o.ts !== 'number' || typeof o.sessionId !== 'string' || !SESSION_ID_RE.test(o.sessionId)) return undefined;
  const rl = (o.rate_limits ?? {}) as Record<string, unknown>;
  const nowSec = now / 1000;
  const cw = o.context_window as Record<string, unknown> | undefined;
  const cost = o.cost as Record<string, unknown> | undefined;
  const model = o.model as Record<string, unknown> | undefined;
  return {
    ts: o.ts, sessionId: o.sessionId,
    fiveHour: win(rl.five_hour, nowSec), sevenDay: win(rl.seven_day, nowSec),
    model: typeof model?.id === 'string' ? model.id.slice(0, 100) : undefined,
    contextUsedPercentage: typeof cw?.used_percentage === 'number' ? cw.used_percentage : undefined,
    contextWindowSize: typeof cw?.context_window_size === 'number' && cw.context_window_size > 0 ? cw.context_window_size : undefined,
    costUSD: typeof cost?.total_cost_usd === 'number' ? cost.total_cost_usd : undefined
  };
}

export type LimitView = { available: true; usedPercentage: number; resetsAt?: number; capturedAt: number } | { available: false; reason: string };

/** Display state for a limit window; never guesses. */
export function limitView(c: StatusCapture | undefined, which: 'fiveHour' | 'sevenDay'): LimitView {
  if (!c) return { available: false, reason: 'No status-line capture yet. Run "Claude Control Center: Install Status Line Capture" and use Claude Code in a terminal (Pro/Max plans only).' };
  const w = c[which];
  if (!w) return { available: false, reason: 'The status line did not report this window (API-key plan, before the first response, or the window reset).' };
  return { available: true, usedPercentage: w.usedPercentage, resetsAt: w.resetsAt, capturedAt: c.ts };
}

import type { CliUsage } from './usageCli';

export class UsageService {
  /** Latest parsed `claude -p /usage` result (account-wide; set by the poller in extension.ts). */
  cli?: CliUsage;
  constructor(private readonly dir = STATUSLINE_DIR) {}

  get(sessionId: string): StatusCapture | undefined {
    if (!SESSION_ID_RE.test(sessionId)) return undefined;
    return parseCapture(readJson(path.join(this.dir, `${sessionId}.json`)));
  }

  /** Newest capture of any session (account limits are account-wide). */
  latest(): StatusCapture | undefined {
    let best: StatusCapture | undefined;
    let names: string[] = [];
    try { names = fs.readdirSync(this.dir).filter((n) => n.endsWith('.json')).slice(0, 500); } catch { return undefined; }
    for (const n of names) {
      const c = parseCapture(readJson(path.join(this.dir, n)));
      if (c && (!best || c.ts > best.ts)) best = c;
    }
    return best;
  }
}

/** pid -> sessionId from ~/.claude/sessions/<pid>.json. Only reads files named exactly `<digits>.json` (never .key files). */
export function readSessionPids(dir = SESSIONS_DIR): Map<number, string> {
  const m = new Map<number, string>();
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { return m; }
  for (const n of names) {
    if (!/^\d{1,10}\.json$/.test(n)) continue;
    const o = readJson(path.join(dir, n)) as Record<string, unknown> | undefined;
    const pid = Number(n.slice(0, -5));
    if (o && typeof o.sessionId === 'string' && SESSION_ID_RE.test(o.sessionId) && (o.pid === undefined || o.pid === pid)) m.set(pid, o.sessionId);
  }
  return m;
}

/** Merges hook-reported pids with CLI pids from ~/.claude/sessions/<pid>.json. */
export function mergePidSources(reported: Map<number, string[]>, files: Map<number, string>): Map<number, { sessions: string[]; fromFile: boolean }> {
  const m = new Map<number, { sessions: string[]; fromFile: boolean }>();
  for (const [pid, s] of reported) m.set(pid, { sessions: [...s], fromFile: false });
  for (const [pid, s] of files) {
    const cur = m.get(pid);
    if (cur) { if (!cur.sessions.includes(s)) cur.sessions.push(s); } else m.set(pid, { sessions: [s], fromFile: true });
  }
  return m;
}
