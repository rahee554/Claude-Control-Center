#!/usr/bin/env node
// Claude Control Center MCP server (stdio, JSON-RPC 2.0, newline-delimited). No dependencies.
// Lets the main Claude agent delegate standalone tasks to sub-accounts and get the result back.
// Reads ~/.claude-control-center/accounts.json (written by the extension; no secrets).
'use strict';
const fs = require('fs');
const path = require('path');
const lib = require('./ccc-runner-lib');

const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const PRESET_MAP = { read: 'readonly', edit: 'edit', run: 'bash', full: 'full' };
const CONTEXT_MAX = 200 * 1024;

function readConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(lib.CCC_HOME(), 'accounts.json'), 'utf8')); } catch { return { accounts: [], workspaces: [] }; }
}
function alive(pid) { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } }
function runningCount() {
  let n = 0;
  let ids = [];
  try { ids = fs.readdirSync(lib.TASKS_DIR()); } catch { /* none */ }
  for (const id of ids) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(lib.TASKS_DIR(), id, 'status.json'), 'utf8'));
      if (s.state === 'running' && alive(s.pid)) n++;
    } catch { /* not started */ }
  }
  return n;
}
function inside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

const MODEL_NAMES = ['haiku', 'sonnet', 'opus'];
/** heavy = explicit weight, else preset full/run or a prompt over 4k chars; otherwise light. */
function classify(args, presetKey) {
  if (args.weight) return args.weight;
  return presetKey === 'full' || presetKey === 'run' || String(args.prompt).length > 4000 ? 'heavy' : 'light';
}

/** Validates delegate_task args against accounts.json. Throws Error with a user-facing message. */
function validateDelegate(args, cfg, running) {
  const s = cfg.settings || {};
  if (typeof args.prompt !== 'string' || !args.prompt.trim()) throw new Error('prompt is required');
  // allowFullFromMcp is the newer name; allowRunFromMcp (ccc.delegate.allowRunFromMcp) still enables run + full.
  const allowFull = !!(s.allowFullFromMcp ?? s.allowRunFromMcp);
  const presetKey = args.preset === undefined ? 'read' : args.preset;
  const preset = PRESET_MAP[presetKey];
  if (!preset) throw new Error(`preset must be one of: read, edit${allowFull ? ', run, full' : ''}`);
  if ((presetKey === 'run' || presetKey === 'full') && !allowFull) throw new Error(`preset '${presetKey}' is disabled (setting ccc.delegate.allowRunFromMcp)`);
  if (args.appendSystemPrompt !== undefined && (typeof args.appendSystemPrompt !== 'string' || args.appendSystemPrompt.length > 20000)) throw new Error('appendSystemPrompt must be a string of at most 20000 characters');
  let prior;
  if (args.resumeTaskId !== undefined) {
    prior = priorTask(String(args.resumeTaskId));
    if (args.account === undefined) args = { ...args, account: prior.accountId };
    if (args.cwd === undefined) args = { ...args, cwd: prior.cwd };
  }
  if (args.model !== undefined && !['default', 'haiku', 'sonnet', 'opus'].includes(args.model)) throw new Error('model must be default, haiku, sonnet or opus');
  const eligible = (a) => a.enabled && a.loggedIn && (a.role === 'sub' || s.allowMainFromMcp);
  const accounts = cfg.accounts || [];
  let account;
  if (args.weight !== undefined && !['heavy', 'light'].includes(args.weight)) throw new Error('weight must be heavy or light');
  const weight = classify(args, presetKey);
  const routing = s.routing || {};
  const routed = typeof routing[weight] === 'string' && routing[weight] ? routing[weight] : 'auto';
  const mainAcc = accounts.find((a) => a.role === 'main');
  const want = args.account !== undefined ? String(args.account) : routed === 'main' ? (mainAcc ? mainAcc.id : 'auto') : routed;
  if (want === 'auto') {
    const def = accounts.find((a) => a.id === cfg.defaultAccountId);
    account = def && def.role === 'sub' && eligible(def) && (def.fiveHour || 0) < 90 ? def
      : accounts.filter((a) => a.role === 'sub' && eligible(a) && (a.fiveHour || 0) < 90).sort((a, b) => (a.fiveHour ?? 99) - (b.fiveHour ?? 99))[0];
    if (!account) throw new Error('no enabled, logged-in sub-account under 90% 5h usage');
  } else {
    account = accounts.find((a) => a.id === want) || accounts.find((a) => a.label.toLowerCase() === want.toLowerCase());
    if (!account) throw new Error(`unknown account: ${want}`);
    if (prior && account.id !== prior.accountId) throw new Error('resumeTaskId must continue on the same account as the original task');
    if (account.role === 'main' && !s.allowMainFromMcp) throw new Error('delegating to the main account is disabled (setting ccc.delegate.allowMainFromMcp)');
    if (!account.enabled) throw new Error(`account ${account.label} is disabled`);
    if (!account.loggedIn) throw new Error(`account ${account.label} is not logged in`);
  }
  const workspaces = (cfg.workspaces || []).map((w) => path.resolve(w));
  if (!workspaces.length) throw new Error('no workspace folders listed in accounts.json (open a folder in VS Code)');
  const cwd = path.resolve(args.cwd ? String(args.cwd) : workspaces[0]);
  const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  if (!workspaces.some((w) => inside(norm(cwd), norm(w)))) throw new Error(`cwd must be inside a workspace folder: ${workspaces.join(', ')}`);
  if (!fs.existsSync(cwd)) throw new Error(`cwd does not exist: ${cwd}`);
  if (prior && norm(path.resolve(prior.cwd)) !== norm(cwd)) throw new Error('resumeTaskId must use the same cwd as the original task');
  const context = readContextFiles(args.contextFiles, cwd, workspaces, norm);
  const max = s.maxConcurrent || 2;
  if (running >= max) throw new Error(`${max} delegated task(s) already running (ccc.delegate.maxConcurrent)`);
  if (!cfg.exe) throw new Error('Claude Code CLI path unknown (open VS Code with the extension once)');
  const timeoutSec = Math.min(Math.max(Number(args.timeoutSec) || 600, 10), 3600);
  const routedModel = routing[weight + 'Model'];
  const model = args.model !== undefined ? args.model : MODEL_NAMES.includes(routedModel) ? routedModel : undefined;
  return {
    account, preset, weight, model: model === 'default' ? undefined : model, cwd, wait: args.wait !== false, timeoutSec, exe: cfg.exe,
    context, resume: prior && prior.sessionId, appendSystemPrompt: args.appendSystemPrompt || undefined
  };
}

/** {accountId, cwd, sessionId} of a finished earlier task, for --resume. */
function priorTask(id) {
  const dir = lib.taskDir(id);
  let task, res;
  try { task = JSON.parse(fs.readFileSync(path.join(dir, 'task.json'), 'utf8')); } catch { throw new Error(`unknown task: ${id}`); }
  try { res = JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8')); } catch { throw new Error(`task ${id} has no result yet`); }
  if (!lib.SESSION_ID.test(String(res.session_id || ''))) throw new Error(`task ${id} has no session to resume`);
  return { accountId: task.meta.accountId, cwd: task.cwd, sessionId: res.session_id };
}

/** Reads contextFiles (relative to the workspace folder holding cwd, or absolute; inside a workspace folder), at most 200KB in total. */
function readContextFiles(files, cwd, workspaces, norm) {
  if (files === undefined) return '';
  if (!Array.isArray(files) || files.length > 50 || files.some((f) => typeof f !== 'string' || !f)) throw new Error('contextFiles must be an array of up to 50 paths');
  let total = 0;
  return files.map((f) => {
    const root = workspaces.find((w) => inside(norm(cwd), norm(w))) || cwd;
    const p = path.resolve(root, f);
    if (!workspaces.some((w) => inside(norm(p), norm(w)))) throw new Error(`context file outside the workspace: ${f}`);
    let text;
    try { text = fs.readFileSync(p, 'utf8'); } catch { throw new Error(`cannot read context file: ${f}`); }
    total += Buffer.byteLength(text);
    if (total > CONTEXT_MAX) throw new Error('contextFiles exceed 200KB in total');
    return `<context_file path="${path.relative(root, p).split(path.sep).join('/')}">\n${text}\n</context_file>\n\n`;
  }).join('');
}

function createTask(v, prompt) {
  const id = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const dir = lib.taskDir(id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'prompt.txt'), v.context + prompt, { encoding: 'utf8', mode: 0o600 });
  const meta = { id, resumed: v.resume, accountId: v.account.id, accountLabel: v.account.label, preset: v.preset, model: v.model, cwd: v.cwd, title: `[MCP] ${prompt.split('\n')[0]}`.slice(0, 80), createdAt: Date.now(), source: 'mcp' };
  const env = v.account.configDir ? { CLAUDE_CONFIG_DIR: v.account.configDir } : {};
  fs.writeFileSync(path.join(dir, 'task.json'), JSON.stringify({ exe: v.exe, args: lib.buildArgs(v.preset, v.model, undefined, { resume: v.resume, appendSystemPrompt: v.appendSystemPrompt }), cwd: v.cwd, env, meta }));
  return id;
}

function taskResult(id) {
  const dir = lib.taskDir(id);
  const read = (f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return undefined; } };
  const meta = (read('task.json') || {}).meta;
  if (!meta) throw new Error(`unknown task: ${id}`);
  const st = read('status.json') || { state: 'running' };
  const res = read('result.json') || {};
  let text = '';
  try { text = fs.readFileSync(path.join(dir, 'result.md'), 'utf8').replace(/^# Delegated task \S+\n\n/, '').trim(); } catch { /* running */ }
  return {
    taskId: id, state: st.state, account: meta.accountLabel, sessionId: res.session_id || st.sessionId, inputTokens: st.inputTokens, outputTokens: st.outputTokens, result: text || undefined, costUsd: st.costUsd,
    durationMs: st.endedAt && st.startedAt ? st.endedAt - st.startedAt : undefined, filesChanged: res.filesChanged, error: st.error
  };
}

const TOOLS = [
  { name: 'list_accounts', description: 'List Claude Control Center accounts (id, label, role, enabled, loggedIn, cached 5h/weekly usage %).', inputSchema: { type: 'object', properties: {} } },
  {
    name: 'delegate_task',
    description: 'Run a task on another Claude account (separate subscription limits) and return its final answer. ' +
      'Delegate when the task is standalone and needs little of this chat: summarise/search/review files, write a self-contained module or test, research a question. ' +
      'Do not delegate work that depends on decisions or state only this conversation holds. ' +
      'The delegate has NO context from this chat: state the goal, relevant paths, constraints and the expected output format in the prompt, ' +
      'and pass key files as contextFiles instead of pasting them. Continue the same delegate session with resumeTaskId.',
    inputSchema: {
      type: 'object', required: ['prompt'],
      properties: {
        prompt: { type: 'string', description: 'Self-contained task: goal, relevant paths, constraints, expected output format.' },
        account: { type: 'string', description: "'auto' (default), account id, or label." },
        preset: { type: 'string', enum: ['read', 'edit', 'run', 'full'], description: 'read (default): Read/Glob/Grep. edit: + Edit/Write. run: + Bash. full: + WebFetch/WebSearch/Task/Agent/TodoWrite/NotebookEdit. run and full only if ccc.delegate.allowRunFromMcp is on.' },
        contextFiles: { type: 'array', items: { type: 'string' }, description: 'Files (relative to the workspace folder, 200KB total) prepended to the prompt.' },
        appendSystemPrompt: { type: 'string', description: 'Extra system-prompt text for the delegate (role, style).' },
        resumeTaskId: { type: 'string', description: 'taskId of an earlier finished task: continue its session (same account and cwd) for a follow-up turn.' },
        model: { type: 'string', enum: ['default', 'haiku', 'sonnet', 'opus'], description: 'Default comes from the workload routing settings (heavy/light).' },
        weight: { type: 'string', enum: ['heavy', 'light'], description: "Workload weight (default light; preset run/full or a prompt over 4000 chars counts as heavy). Picks the account and model from the user's routing settings." },
        cwd: { type: 'string', description: 'Working dir; must be inside an open VS Code workspace folder. Default: first workspace folder.' },
        wait: { type: 'boolean', description: 'Wait for the result (default true). false returns a taskId for get_task_result.' },
        timeoutSec: { type: 'number', description: 'Default 600. The task is cancelled when exceeded (wait=true).' }
      }
    }
  },
  { name: 'get_task_result', description: 'Get state/result of a delegated task.', inputSchema: { type: 'object', required: ['taskId'], properties: { taskId: { type: 'string' } } } }
];

async function callTool(name, args) {
  if (name === 'list_accounts') {
    return (readConfig().accounts || []).map((a) => ({ id: a.id, label: a.label, role: a.role, enabled: a.enabled, loggedIn: a.loggedIn, email: a.email, plan: a.plan, fiveHourPct: a.fiveHour, weeklyPct: a.weekly }));
  }
  if (name === 'get_task_result') return taskResult(String(args.taskId || ''));
  if (name === 'delegate_task') {
    try { if (JSON.parse(fs.readFileSync(path.join(lib.CCC_HOME(), 'config.json'), 'utf8')).delegation === false) throw new Error('Delegation is turned off in Claude Control Center'); } catch (e) { if (e instanceof Error && e.message.startsWith('Delegation')) throw e; }
    const v = validateDelegate(args, readConfig(), runningCount());
    const id = createTask(v, args.prompt);
    const run = lib.runTask(id);
    if (!v.wait) { run.catch(() => undefined); return { taskId: id, state: 'running', account: v.account.label }; }
    let timer;
    const timedOut = new Promise((r) => { timer = setTimeout(() => r('timeout'), v.timeoutSec * 1000); });
    if (await Promise.race([run, timedOut]) === 'timeout') {
      fs.writeFileSync(path.join(lib.taskDir(id), 'cancel'), '');
      try { const st = JSON.parse(fs.readFileSync(path.join(lib.taskDir(id), 'status.json'), 'utf8')); if (alive(st.pid)) process.kill(st.pid); } catch { /* gone */ }
      await run;
    }
    clearTimeout(timer);
    return taskResult(id);
  }
  throw new Error(`unknown tool: ${name}`);
}

async function handle(msg) {
  const { id, method, params = {} } = msg;
  switch (method) {
    case 'initialize': {
      const v = VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : VERSIONS[0];
      return { protocolVersion: v, capabilities: { tools: {} }, serverInfo: { name: 'ccc-accounts', version: '0.1.0' } };
    }
    case 'ping': return {};
    case 'tools/list': return { tools: TOOLS };
    case 'tools/call':
      try {
        const r = await callTool(params.name, params.arguments || {});
        return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
      }
    default:
      if (id === undefined) return undefined; // notification (e.g. notifications/initialized)
      throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
  }
}

function main() {
  const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const ln = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!ln) continue;
      let msg;
      try { msg = JSON.parse(ln); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
      const isRequest = msg.id !== undefined && msg.id !== null;
      handle(msg).then((result) => { if (isRequest) send({ jsonrpc: '2.0', id: msg.id, result }); },
        (e) => { if (isRequest) send({ jsonrpc: '2.0', id: msg.id, error: { code: e.code || -32603, message: e.message } }); });
    }
  });
  process.stdin.on('end', () => { /* let running tasks finish, then exit */ });
}

if (require.main === module) main();
module.exports = { validateDelegate, handle, VERSIONS };
