// vscode-free pure logic for workspace checkpoints.
import * as path from 'path';

export interface FileEntry { path: string; sha: string; size: number; mode?: number }
export type Trigger = 'manual' | 'auto-prompt' | 'before-restore';
export interface Manifest { id: string; name: string; createdAt: string; trigger: Trigger; sessionId?: string; files: FileEntry[] }
export type DiffKind = 'added' | 'modified' | 'deleted';
export interface DiffEntry { path: string; kind: DiffKind }

export const DEFAULT_EXCLUDE = ['node_modules', '.git', 'dist', 'out', '.vscode-test', '*.vsix', '*.zip', '*.exe', '*.dll', '*.png', '*.jpg', '*.jpeg', '*.gif', '*.mp4', '*.mov', '*.pdf', '*.7z', '*.tar', '*.gz'];
export const ID_RE = /^[0-9]{13}-[0-9a-f]{6}$/;
export const SHA_RE = /^[0-9a-f]{64}$/;

/** Glob subset: `*` (no slash), `**`, `?`, leading `/` anchors, trailing `/` ignored. Matches a rel posix path or anything beneath it. */
export function globToRegExp(pat: string): RegExp {
  let p = pat.trim().replace(/\\/g, '/');
  const anchored = p.startsWith('/') || p.replace(/\/+$/, '').includes('/');
  p = p.replace(/^\/+/, '').replace(/\/+$/, '');
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') { i++; if (p[i + 1] === '/') i++; re += '(?:.*/)?'; } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${anchored ? '' : '(?:.*/)?'}${re}(?:/.*)?$`, 'i');
}

/** Builds an ignore predicate from glob lines (comments, blanks and `!` negations are skipped). */
export function makeIgnore(lines: string[]): (rel: string) => boolean {
  const res = lines.map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && !l.startsWith('!')).slice(0, 500).map(globToRegExp);
  return (rel) => res.some((r) => r.test(rel));
}

export function parseGitignore(text: string): string[] { return text.split(/\r?\n/).slice(0, 2000); }

/** Validates a manifest-relative path (posix, no traversal/abs/drive). Returns the absolute path inside root, else undefined. */
export function resolveRel(root: string, rel: unknown): string | undefined {
  if (typeof rel !== 'string' || !rel || rel.length > 1024 || rel.includes('\0') || rel.includes('\\')) return undefined;
  if (rel.startsWith('/') || /^[a-zA-Z]:/.test(rel) || rel.split('/').some((s) => s === '..' || s === '' || s === '.')) return undefined;
  const abs = path.resolve(root, rel);
  const r = path.relative(path.resolve(root), abs);
  return r && !r.startsWith('..') && !path.isAbsolute(r) ? abs : undefined;
}

/** Diff of a checkpoint (`then`) against the current tree (`now`). */
export function diffFiles(then: FileEntry[], now: FileEntry[]): DiffEntry[] {
  const cur = new Map(now.map((f) => [f.path, f.sha]));
  const out: DiffEntry[] = [];
  for (const f of then) {
    const s = cur.get(f.path);
    if (s === undefined) out.push({ path: f.path, kind: 'deleted' });
    else if (s !== f.sha) out.push({ path: f.path, kind: 'modified' });
    cur.delete(f.path);
  }
  for (const p of cur.keys()) out.push({ path: p, kind: 'added' });
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** IDs to prune: oldest non-manual checkpoints beyond `keep` total (manual ones are never auto-pruned). */
export function selectPrune(list: Pick<Manifest, 'id' | 'createdAt' | 'trigger'>[], keep: number): string[] {
  const sorted = [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  let excess = sorted.length - Math.max(1, keep);
  const out: string[] = [];
  for (let i = sorted.length - 1; i >= 0 && excess > 0; i--) {
    if (sorted[i].trigger !== 'manual') { out.push(sorted[i].id); excess--; }
  }
  return out;
}

/** Blobs referenced by none of the manifests. */
export function unreferencedBlobs(all: string[], manifests: Manifest[]): string[] {
  const used = new Set(manifests.flatMap((m) => m.files.map((f) => f.sha)));
  return all.filter((b) => !used.has(b));
}

/** Validates untrusted manifest JSON. */
export function parseManifest(x: unknown): Manifest | undefined {
  if (!x || typeof x !== 'object') return undefined;
  const o = x as Record<string, unknown>;
  if (typeof o.id !== 'string' || !ID_RE.test(o.id) || typeof o.name !== 'string' || typeof o.createdAt !== 'string' || Number.isNaN(Date.parse(o.createdAt))) return undefined;
  if (o.trigger !== 'manual' && o.trigger !== 'auto-prompt' && o.trigger !== 'before-restore') return undefined;
  if (!Array.isArray(o.files) || o.files.length > 200000) return undefined;
  const files: FileEntry[] = [];
  for (const f of o.files as Record<string, unknown>[]) {
    if (!f || typeof f.path !== 'string' || typeof f.sha !== 'string' || !SHA_RE.test(f.sha) || typeof f.size !== 'number' || !resolveRel('/r', f.path)) return undefined;
    files.push({ path: f.path, sha: f.sha, size: f.size, ...(typeof f.mode === 'number' ? { mode: f.mode } : {}) });
  }
  return { id: o.id, name: o.name.slice(0, 120), createdAt: o.createdAt, trigger: o.trigger, ...(typeof o.sessionId === 'string' ? { sessionId: o.sessionId.slice(0, 128) } : {}), files };
}
