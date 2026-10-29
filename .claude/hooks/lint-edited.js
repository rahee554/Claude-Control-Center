// PostToolUse: eslint the edited .ts file; exit 2 feeds errors back to Claude. Never blocks on its own failure.
const { spawnSync } = require('child_process');
const path = require('path');

let raw = '';
process.stdin.on('data', (d) => { if (raw.length < 1e6) raw += d; });
process.stdin.on('end', () => {
  try {
    const p = JSON.parse(raw).tool_input?.file_path;
    const root = path.resolve(__dirname, '..', '..');
    if (typeof p !== 'string' || !/\.ts$/.test(p)) return;
    const rel = path.relative(root, path.resolve(p));
    if (rel.startsWith('..') || !/^(src|test)[\\/]/.test(rel)) return;
    const eslint = path.join(root, 'node_modules', 'eslint', 'bin', 'eslint.js');
    const r = spawnSync(process.execPath, [eslint, rel], { cwd: root, encoding: 'utf8', timeout: 30000 });
    if (r.status === 1) { process.stderr.write(r.stdout.slice(0, 4000)); process.exit(2); }
  } catch { /* never break the session */ }
});
