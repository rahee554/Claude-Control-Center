// Account limits from the user's own `claude -p /usage` (works for subscription plans, no API key).
// Text output is parsed best-effort; anything unrecognised stays Unavailable. vscode-free.
import { execFile } from 'child_process';
import { cliEnv } from '../util/cliEnv';
import { cliCwd } from '../util/noiseSessions';

export interface CliLimit { usedPercentage: number; resetsText?: string; resetsAt?: number }
export interface CliUsage { ts: number; fiveHour?: CliLimit; sevenDay?: CliLimit }

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** "Oct 29, 4:19pm" / "Nov 2, 1pm" in local time → epoch seconds; rolls into next year if needed. */
export function parseReset(text: string, now = Date.now()): number | undefined {
  const m = /([A-Za-z]{3})[a-z]*\s+(\d{1,2}),?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(text);
  if (!m) return undefined;
  const month = MONTHS.indexOf(m[1].toLowerCase());
  if (month < 0) return undefined;
  let h = Number(m[3]) % 12;
  if (m[5].toLowerCase() === 'pm') h += 12;
  const year = new Date(now).getFullYear();
  let d = new Date(year, month, Number(m[2]), h, Number(m[4] ?? 0));
  if (d.getTime() < now - 86_400_000) d = new Date(year + 1, month, Number(m[2]), h, Number(m[4] ?? 0));
  return Math.floor(d.getTime() / 1000);
}

function line(out: string, label: RegExp, now: number): CliLimit | undefined {
  for (const l of out.split(/\r?\n/)) {
    if (!label.test(l)) continue;
    const pct = /(\d{1,3}(?:\.\d+)?)%\s*used/i.exec(l);
    if (!pct) return undefined;
    const r = /resets\s+(.+)$/i.exec(l);
    const resetsText = r?.[1].trim().slice(0, 80);
    return { usedPercentage: Math.min(100, Number(pct[1])), resetsText, resetsAt: resetsText ? parseReset(resetsText, now) : undefined };
  }
  return undefined;
}

export function parseUsageOutput(out: string, now = Date.now()): CliUsage | undefined {
  const fiveHour = line(out, /^\s*current session\b/i, now);
  const sevenDay = line(out, /^\s*current week \(all models\)/i, now);
  return fiveHour || sevenDay ? { ts: now, fiveHour, sevenDay } : undefined;
}

/** Runs `claude -p /usage` with fixed arguments (no user/untrusted input reaches the command line). */
export function runUsageCli(claudePath = 'claude', timeoutMs = 30_000, env?: Record<string, string>): Promise<CliUsage | undefined> {
  // `~` appears in Windows 8.3 short paths (C:\Users\RUNNER~1\...) and is inert for cmd.exe.
  if (!/^[\w .:\\/()~-]+$/.test(claudePath) || /["&|<>^%]/.test(claudePath)) return Promise.resolve(undefined);
  const win = process.platform === 'win32';
  // .cmd shims need cmd.exe on Windows; arguments are constants.
  const [file, args] = win ? ['cmd.exe', ['/d', '/s', '/c', claudePath, '-p', '/usage', '--no-session-persistence']] : [claudePath, ['-p', '/usage', '--no-session-persistence']];
  return new Promise(resolve => {
    const child = execFile(file, args, { cwd: cliCwd(), timeout: timeoutMs, windowsHide: true, maxBuffer: 256 * 1024, env: cliEnv(process.env, env) }, (err, stdout) => {
      resolve(err ? undefined : parseUsageOutput(String(stdout)));
    });
    child.stdin?.end();
  });
}
