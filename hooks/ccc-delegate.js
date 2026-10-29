#!/usr/bin/env node
// Claude Control Center delegate runner: runs one delegated task in its own terminal.
// Usage: node ccc-delegate.js <taskId>   (logic lives in ccc-runner-lib.js, shared with ccc-mcp.js)
'use strict';
const { runTask } = require('./ccc-runner-lib');

const id = process.argv[2] || '';
const c = { dim: '\x1b[2m', cyan: '\x1b[36m', green: '\x1b[32m', red: '\x1b[31m', reset: '\x1b[0m' };
const out = (s) => process.stdout.write(s.replace(/\r?\n/g, '\r\n') + '\r\n');
out(`${c.dim}Delegated task ${id}${c.reset}`);
try {
  runTask(id, {
    text: out,
    tool: (name, hint) => out(`${c.cyan}● ${name}${c.reset} ${c.dim}${hint}${c.reset}`),
    stderr: (s) => out(`${c.red}${s}${c.reset}`)
  }).then((r) => {
    if (r.error && r.state === 'failed') out(`${c.red}${r.error}${c.reset}`);
    out(`\r\n${r.state === 'done' ? c.green + '✔ done' : c.red + '✘ ' + r.state}${c.reset}${r.costUsd !== undefined ? ` · $${r.costUsd.toFixed(4)}` : ''}`);
    out(`${c.dim}(terminal can be closed)${c.reset}`);
  });
} catch (e) { console.error(e.message); process.exit(2); }
