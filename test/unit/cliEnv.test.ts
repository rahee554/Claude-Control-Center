import * as assert from 'assert';
import { cliEnv } from '../../src/util/cliEnv';

describe('cliEnv', () => {
  it('drops IDE/extension-host vars, disables IDE auto-connect, keeps the rest', () => {
    const env = cliEnv({
      PATH: '/bin', HOME: '/h', CLAUDE_CODE_SSE_PORT: '1234', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'claude-vscode',
      ENABLE_IDE_INTEGRATION: 'true', TERM_PROGRAM: 'vscode', VSCODE_IPC_HOOK_CLI: 'x', vscode_git_askpass_node: 'y'
    }, { CLAUDE_CONFIG_DIR: '/acct' });
    assert.deepStrictEqual(env, { PATH: '/bin', HOME: '/h', CLAUDE_CODE_AUTO_CONNECT_IDE: 'false', CLAUDE_CONFIG_DIR: '/acct' });
  });
});
