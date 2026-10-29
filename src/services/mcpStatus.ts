// Is the ccc-accounts MCP server registered with Claude Code? Runs `claude mcp get` (fixed args) once per 60s. vscode-free.
import { execFile } from 'child_process';
import { cliEnv } from '../util/cliEnv';
import { cliCwd } from '../util/noiseSessions';

let cache: { at: number; ok: boolean } | undefined;
let inflight = false;

export function mcpRegistered(claudePath: string, name = 'ccc-accounts', now = Date.now()): boolean | undefined {
  if (cache && now - cache.at < 60_000) return cache.ok;
  if (!inflight && /^[\w .:\/()-]+$/.test(claudePath) && !/["&|<>^%]/.test(claudePath)) {
    inflight = true;
    const win = process.platform === 'win32';
    const [file, args] = win ? ['cmd.exe', ['/d', '/s', '/c', claudePath, 'mcp', 'get', name]] : [claudePath, ['mcp', 'get', name]];
    execFile(file, args, { cwd: cliCwd(), timeout: 20_000, windowsHide: true, maxBuffer: 64 * 1024, env: cliEnv() }, (err) => {
      inflight = false; cache = { at: Date.now(), ok: !err };
    }).stdin?.end();
  }
  return cache?.ok;
}
export function invalidateMcp(): void { cache = undefined; }
