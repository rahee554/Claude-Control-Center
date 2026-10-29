// Pure rendering of Claude's shell tool calls into ANSI text for a read-only mirror pseudoterminal. No vscode import.
import { CccEvent, eventTime } from '../models/events';

export const MIRROR_TOOLS = new Set(['Bash', 'PowerShell']);

const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';

/**
 * Makes untrusted text safe for a pty: drops OSC (title, clipboard OSC 52, hyperlinks), DCS/SOS/PM/APC strings
 * and their 8-bit C1 forms, keeps SGR/CSI so colors still render, and normalizes newlines to \r\n.
 */
export function sanitizeForPty(s: string): string {
  return s
    .replace(/(?:\x1b[\]PX^_]|[\x90\x98\x9d\x9e\x9f])[\s\S]*?(?:\x07|\x1b\\|\x9c|$)/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f]/g, '')
    .replace(/\r?\n/g, '\r\n');
}

function time(ms: number): string {
  return new Date(ms).toLocaleTimeString();
}

export function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

export function mirrorBanner(sessionId: string, cwd?: string): string {
  return sanitizeForPty(`${CYAN}Claude Code command mirror${RESET} ${DIM}· session ${sessionId}${cwd ? ` · ${cwd}` : ''}${RESET}\n`
    + `${DIM}Read-only view of the Bash/PowerShell commands Claude runs (they execute in Claude's own hidden processes).\n`
    + `Closing this terminal only closes the mirror; it does not stop Claude or any command.${RESET}\n\n`);
}

/** Pairs PreToolUse/PostToolUse by toolUseId and returns the text to write for each event (undefined = nothing). */
export class MirrorFormatter {
  private readonly pending = new Map<string, number>();

  render(e: CccEvent): string | undefined {
    if (!e.toolName || !MIRROR_TOOLS.has(e.toolName)) return undefined;
    const prefix = e.agentId ? `${DIM}[${e.agentType ?? 'subagent'}]${RESET} ` : '';
    if (e.event === 'PreToolUse') {
      if (e.toolUseId) {
        this.pending.set(e.toolUseId, eventTime(e));
        if (this.pending.size > 500) this.pending.delete(this.pending.keys().next().value as string);
      }
      let out = `${prefix}${DIM}${time(eventTime(e))} ${e.toolName}${e.runInBackground ? ' (background)' : ''}${RESET}\n`;
      if (e.description) out += `${DIM}# ${e.description}${RESET}\n`;
      out += `${YELLOW}$${RESET} ${e.command ?? '(command not recorded)'}\n${DIM}running…${RESET}\n`;
      return sanitizeForPty(out);
    }
    if (e.event !== 'PostToolUse' && e.event !== 'PostToolUseFailure') return undefined;
    const started = e.toolUseId ? this.pending.get(e.toolUseId) : undefined;
    if (e.toolUseId) this.pending.delete(e.toolUseId);
    let out = '';
    if (e.stdout) out += e.stdout.endsWith('\n') ? e.stdout : `${e.stdout}\n`;
    if (e.stderr) out += `${RED}${e.stderr}${RESET}${e.stderr.endsWith('\n') ? '' : '\n'}`;
    const dur = started !== undefined ? ` ${formatDuration(Math.max(0, eventTime(e) - started))}` : '';
    const failed = e.isError || e.event === 'PostToolUseFailure' || (e.exitCode !== undefined && e.exitCode !== 0);
    let footer: string;
    if (e.backgroundTaskId) footer = `${CYAN}↗ running in background (${e.backgroundTaskId})${RESET}`;
    else if (e.interrupted) footer = `${YELLOW}■ interrupted${dur}${RESET}`;
    else if (failed) footer = `${RED}✗ error${e.exitCode !== undefined ? ` (exit ${e.exitCode})` : ''}${dur}${RESET}`;
    else footer = `${GREEN}✓ done${dur}${RESET}`;
    return sanitizeForPty(`${out}${prefix}${footer}\n\n`);
  }
}
