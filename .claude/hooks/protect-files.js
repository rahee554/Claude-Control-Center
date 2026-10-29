// PreToolUse: block edits to generated/vendored files and to the official Claude Code extension.
let raw = '';
process.stdin.on('data', (d) => { if (raw.length < 1e6) raw += d; });
process.stdin.on('end', () => {
  try {
    const p = String(JSON.parse(raw).tool_input?.file_path ?? '').replace(/\\/g, '/');
    const blocked = [/\/package-lock\.json$/, /\/(dist|out|node_modules)\//, /anthropic\.claude-code-/, /\.vsix$/];
    if (blocked.some((re) => re.test(p))) {
      process.stderr.write(`Blocked: ${p} is generated, vendored, or belongs to the official Claude Code extension. Edit sources instead.`);
      process.exit(2);
    }
  } catch { /* allow on parse failure */ }
});
