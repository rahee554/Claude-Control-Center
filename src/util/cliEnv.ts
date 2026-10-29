// Env for background `claude` calls spawned from the extension host. The host inherits the IDE/Claude
// extension env (CLAUDE_CODE_SSE_PORT, TERM_PROGRAM=vscode, VSCODE_* IPC handles, ...), which makes a
// headless `claude -p` auto-connect to the running IDE and pop UI (e.g. an IDE picker) there. vscode-free.

const DROP = new Set(['CLAUDE_CODE_SSE_PORT', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'ENABLE_IDE_INTEGRATION', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'ELECTRON_RUN_AS_NODE']);

export function cliEnv(base: NodeJS.ProcessEnv = process.env, extra?: Record<string, string>): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    const u = k.toUpperCase();
    if (DROP.has(u) || u.startsWith('VSCODE_')) continue;
    out[k] = v;
  }
  // Verified present in the Claude Code binary: disables IDE auto-connect for this process.
  out.CLAUDE_CODE_AUTO_CONNECT_IDE = 'false';
  return { ...out, ...extra };
}
