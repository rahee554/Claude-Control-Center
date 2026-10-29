// Filesystem store for checkpoints (vscode-free). Content-addressed blobs + JSON manifests.
import { createHash, randomBytes } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { diffFiles, FileEntry, ID_RE, Manifest, makeIgnore, parseGitignore, parseManifest, resolveRel, selectPrune, SHA_RE, Trigger, unreferencedBlobs } from './logic';

export interface Limits { maxFileBytes: number; maxTotalBytes: number; exclude: string[] }
const CONC = 8;

export function storeDir(workspace: string, home = os.homedir()): string {
  return path.join(home, '.claude-control-center', 'checkpoints', createHash('sha1').update(workspace).digest('hex').slice(0, 16));
}

async function atomicWrite(file: string, data: Buffer | string): Promise<void> {
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  await fs.promises.writeFile(tmp, data);
  await fs.promises.rename(tmp, file);
}

async function pool<T>(items: T[], fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(CONC, items.length) }, async () => { while (i < items.length) await fn(items[i++]); }));
}

/** Lists workspace files (rel posix paths) honoring excludes and the top-level .gitignore. */
export async function scan(root: string, exclude: string[]): Promise<{ rel: string; size: number; mode: number }[]> {
  let gi: string[] = [];
  try { gi = parseGitignore(await fs.promises.readFile(path.join(root, '.gitignore'), 'utf8')); } catch { /* none */ }
  const ignored = makeIgnore([...exclude, ...gi]);
  const out: { rel: string; size: number; mode: number }[] = [];
  const walk = async (dir: string, rel: string): Promise<void> => {
    let ents: fs.Dirent[];
    try { ents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (ignored(r)) continue;
      if (e.isDirectory()) await walk(path.join(dir, e.name), r);
      else if (e.isFile()) {
        try { const st = await fs.promises.stat(path.join(dir, e.name)); out.push({ rel: r, size: st.size, mode: st.mode & 0o777 }); } catch { /* vanished */ }
      }
    }
  };
  await walk(root, '');
  return out;
}

export class CheckpointStore {
  readonly dir: string;
  constructor(readonly root: string, home?: string) { this.dir = storeDir(root, home); }
  private blob(sha: string): string { return path.join(this.dir, 'blobs', sha); }

  /** Hashes current files. Files over the per-file cap are skipped; over the total cap nothing is hashed. */
  async snapshotTree(lim: Limits, onFile?: () => void): Promise<{ files: FileEntry[]; blobs: Map<string, string>; total: number }> {
    const ok = (await scan(this.root, lim.exclude)).filter((f) => f.size <= lim.maxFileBytes);
    const total = ok.reduce((s, f) => s + f.size, 0);
    const files: FileEntry[] = []; const blobs = new Map<string, string>();
    if (total > lim.maxTotalBytes) return { files, blobs, total };
    await pool(ok, async (f) => {
      try {
        const abs = path.join(this.root, ...f.rel.split('/'));
        const sha = createHash('sha256').update(await fs.promises.readFile(abs)).digest('hex');
        files.push({ path: f.rel, sha, size: f.size, mode: f.mode }); blobs.set(sha, abs);
      } catch { /* unreadable: skip */ }
      onFile?.();
    });
    files.sort((a, b) => a.path.localeCompare(b.path));
    return { files, blobs, total };
  }

  async create(name: string, trigger: Trigger, lim: Limits, sessionId?: string, onFile?: () => void): Promise<Manifest> {
    const snap = await this.snapshotTree(lim, onFile);
    if (snap.total > lim.maxTotalBytes) throw new Error(`Workspace is ${(snap.total / 1048576).toFixed(0)} MB, over the ${(lim.maxTotalBytes / 1048576).toFixed(0)} MB checkpoint limit. Add excludes or raise ccc.checkpoints.maxTotalMB.`);
    await fs.promises.mkdir(path.join(this.dir, 'blobs'), { recursive: true });
    await fs.promises.mkdir(path.join(this.dir, 'index'), { recursive: true });
    await pool([...snap.blobs], async ([sha, abs]) => {
      const dest = this.blob(sha);
      try { await fs.promises.access(dest); return; } catch { /* new blob */ }
      const data = await fs.promises.readFile(abs);
      if (createHash('sha256').update(data).digest('hex') === sha) await atomicWrite(dest, data); // else changed mid-scan; entry dropped below
    });
    const files: FileEntry[] = [];
    for (const f of snap.files) { try { await fs.promises.access(this.blob(f.sha)); files.push(f); } catch { /* changed mid-scan */ } }
    const id = `${Date.now()}-${randomBytes(3).toString('hex')}`;
    const m: Manifest = { id, name: name.slice(0, 120), createdAt: new Date().toISOString(), trigger, ...(sessionId ? { sessionId } : {}), files };
    await atomicWrite(path.join(this.dir, 'index', `${id}.json`), JSON.stringify(m));
    return m;
  }

  async list(): Promise<Manifest[]> {
    let names: string[];
    try { names = await fs.promises.readdir(path.join(this.dir, 'index')); } catch { return []; }
    const out: Manifest[] = [];
    for (const n of names.filter((x) => x.endsWith('.json'))) {
      try {
        const p = path.join(this.dir, 'index', n);
        if ((await fs.promises.stat(p)).size > 64 * 1024 * 1024) continue;
        const m = parseManifest(JSON.parse(await fs.promises.readFile(p, 'utf8')));
        if (m) out.push(m);
      } catch { /* corrupt manifest ignored */ }
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async get(id: string): Promise<Manifest | undefined> { return ID_RE.test(id) ? (await this.list()).find((m) => m.id === id) : undefined; }

  async readBlob(sha: string): Promise<Buffer | undefined> {
    if (!SHA_RE.test(sha)) return undefined;
    try { return await fs.promises.readFile(this.blob(sha)); } catch { return undefined; }
  }

  async remove(id: string): Promise<void> {
    if (!ID_RE.test(id)) return;
    await fs.promises.rm(path.join(this.dir, 'index', `${id}.json`), { force: true });
    await this.gc();
  }

  async prune(keep: number): Promise<void> {
    for (const id of selectPrune(await this.list(), keep)) await fs.promises.rm(path.join(this.dir, 'index', `${id}.json`), { force: true });
    await this.gc();
  }

  async gc(): Promise<void> {
    let blobs: string[];
    try { blobs = (await fs.promises.readdir(path.join(this.dir, 'blobs'))).filter((b) => SHA_RE.test(b)); } catch { return; }
    for (const b of unreferencedBlobs(blobs, await this.list())) await fs.promises.rm(this.blob(b), { force: true });
  }

  /** Files changed between a checkpoint and the current tree. */
  async changedSince(m: Manifest, lim: Limits): Promise<ReturnType<typeof diffFiles>> {
    const snap = await this.snapshotTree({ ...lim, maxTotalBytes: Number.MAX_SAFE_INTEGER });
    return diffFiles(m.files, snap.files);
  }

  /** Writes one file back from the checkpoint; the path must stay inside the workspace. */
  async restoreFile(m: Manifest, rel: string): Promise<boolean> {
    const f = m.files.find((x) => x.path === rel);
    const abs = resolveRel(this.root, rel);
    if (!f || !abs) return false;
    const data = await this.readBlob(f.sha);
    if (!data) return false;
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    await atomicWrite(abs, data);
    if (f.mode !== undefined && process.platform !== 'win32') await fs.promises.chmod(abs, f.mode).catch(() => undefined);
    return true;
  }

  async deleteWorkspaceFile(rel: string): Promise<void> {
    const abs = resolveRel(this.root, rel);
    if (abs) await fs.promises.rm(abs, { force: true });
  }
}
