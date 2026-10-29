#!/usr/bin/env node
// Claude Code Control Center hook bridge. Dependency-free; always exits 0 and never blocks Claude.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_STDIN = 12 * 1024 * 1024; // Edit/Write responses carry the original file (baseline capture)
const SUMMARY_KEYS = ['description', 'command', 'pattern', 'path', 'url', 'query', 'subagent_type', 'skill'];
const MIRROR_TOOLS = new Set(['Bash', 'PowerShell']);
const MAX_COMMAND = 4096;
const MAX_LINE = 150 * 1024; // must stay below the extension parser's MAX_LINE (160KB)
const collectPrompts = process.env.CCC_COLLECT_PROMPTS === '1' || process.argv.includes('--collect-prompts');

function str(v, max) {
  return typeof v === 'string' && v.length > 0 ? v.slice(0, max) : undefined;
}

function oneLine(s, max) {
  return s.replace(/\s+/g, ' ').trim().slice(0, max);
}

function summarizeTool(input) {
  if (!input || typeof input !== 'object') return undefined;
  for (const k of SUMMARY_KEYS) {
    if (typeof input[k] === 'string' && input[k]) return `${k}: ${oneLine(input[k], 120)}`;
  }
  return undefined;
}

function sanitize(raw) {
  const ev = str(raw.hook_event_name, 64);
  const sessionId = str(raw.session_id, 128);
  if (!ev || !sessionId) return undefined;
  const out = { v: 1, ts: new Date().toISOString(), event: ev, sessionId };
  const agentId = str(raw.agent_id, 128);
  if (agentId) out.agentId = agentId;
  const agentType = str(raw.agent_type, 128) || (raw.tool_input && str(raw.tool_input.subagent_type, 128));
  if (agentType) out.agentType = agentType;
  const toolName = str(raw.tool_name, 128);
  if (toolName) out.toolName = toolName;
  const toolUseId = str(raw.tool_use_id, 128);
  if (toolUseId) out.toolUseId = toolUseId;
  const input = raw.tool_input && typeof raw.tool_input === 'object' ? raw.tool_input : undefined;
  const filePath = input && (str(input.file_path, 1024) || str(input.notebook_path, 1024));
  if (filePath) out.filePath = filePath;
  let summary = summarizeTool(input);
  if (ev === 'UserPromptSubmit') summary = collectPrompts && typeof raw.prompt === 'string' ? oneLine(raw.prompt, 200) : undefined;
  if (ev === 'Notification' && typeof raw.message === 'string') summary = oneLine(raw.message, 160);
  if (ev === 'SessionStart' && typeof raw.source === 'string') summary = `source: ${oneLine(raw.source, 32)}`;
  if (ev === 'SessionEnd' && typeof raw.reason === 'string') summary = `reason: ${oneLine(raw.reason, 64)}`;
  if (summary) out.summary = summary;
  const resp = raw.tool_response;
  if ((resp && typeof resp === 'object' && resp.is_error === true) || typeof raw.error === 'string') out.isError = true;
  const cwd = str(raw.cwd, 1024);
  if (cwd) out.cwd = cwd;
  const tp = str(raw.transcript_path, 1024);
  if (tp) out.transcriptPath = tp;
  out.pid = process.ppid;
  addShell(out, raw, ev);
  return out;
}

function mirrorConfig() {
  // Written atomically by the extension when settings change. Defaults: include output, 64KB.
  let c = {};
  try { c = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude-control-center', 'config.json'), 'utf8')) || {}; } catch { /* defaults */ }
  const kb = Number.isFinite(c.maxOutputKB) ? Math.min(Math.max(c.maxOutputKB, 1), 128) : 64;
  return { output: c.mirrorOutput !== false, maxChars: kb * 1024 };
}

function cut(s, max) {
  return s.length > max ? `${s.slice(0, max)}
…[truncated ${s.length - max} chars]` : s;
}

/** Adds command/output fields for shell tools (Bash/PowerShell) so the extension can mirror them. */
function addShell(out, raw, ev) {
  if (!out.toolName || !MIRROR_TOOLS.has(out.toolName)) return;
  const input = raw.tool_input && typeof raw.tool_input === 'object' ? raw.tool_input : {};
  if (ev === 'PreToolUse') {
    const cmd = str(input.command, MAX_COMMAND);
    if (cmd) out.command = cmd;
    const d = str(input.description, 400);
    if (d) out.description = d;
    if (input.run_in_background === true) out.runInBackground = true;
    return;
  }
  if (ev !== 'PostToolUse' && ev !== 'PostToolUseFailure') return;
  const resp = raw.tool_response && typeof raw.tool_response === 'object' ? raw.tool_response : {};
  if (resp.interrupted === true) out.interrupted = true;
  const bg = str(resp.backgroundTaskId, 128);
  if (bg) out.backgroundTaskId = bg;
  for (const k of ['exitCode', 'exit_code', 'returnCode']) {
    if (Number.isInteger(resp[k])) { out.exitCode = resp[k]; break; }
  }
  const cfg = mirrorConfig();
  if (!cfg.output) return;
  let stdout = typeof resp.stdout === 'string' ? resp.stdout : (typeof raw.tool_response === 'string' ? raw.tool_response : '');
  let stderr = typeof resp.stderr === 'string' ? resp.stderr : (typeof raw.error === 'string' ? raw.error : '');
  let budget = cfg.maxChars;
  for (;;) {
    const so = cut(stdout, budget);
    const se = cut(stderr, Math.max(budget - Math.min(stdout.length, budget), 1024));
    if (so) out.stdout = so; else delete out.stdout;
    if (se) out.stderr = se; else delete out.stderr;
    if (JSON.stringify(out).length <= MAX_LINE || budget < 1024) break;
    budget = Math.floor(budget / 2); // JSON escaping can inflate; shrink until the line fits
  }
  if (JSON.stringify(out).length > MAX_LINE) { delete out.stdout; delete out.stderr; }
}

function eventsDir() {
  return path.join(os.homedir(), '.claude-control-center', 'events');
}

function handle(text) {
  let raw;
  try { raw = JSON.parse(text); } catch { return; }
  if (!raw || typeof raw !== 'object') return;
  const ev = sanitize(raw);
  if (!ev) return;
  const dir = eventsDir();
  fs.mkdirSync(dir, { recursive: true });
  const name = ev.sessionId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128) || 'unknown';
  fs.appendFileSync(path.join(dir, `${name}.jsonl`), JSON.stringify(ev) + '\n');
  try { saveBaseline(raw, ev); } catch { /* best effort */ }
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const MAX_BASELINE = 5 * 1024 * 1024;
/**
 * First edit of a file in a session: keep its pre-edit content (tool_response.originalFile) so the extension
 * can diff/undo edits whose transcript has no file-history backup (subagents). Created files get a marker.
 */
function saveBaseline(raw, ev) {
  if (ev.event !== 'PostToolUse' || !EDIT_TOOLS.has(ev.toolName) || !ev.filePath || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(ev.sessionId)) return;
  const resp = raw.tool_response && typeof raw.tool_response === 'object' ? raw.tool_response : undefined;
  if (!resp) return;
  const filePath = typeof resp.filePath === 'string' ? resp.filePath : ev.filePath;
  const h = require('crypto').createHash('sha1').update(filePath).digest('hex');
  const dir = path.join(os.homedir(), '.claude-control-center', 'baselines', ev.sessionId);
  const file = path.join(dir, h);
  if (fs.existsSync(file) || fs.existsSync(`${file}.created`)) return;
  if (typeof resp.originalFile === 'string') {
    if (Buffer.byteLength(resp.originalFile) > MAX_BASELINE) return;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${file}.tmp`, resp.originalFile, { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
  } else if (resp.type === 'create' || resp.originalFile === null) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${file}.created`, '', { mode: 0o600 });
  }
}

let chunks = [];
let size = 0;
let done = false;
function finish() {
  if (done) return;
  done = true;
  try { handle(Buffer.concat(chunks).toString('utf8')); } catch { /* never fail the hook */ }
  process.exit(0);
}
process.stdin.on('data', (c) => {
  size += c.length;
  if (size > MAX_STDIN) { chunks = []; finish(); return; }
  chunks.push(c);
});
process.stdin.on('end', finish);
process.stdin.on('error', finish);
setTimeout(finish, 3000).unref();
