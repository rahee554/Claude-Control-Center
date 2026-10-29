import * as assert from 'assert';
import * as path from 'path';
import { CLI_CWD, isNoiseCwd } from '../../src/util/noiseSessions';

describe('noiseSessions', () => {
  it('flags the CLI cwd and VS Code install dir, not real projects', () => {
    const vs = path.resolve('/opt/vscode');
    assert.ok(isNoiseCwd(CLI_CWD));
    assert.ok(isNoiseCwd(path.join(vs, 'resources'), [vs]));
    assert.ok(isNoiseCwd(vs.toUpperCase(), [vs]) === (process.platform === 'win32' || true));
    assert.ok(!isNoiseCwd(path.resolve('/work/proj'), [vs]));
    assert.ok(!isNoiseCwd(undefined, [vs]));
  });
});
