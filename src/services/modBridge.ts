import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isOpenablePath, SESSION_ID_RE } from './fileHistory';

export const REQUESTS_DIR = path.join(os.homedir(), '.claude-control-center', 'requests');
const MAX_BYTES = 4096;
const MAX_AGE_MS = 60_000;

export type OpenDiffRequest = { path: string; sessionId: string };

/** Strictly validates a mod request; returns undefined for anything off-spec. */
export function parseRequest(text: string, folders: string[], now = Date.now()): OpenDiffRequest | undefined {
  if (text.length > MAX_BYTES) return undefined;
  let o: Record<string, unknown>;
  try { o = JSON.parse(text) as Record<string, unknown>; } catch { return undefined; }
  if (!o || typeof o !== 'object' || o.v !== 1 || !['openDiff'].includes(o.action as string)) return undefined;
  if (typeof o.path !== 'string' || !isOpenablePath(o.path, folders)) return undefined;
  if (typeof o.sessionId !== 'string' || !SESSION_ID_RE.test(o.sessionId)) return undefined;
  if (typeof o.ts !== 'number' || now - o.ts > MAX_AGE_MS || o.ts - now > MAX_AGE_MS) return undefined;
  return { path: o.path, sessionId: o.sessionId };
}

/** Watches the requests dir; returns a disposer. */
export function watchRequests(folders: () => string[], onOpen: (r: OpenDiffRequest) => void, log: (m: string) => void): () => void {
  try { fs.mkdirSync(REQUESTS_DIR, { recursive: true }); } catch { return () => undefined; }
  const scan = () => {
    let names: string[];
    try { names = fs.readdirSync(REQUESTS_DIR).filter((n) => n.endsWith('.json')).slice(0, 20); } catch { return; }
    for (const n of names) {
      const f = path.join(REQUESTS_DIR, n);
      try {
        const st = fs.statSync(f);
        const text = st.isFile() && st.size <= MAX_BYTES ? fs.readFileSync(f, 'utf8') : '';
        fs.unlinkSync(f);
        const r = parseRequest(text, folders());
        if (r) onOpen(r); else log('mod bridge: ignored invalid request');
      } catch { /* raced or unreadable */ }
    }
  };
  let w: fs.FSWatcher | undefined;
  try { w = fs.watch(REQUESTS_DIR, scan); } catch { /* poll only */ }
  const t = setInterval(scan, 2000);
  return () => { w?.close(); clearInterval(t); };
}
