import { execFile } from 'child_process';

const TIMEOUT_MS = 2000;
const CACHE_MS = 10000;

/** pid -> ppid table from one OS query (no shell; fixed argv). */
function queryParents(): Promise<Map<number, number>> {
  const win = process.platform === 'win32';
  const file = win ? 'powershell.exe' : 'ps';
  const args = win
    ? ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }']
    : ['-A', '-o', 'pid=,ppid='];
  return new Promise((resolve) => {
    execFile(file, args, { timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      const m = new Map<number, number>();
      if (!err) {
        for (const line of stdout.split(/\r?\n/)) {
          const [a, b] = line.trim().split(/\s+/).map(Number);
          if (Number.isInteger(a) && Number.isInteger(b) && a > 0) m.set(a, b);
        }
      }
      resolve(m);
    });
  });
}

/** Optional parent-pid lookup used to confirm a terminal hosts a Claude process. */
export class ProcessAdapter {
  private cache?: { at: number; table: Promise<Map<number, number>> };

  constructor(private readonly enabled: () => boolean, private readonly query = queryParents) {}

  private table(): Promise<Map<number, number>> {
    const now = Date.now();
    if (!this.cache || now - this.cache.at > CACHE_MS) this.cache = { at: now, table: this.query() };
    return this.cache.table;
  }

  /** Ancestor chain starting with pid itself; [pid] when disabled or unavailable. */
  async ancestors(pid: number, max = 16): Promise<number[]> {
    if (!Number.isInteger(pid) || pid <= 0) return [];
    if (!this.enabled()) return [pid];
    const t = await this.table();
    const chain = [pid];
    let cur = pid;
    for (let i = 0; i < max; i++) {
      const p = t.get(cur);
      if (!p || p <= 0 || chain.includes(p)) break;
      chain.push(p);
      cur = p;
    }
    return chain;
  }
}
