// Pure merge of our hook entries into Claude Code settings JSON, plus atomic file write.
import * as fs from 'fs';
import * as path from 'path';

export const HOOK_EVENTS = [
  'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'SubagentStart', 'SubagentStop', 'Stop', 'Notification'
] as const;
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure']);
export const HOOK_MARKER = 'ccc-hook.js';

/** `baseDir/hooks/ccc-hook.js`; the extension passes ~/.claude-control-center (stable across extension updates). */
export function hookCommand(extensionPath: string, collectPrompts = false): string {
  const p = path.join(extensionPath, 'hooks', HOOK_MARKER).replace(/\\/g, '/');
  if (/["\r\n]/.test(p)) throw new Error('Unsupported characters in extension path');
  return `node "${p}"${collectPrompts ? ' --collect-prompts' : ''}`;
}

type HookGroup = { matcher?: string; hooks: { type: 'command'; command: string; timeout: number }[] };

export function buildHooksBlock(command: string): Record<string, HookGroup[]> {
  const out: Record<string, HookGroup[]> = {};
  for (const ev of HOOK_EVENTS) {
    out[ev] = [{ ...(TOOL_EVENTS.has(ev) ? { matcher: '*' } : {}), hooks: [{ type: 'command', command, timeout: 10 }] }];
  }
  return out;
}

/** Distinct ccc hook commands in settings that do not reference `scriptPath`. */
export function staleHookCommands(settings: unknown, scriptPath: string): string[] {
  const want = scriptPath.replace(/\\/g, '/');
  const hooks = (settings as { hooks?: unknown } | undefined)?.hooks;
  if (!hooks || typeof hooks !== 'object') return [];
  const out = new Set<string>();
  for (const groups of Object.values(hooks as Record<string, unknown>)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      for (const h of (g as HookGroup | undefined)?.hooks ?? []) {
        if (isOurs(h) && !h.command.includes(want)) out.add(h.command);
      }
    }
  }
  return [...out];
}

function isOurs(h: unknown): boolean {
  return !!h && typeof h === 'object' && typeof (h as { command?: unknown }).command === 'string'
    && (h as { command: string }).command.includes(HOOK_MARKER);
}

/** Returns merged settings. Existing non-ccc hooks are preserved; prior ccc entries are replaced (idempotent). */
export function mergeHooks(settings: unknown, command: string): { settings: Record<string, unknown>; changed: boolean } {
  if (settings !== undefined && (typeof settings !== 'object' || settings === null || Array.isArray(settings))) {
    throw new Error('settings.json is not a JSON object');
  }
  const base = structuredClone((settings ?? {}) as Record<string, unknown>);
  const hooksIn = base.hooks;
  if (hooksIn !== undefined && (typeof hooksIn !== 'object' || hooksIn === null || Array.isArray(hooksIn))) {
    throw new Error('settings.json "hooks" is not an object');
  }
  const hooks = (hooksIn ?? {}) as Record<string, unknown>;
  const ours = buildHooksBlock(command);
  for (const ev of HOOK_EVENTS) {
    const existing = Array.isArray(hooks[ev]) ? (hooks[ev] as unknown[]) : [];
    const kept: unknown[] = [];
    for (const g of existing) {
      if (g && typeof g === 'object' && Array.isArray((g as HookGroup).hooks)) {
        const rest = (g as HookGroup).hooks.filter((h) => !isOurs(h));
        if (rest.length) kept.push({ ...(g as object), hooks: rest });
      } else {
        kept.push(g);
      }
    }
    hooks[ev] = [...kept, ...ours[ev]];
  }
  base.hooks = hooks;
  return { settings: base, changed: JSON.stringify(base) !== JSON.stringify(settings ?? {}) };
}

/** Reads settings.json (bounded); undefined when missing. Throws on invalid JSON so we never clobber it. */
export function readSettings(file: string): unknown {
  let text: string;
  try {
    if (fs.statSync(file).size > 5 * 1024 * 1024) throw new Error('settings.json is unexpectedly large');
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
  if (!text.trim()) return undefined;
  return JSON.parse(text.replace(/^﻿/, ''));
}

/** Backs up (if present) then writes via tmp + rename. Returns backup path. */
export function writeSettingsAtomic(file: string, data: unknown): string | undefined {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let backup: string | undefined;
  if (fs.existsSync(file)) {
    backup = `${file}.ccc-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(file, backup);
  }
  const tmp = `${file}.ccc-tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
  return backup;
}

// ---- status line wrapper (rate-limit capture) ----
export const STATUSLINE_MARKER = 'ccc-statusline.js';

export function statusLineCommand(scriptPath: string): string {
  const p = scriptPath.replace(/\\/g, '/');
  if (/["\r\n]/.test(p)) throw new Error('Unsupported characters in script path');
  return `node "${p}"`;
}

function asObject(settings: unknown): Record<string, unknown> {
  if (settings !== undefined && (typeof settings !== 'object' || settings === null || Array.isArray(settings))) {
    throw new Error('settings.json is not a JSON object');
  }
  return structuredClone((settings ?? {}) as Record<string, unknown>);
}

export function isWrapped(settings: unknown): boolean {
  const sl = (settings as Record<string, unknown> | undefined)?.statusLine as { command?: unknown } | undefined;
  return typeof sl?.command === 'string' && sl.command.includes(STATUSLINE_MARKER);
}

/**
 * Points statusLine at our wrapper. Returns the user's original statusLine (to store in our config) or
 * `keepStored` when already wrapped (the stored original stays authoritative).
 */
export function wrapStatusLine(settings: unknown, command: string): { settings: Record<string, unknown>; original: unknown; alreadyWrapped: boolean } {
  const base = asObject(settings);
  const alreadyWrapped = isWrapped(base);
  const original = alreadyWrapped ? undefined : (base.statusLine ?? null);
  const prev = (base.statusLine && typeof base.statusLine === 'object' ? base.statusLine : {}) as Record<string, unknown>;
  base.statusLine = { ...prev, type: 'command', command };
  return { settings: base, original, alreadyWrapped };
}

/** Restores the stored original statusLine (null/undefined = remove ours). Leaves foreign statusLines alone. */
export function unwrapStatusLine(settings: unknown, original: unknown): { settings: Record<string, unknown>; changed: boolean } {
  const base = asObject(settings);
  if (!isWrapped(base)) return { settings: base, changed: false };
  if (original && typeof original === 'object') base.statusLine = original;
  else delete base.statusLine;
  return { settings: base, changed: true };
}
