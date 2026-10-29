// Pure, vscode-free access to Claude Code's file-history backups (~/.claude/file-history/<sessionId>/<hash>@v<N>).
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const DEFAULT_FILE_HISTORY_ROOT = path.join(os.homedir(), '.claude', 'file-history');
export const MAX_BASELINE_BYTES = 5 * 1024 * 1024;
export const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
/** Claude file-history backup (`<hash>@v<N>`) or a hook-captured baseline (`ccc-<sha1>`, see hooks/ccc-hook.js). */
export const BACKUP_NAME_RE = /^(?:[0-9a-f]{16}@v\d{1,6}|ccc-[0-9a-f]{40})$/;
/** Baselines the hook saves from PostToolUse `originalFile` (subagent transcripts carry no file-history). */
export const CCC_BASELINE_ROOT = path.join(os.homedir(), '.claude-control-center', 'baselines');

export function cccBaselineKey(filePath: string): string {
  return crypto.createHash('sha1').update(filePath).digest('hex');
}

/** Hook-captured baseline for a file in a session: 'ccc-<h>' (content), null (created by Claude), undefined (none). */
export function cccBaseline(sessionId: string, filePath: string, root = CCC_BASELINE_ROOT): string | null | undefined {
  if (!SESSION_ID_RE.test(sessionId)) return undefined;
  const h = cccBaselineKey(filePath);
  if (fs.existsSync(path.join(root, sessionId, h))) return `ccc-${h}`;
  if (fs.existsSync(path.join(root, sessionId, `${h}.created`))) return null;
  return undefined;
}

/** Absolute backup path, or undefined if the ids are invalid or would escape the root. */
export function baselinePath(sessionId: string, backupName: string, root = DEFAULT_FILE_HISTORY_ROOT): string | undefined {
  if (!SESSION_ID_RE.test(sessionId) || !BACKUP_NAME_RE.test(backupName)) return undefined;
  const p = path.resolve(root, sessionId, backupName);
  const rel = path.relative(path.resolve(root), p);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? p : undefined;
}

export type Baseline = { kind: 'created' } | { kind: 'content'; data: Uint8Array } | { kind: 'unavailable'; reason: string };

/** Resolves the "before" content of a change. null backup = file was created (empty baseline). */
export function readBaseline(sessionId: string, backupName: string | null | undefined, root = DEFAULT_FILE_HISTORY_ROOT): Baseline {
  if (backupName === null) return { kind: 'created' };
  if (backupName === undefined) return { kind: 'unavailable', reason: 'No file-history backup recorded for this file.' };
  if (/^ccc-[0-9a-f]{40}$/.test(backupName)) { if (root === DEFAULT_FILE_HISTORY_ROOT) root = CCC_BASELINE_ROOT; backupName = backupName.slice(4); }
  const p = /^[0-9a-f]{40}$/.test(backupName) ? path.resolve(root, sessionId, backupName) : baselinePath(sessionId, backupName, root);
  if (!SESSION_ID_RE.test(sessionId)) return { kind: 'unavailable', reason: 'Invalid backup reference.' };
  if (!p) return { kind: 'unavailable', reason: 'Invalid backup reference.' };
  try {
    const real = fs.realpathSync(p);
    const rel = path.relative(fs.realpathSync(root), real);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return { kind: 'unavailable', reason: 'Backup outside file-history.' };
    const st = fs.statSync(real);
    if (!st.isFile()) return { kind: 'unavailable', reason: 'Backup is not a file.' };
    if (st.size > MAX_BASELINE_BYTES) return { kind: 'unavailable', reason: 'Backup larger than 5 MB.' };
    return { kind: 'content', data: fs.readFileSync(real) };
  } catch {
    return { kind: 'unavailable', reason: 'Backup file not found.' };
  }
}

/** True when p is inside one of the folders (case-insensitive on Windows). */
/** A file the webview may ask us to open: absolute, not UNC, inside a workspace folder. */
export function isOpenablePath(p: string, folders: string[]): boolean {
  return path.isAbsolute(p) && !/^[\\/]{2}/.test(p) && isInside(p, folders);
}
export function isInside(p: string, folders: string[]): boolean {
  const norm = (x: string) => (process.platform === 'win32' ? path.resolve(x).toLowerCase() : path.resolve(x));
  const t = norm(p);
  return folders.some((f) => {
    const rel = path.relative(norm(f), t);
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  });
}
