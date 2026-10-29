// Shared delegate runner used by ccc-delegate.js (terminal) and ccc-mcp.js (headless).
// Spawns claude with an argv array (shell:false), pipes prompt.txt to stdin, parses stream-json,
// writes status.json / result.json / result.md in the task dir. No dependencies.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const CCC_HOME = () => path.join(os.homedir(), '.claude-control-center');
const TASKS_DIR = () => path.join(CCC_HOME(), 'tasks');
const PRESET_TOOLS = {
  readonly: ['Read', 'Glob', 'Grep'],
  edit: ['Read', 'Glob', 'Grep', 'Edit', 'Write'],
  bash: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'],
  // MCP-only ("all capabilities"); gated by ccc.delegate.allowRunFromMcp / allowFullFromMcp.
  full: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'TodoWrite', 'NotebookEdit']
};
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODELS = ['haiku', 'sonnet', 'opus'];

/**
 * Same argv as src/accounts/model.ts buildClaudeArgs, plus MCP extras. The prompt is never in argv.
 * extra.resume: a session UUID; extra.appendSystemPrompt: one `--flag=value` token so it is never read as a flag.
 */
function buildArgs(preset, model, settingsFile, extra = {}) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--allowedTools', PRESET_TOOLS[preset].join(',')];
  if (model && MODELS.includes(model)) args.push('--model', model);
  if (settingsFile) args.push('--settings', settingsFile);
  if (extra.resume) {
    if (!SESSION_ID.test(extra.resume)) throw new Error('invalid session id');
    args.push('--resume', extra.resume);
  }
  if (extra.appendSystemPrompt) args.push(`--append-system-prompt=${extra.appendSystemPrompt}`);
  return args;
}

function taskDir(id) {
  if (!/^[a-z0-9]{1,32}$/.test(String(id))) throw new Error('invalid task id');
  return path.join(TASKS_DIR(), id);
}

/**
 * Runs task <id>. cb: {text(s), tool(name, hint), stderr(s)} for live display.
 * Resolves {state, text, costUsd, durationMs, filesChanged, error}.
 */
function runTask(id, cb = {}) {
  const dir = taskDir(id);
  const task = JSON.parse(fs.readFileSync(path.join(dir, 'task.json'), 'utf8'));
  if (!Array.isArray(task.args) || task.args.includes('--dangerously-skip-permissions')) throw new Error('invalid task');
  const statusFile = path.join(dir, 'status.json');
  let status = { state: 'running', startedAt: Date.now() };
  const writeStatus = (patch) => {
    status = { ...status, ...patch };
    const tmp = `${statusFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(status));
    fs.renameSync(tmp, statusFile);
  };
  const env = { ...process.env, ...(task.env || {}) };
  delete env.ELECTRON_RUN_AS_NODE;
  return new Promise((resolve) => {
    const child = spawn(task.exe, task.args, { cwd: task.cwd, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    writeStatus({ pid: child.pid, runnerPid: process.pid });
    fs.createReadStream(path.join(dir, 'prompt.txt')).pipe(child.stdin);
    let result;
    let buf = '';
    const texts = [];
    const files = new Set();
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const ln = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!ln) continue;
        let m; try { m = JSON.parse(ln); } catch { cb.text && cb.text(ln); continue; }
        if (m.type === 'assistant' && m.message && Array.isArray(m.message.content)) {
          for (const b of m.message.content) {
            if (b.type === 'text' && b.text) { texts.push(b.text); cb.text && cb.text(b.text); }
            if (b.type === 'tool_use') {
              const inp = b.input || {};
              if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(b.name) && inp.file_path) files.add(String(inp.file_path));
              cb.tool && cb.tool(b.name, String(inp.file_path || inp.pattern || inp.command || inp.path || '').slice(0, 160));
            }
          }
        } else if (m.type === 'system' && m.subtype === 'init' && SESSION_ID.test(String(m.session_id || ''))) writeStatus({ sessionId: m.session_id });
        else if (m.type === 'result') result = m;
      }
    });
    child.stderr.on('data', (d) => cb.stderr && cb.stderr(String(d).trimEnd()));
    let done = false;
    const finish = (code, signal, err) => {
      if (done) return; done = true;
      const ok = !err && code === 0 && result && !result.is_error;
      const costUsd = result && typeof result.total_cost_usd === 'number' ? result.total_cost_usd : undefined;
      const text = (result && typeof result.result === 'string' && result.result) || texts.join('\n\n');
      try {
        fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ ...(result || { code, signal }), filesChanged: [...files] }, null, 2));
        fs.writeFileSync(path.join(dir, 'result.md'), `# Delegated task ${id}\n\n${text || '_No result text._'}\n`);
      } catch { /* status still written */ }
      const state = fs.existsSync(path.join(dir, 'cancel')) ? 'cancelled' : ok ? 'done' : 'failed';
      const error = ok ? undefined : err ? err.message : signal ? `signal ${signal}` : `exit ${code}`;
      const u = (result && result.usage) || {};
      const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
      const sid = result && SESSION_ID.test(String(result.session_id || '')) ? result.session_id : undefined;
      writeStatus({ state, endedAt: Date.now(), costUsd, error, inputTokens: n(u.input_tokens), outputTokens: n(u.output_tokens), ...(sid ? { sessionId: sid } : {}) });
      resolve({ state, text, costUsd, durationMs: status.endedAt - status.startedAt, filesChanged: [...files], error });
    };
    child.on('error', (e) => finish(null, null, e));
    child.on('close', (code, signal) => finish(code, signal));
  });
}

module.exports = { CCC_HOME, TASKS_DIR, PRESET_TOOLS, SESSION_ID, buildArgs, taskDir, runTask };
