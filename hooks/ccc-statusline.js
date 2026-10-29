#!/usr/bin/env node
// Claude Code Control Center status-line wrapper. Dependency-free.
// 1. Reads the status-line JSON from stdin.
// 2. Writes {ts, sessionId, rate_limits, model, context_window, cost} atomically to
//    ~/.claude-control-center/statusline/<sessionId>.json
// 3. Runs the user's original statusLine command (stored by the extension in
//    ~/.claude-control-center/statusline-config.json) with the same stdin and relays its stdout.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const MAX_STDIN = 1024 * 1024;
const HOME = path.join(os.homedir(), '.claude-control-center');
const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function capture(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.session_id !== 'string' || !SESSION_RE.test(raw.session_id)) return;
  const out = { ts: Date.now(), sessionId: raw.session_id, rate_limits: raw.rate_limits && typeof raw.rate_limits === 'object' ? raw.rate_limits : {} };
  if (raw.model && typeof raw.model === 'object') out.model = { id: String(raw.model.id || '').slice(0, 100), display_name: String(raw.model.display_name || '').slice(0, 100) };
  if (raw.context_window && typeof raw.context_window === 'object') {
    const c = raw.context_window;
    out.context_window = { used_percentage: c.used_percentage, context_window_size: c.context_window_size };
  }
  if (raw.cost && typeof raw.cost === 'object' && typeof raw.cost.total_cost_usd === 'number') out.cost = { total_cost_usd: raw.cost.total_cost_usd };
  const dir = path.join(HOME, 'statusline');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${raw.session_id}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(out));
  fs.renameSync(tmp, file);
}

function original() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(HOME, 'statusline-config.json'), 'utf8'));
    const o = cfg && cfg.original;
    if (o && typeof o === 'object' && typeof o.command === 'string' && o.command.trim() && !o.command.includes('ccc-statusline.js')) return o.command;
  } catch { /* none stored */ }
  return undefined;
}

function defaultLine(raw) {
  const parts = [];
  if (raw && raw.model && raw.model.display_name) parts.push(String(raw.model.display_name).slice(0, 40));
  const cw = raw && raw.context_window;
  if (cw && typeof cw.used_percentage === 'number') parts.push(`ctx ${Math.round(cw.used_percentage)}%`);
  const rl = (raw && raw.rate_limits) || {};
  if (rl.five_hour && typeof rl.five_hour.used_percentage === 'number') parts.push(`5h ${Math.round(rl.five_hour.used_percentage)}%`);
  if (rl.seven_day && typeof rl.seven_day.used_percentage === 'number') parts.push(`wk ${Math.round(rl.seven_day.used_percentage)}%`);
  return parts.join(' | ') || 'Claude Code';
}

function run(buf) {
  let raw;
  try { raw = JSON.parse(buf.toString('utf8')); } catch { raw = undefined; }
  try { capture(raw); } catch { /* capture must never break the status line */ }
  const cmd = original();
  if (!cmd) { process.stdout.write(defaultLine(raw) + '\n'); return; }
  // The status line command is a user-authored shell string (that is how Claude Code runs it too),
  // so it runs through the shell; nothing from stdin is interpolated into it.
  const child = spawn(cmd, { shell: true, stdio: ['pipe', 'inherit', 'ignore'], windowsHide: true });
  const kill = setTimeout(() => child.kill(), 5000);
  child.on('error', () => { clearTimeout(kill); process.stdout.write(defaultLine(raw) + '\n'); });
  child.on('exit', () => clearTimeout(kill));
  child.stdin.on('error', () => { /* child may not read stdin */ });
  child.stdin.end(buf);
}

const chunks = [];
let size = 0;
let done = false;
function finish() {
  if (done) return;
  done = true;
  run(size > MAX_STDIN ? Buffer.alloc(0) : Buffer.concat(chunks));
}
process.stdin.on('data', (c) => { size += c.length; if (size <= MAX_STDIN) chunks.push(c); });
process.stdin.on('end', finish);
process.stdin.on('error', finish);
setTimeout(finish, 3000).unref();
