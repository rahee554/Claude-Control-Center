import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CccEvent, eventKey, parseEventLine } from '../models/events';
import { Emitter } from '../util/emitter';

export const DEFAULT_EVENTS_DIR = path.join(os.homedir(), '.claude-control-center', 'events');

export interface HookCollectorOptions {
  dir?: string;
  pollMs?: number;
  /** On first sight of a file (e.g. after reload) only its last N bytes are read. */
  initialTailBytes?: number;
  /** Max bytes read from one file per scan. */
  maxReadBytes?: number;
  maxFiles?: number;
  /** Backfill: only the newest N files never seen before are read (tail); older unseen files start at EOF. */
  backfillFiles?: number;
}

const DEDUPE_CAP = 20000;

/** Tails ~/.claude-control-center/events/*.jsonl incrementally by byte offset. */
export class HookCollector {
  readonly dir: string;
  private readonly offsets = new Map<string, number>();
  private readonly seen = new Set<string>();
  private watcher?: fs.FSWatcher;
  private timer?: NodeJS.Timeout;
  private debounce?: NodeJS.Timeout;
  private paused = false;
  private pollMs: number;
  private readonly tail: number;
  private readonly maxRead: number;
  private readonly maxFiles: number;
  private readonly backfill: number;
  malformedLines = 0;
  private readonly _onEvents = new Emitter<CccEvent[]>();
  readonly onEvents = this._onEvents.event;

  constructor(opts: HookCollectorOptions = {}) {
    this.dir = opts.dir ?? DEFAULT_EVENTS_DIR;
    this.pollMs = opts.pollMs ?? 5000;
    this.tail = opts.initialTailBytes ?? 1024 * 1024;
    this.maxRead = opts.maxReadBytes ?? 1024 * 1024;
    this.maxFiles = opts.maxFiles ?? 200;
    this.backfill = opts.backfillFiles ?? 30;
  }

  start(): void {
    try { fs.mkdirSync(this.dir, { recursive: true }); } catch { /* reported by scan */ }
    try {
      this.watcher = fs.watch(this.dir, () => this.schedule());
      this.watcher.on('error', () => { this.watcher?.close(); this.watcher = undefined; });
    } catch { /* fall back to polling only */ }
    this.setPollInterval(this.pollMs);
    this.scan();
  }

  setPollInterval(ms: number): void {
    this.pollMs = Math.min(Math.max(ms, 1000), 300000);
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this.scan(), this.pollMs);
  }

  setPaused(p: boolean): void {
    this.paused = p;
    if (!p) this.scan();
  }

  private schedule(): void {
    if (this.debounce) return;
    this.debounce = setTimeout(() => { this.debounce = undefined; this.scan(); }, 100);
  }

  /** Reads new bytes from all event files; returns the newly accepted events (also fired). */
  scan(): CccEvent[] {
    if (this.paused) return [];
    let names: string[];
    try { names = fs.readdirSync(this.dir).filter((n) => n.endsWith('.jsonl')); } catch { return []; }
    const files: { file: string; size: number; mtime: number }[] = [];
    for (const n of names) {
      const file = path.join(this.dir, n);
      try {
        const st = fs.statSync(file);
        if (st.isFile()) files.push({ file, size: st.size, mtime: st.mtimeMs });
      } catch { /* vanished */ }
    }
    files.sort((a, b) => b.mtime - a.mtime);
    const out: CccEvent[] = [];
    files.forEach((f, i) => {
      // Bounded backfill: ended sessions from before activation still surface (Changes view, Recent).
      if (i >= this.backfill && !this.offsets.has(f.file)) this.offsets.set(f.file, f.size);
    });
    for (const f of files.slice(0, this.maxFiles)) out.push(...this.readFile(f.file, f.size));
    if (out.length) this._onEvents.fire(out);
    return out;
  }

  private readFile(file: string, size: number): CccEvent[] {
    let start = this.offsets.get(file);
    let skipPartial = false;
    if (start === undefined) {
      start = Math.max(0, size - this.tail);
      skipPartial = start > 0;
    } else if (size < start) {
      start = 0; // truncated/rotated
    }
    if (size <= start) { this.offsets.set(file, start); return []; }
    const len = Math.min(size - start, this.maxRead);
    const buf = Buffer.alloc(len);
    let fd: number | undefined;
    try {
      fd = fs.openSync(file, 'r');
      fs.readSync(fd, buf, 0, len, start);
    } catch { return []; } finally { if (fd !== undefined) fs.closeSync(fd); }
    let begin = 0;
    if (skipPartial) {
      const nl = buf.indexOf(0x0a);
      if (nl < 0) { this.offsets.set(file, start + len); return []; }
      begin = nl + 1;
    }
    const lastNl = buf.lastIndexOf(0x0a);
    if (lastNl < begin) {
      // no complete line yet; if buffer is full of garbage beyond the cap, skip it
      if (len === this.maxRead) this.offsets.set(file, start + len);
      else this.offsets.set(file, start + begin);
      return [];
    }
    this.offsets.set(file, start + lastNl + 1);
    const out: CccEvent[] = [];
    for (const line of buf.subarray(begin, lastNl).toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      const ev = parseEventLine(line);
      if (!ev) { this.malformedLines++; continue; }
      const k = eventKey(ev);
      if (this.seen.has(k)) continue;
      this.remember(k);
      out.push(ev);
    }
    return out;
  }

  private remember(k: string): void {
    this.seen.add(k);
    if (this.seen.size > DEDUPE_CAP) {
      const first = this.seen.values().next().value;
      if (first !== undefined) this.seen.delete(first);
    }
  }

  dispose(): void {
    this.watcher?.close();
    if (this.timer) clearInterval(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
    this._onEvents.dispose();
  }
}
