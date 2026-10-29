import { spawn } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';

// runTests() spawns with shell:true, which breaks on paths containing spaces (like this repo's),
// so we download via test-electron and launch Code ourselves with an argv array (no shell).
async function main(): Promise<void> {
  const root = path.resolve(__dirname, '..', '..', '..');
  const exe = await downloadAndUnzipVSCode({ cachePath: path.join(root, '.vscode-test') });
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // set when launched from inside VS Code; makes Code.exe act as node
  const tmp = path.join(os.tmpdir(), 'ccc-smoke');
  const args = [
    '--no-sandbox', '--disable-gpu-sandbox', '--disable-updates', '--skip-welcome', '--skip-release-notes',
    '--disable-workspace-trust', '--disable-extensions',
    `--user-data-dir=${path.join(tmp, 'user')}`, `--extensions-dir=${path.join(tmp, 'ext')}`,
    `--extensionDevelopmentPath=${root}`, `--extensionTestsPath=${path.resolve(__dirname, 'suite')}`
  ];
  const code = await new Promise<number>((resolve) => {
    const p = spawn(exe, args, { env, stdio: 'inherit' });
    p.on('exit', (c) => resolve(c ?? 1));
    p.on('error', () => resolve(1));
  });
  if (code !== 0) { console.error(`Smoke test failed with exit code ${code}`); process.exit(1); }
}

void main();
