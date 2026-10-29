// Background `claude -p /usage` polls create real Claude sessions. They run in CLI_CWD (or, for older
// versions, the VS Code install dir); such sessions must never be listed. vscode-free.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const CLI_CWD = path.join(os.homedir(), '.claude-control-center', 'cli-cwd');

/** Creates (once) and returns the cwd for background CLI calls. */
export function cliCwd(): string {
  try { fs.mkdirSync(CLI_CWD, { recursive: true }); } catch { /* spawn falls back to inheriting */ }
  return CLI_CWD;
}

const norm = (p: string) => path.resolve(p).toLowerCase();

/** True when cwd is the CLI cwd or the VS Code install dir (or inside them). */
export function isNoiseCwd(cwd: string | undefined, dirs: string[] = [CLI_CWD, path.dirname(process.execPath)]): boolean {
  if (!cwd) return false;
  const c = norm(cwd);
  return dirs.some((d) => { const n = norm(d); return c === n || c.startsWith(n + path.sep); });
}
