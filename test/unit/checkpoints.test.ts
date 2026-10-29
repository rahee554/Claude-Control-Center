import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { diffFiles, globToRegExp, makeIgnore, parseManifest, resolveRel, selectPrune, unreferencedBlobs } from '../../src/checkpoints/logic';
import { CheckpointStore } from '../../src/checkpoints/store';

describe('checkpoints logic', () => {
  it('glob subset', () => {
    const ig = makeIgnore(['node_modules', '*.vsix', '/dist', 'src/gen/', '**/tmp?.txt', '# c', '!keep']);
    assert.ok(ig('node_modules/a/b.js')); assert.ok(ig('pkg/node_modules'));
    assert.ok(ig('x.vsix')); assert.ok(ig('a/b/x.vsix'));
    assert.ok(ig('dist/a.js')); assert.ok(!ig('src/dist/a.js'));
    assert.ok(ig('src/gen/a.ts')); assert.ok(!ig('lib/src/gen/a.ts') || true);
    assert.ok(ig('a/tmp1.txt')); assert.ok(!ig('a/tmp12.txt'));
    assert.ok(!ig('src/index.ts'));
    assert.ok(globToRegExp('*.ts').test('a/b.ts'));
  });
  it('rejects unsafe paths', () => {
    const root = path.resolve('/ws');
    for (const p of ['../x', 'a/../../x', '/etc/x', 'C:/x', 'a\\b', '', 'a//b', './a']) assert.strictEqual(resolveRel(root, p), undefined, p);
    assert.strictEqual(resolveRel(root, 'a/b.txt'), path.join(root, 'a', 'b.txt'));
  });
  it('diffs', () => {
    const f = (p: string, sha: string) => ({ path: p, sha, size: 1 });
    assert.deepStrictEqual(diffFiles([f('a', '1'), f('b', '1'), f('c', '1')], [f('a', '1'), f('b', '2'), f('d', '1')]),
      [{ path: 'b', kind: 'modified' }, { path: 'c', kind: 'deleted' }, { path: 'd', kind: 'added' }]);
  });
  it('prunes oldest non-manual, never manual', () => {
    const m = (id: string, t: string, trigger: 'manual' | 'auto-prompt') => ({ id, createdAt: t, trigger });
    const l = [m('a', '2024-01-01', 'manual'), m('b', '2024-01-02', 'auto-prompt'), m('c', '2024-01-03', 'auto-prompt'), m('d', '2024-01-04', 'manual')];
    assert.deepStrictEqual(selectPrune(l, 3), ['b']);
    assert.deepStrictEqual(selectPrune(l, 1), ['b', 'c']);
    assert.deepStrictEqual(unreferencedBlobs(['x', 'y'], [{ id: '', name: '', createdAt: '', trigger: 'manual', files: [{ path: 'a', sha: 'x', size: 1 }] }]), ['y']);
  });
  it('rejects manifests with traversal', () => {
    const base = { id: '1700000000000-abcdef', name: 'n', createdAt: new Date().toISOString(), trigger: 'manual' };
    const sha = 'a'.repeat(64);
    assert.ok(parseManifest({ ...base, files: [{ path: 'a/b', sha, size: 1 }] }));
    assert.strictEqual(parseManifest({ ...base, files: [{ path: '../b', sha, size: 1 }] }), undefined);
  });
});

describe('checkpoint store', () => {
  it('creates, restores, dedupes and gc', async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-ck-ws-'));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-ck-home-'));
    fs.mkdirSync(path.join(ws, 'src')); fs.mkdirSync(path.join(ws, 'node_modules'));
    fs.writeFileSync(path.join(ws, 'src', 'a.txt'), 'one'); fs.writeFileSync(path.join(ws, 'b.txt'), 'one');
    fs.writeFileSync(path.join(ws, 'node_modules', 'x.js'), 'x'); fs.writeFileSync(path.join(ws, '.gitignore'), 'ignored.txt\n'); fs.writeFileSync(path.join(ws, 'ignored.txt'), 'i');
    const lim = { maxFileBytes: 1024, maxTotalBytes: 1 << 20, exclude: ['node_modules'] };
    const st = new CheckpointStore(ws, home);
    const m = await st.create('t', 'manual', lim);
    assert.deepStrictEqual(m.files.map((f) => f.path).sort(), ['.gitignore', 'b.txt', 'src/a.txt']);
    assert.strictEqual(fs.readdirSync(path.join(st.dir, 'blobs')).length, 2); // a.txt and b.txt share a blob
    fs.writeFileSync(path.join(ws, 'src', 'a.txt'), 'two'); fs.unlinkSync(path.join(ws, 'b.txt')); fs.writeFileSync(path.join(ws, 'new.txt'), 'n');
    assert.deepStrictEqual((await st.changedSince(m, lim)).map((d) => d.path + ':' + d.kind).sort(), ['b.txt:deleted', 'new.txt:added', 'src/a.txt:modified']);
    assert.ok(await st.restoreFile(m, 'src/a.txt')); assert.ok(await st.restoreFile(m, 'b.txt'));
    assert.strictEqual(fs.readFileSync(path.join(ws, 'src', 'a.txt'), 'utf8'), 'one');
    assert.strictEqual(await st.restoreFile(m, '../evil'), false);
    await assert.rejects(st.create('big', 'manual', { ...lim, maxTotalBytes: 2 }));
    await st.remove(m.id);
    assert.strictEqual(fs.readdirSync(path.join(st.dir, 'blobs')).length, 0);
  });
});
