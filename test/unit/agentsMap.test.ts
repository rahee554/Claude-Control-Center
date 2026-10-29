import * as assert from 'assert';
import { layoutMap, NODE_H, NODE_W } from '../../src/views/agentsMap';

describe('layoutMap', () => {
  const input = [{ id: 's' }, { id: 'a', parent: 's' }, { id: 'b', parent: 's' }, { id: 't', parent: 's' }, { id: 'c', parent: 'a' }, { id: 'o', parent: 'missing' }];
  it('is deterministic and places children right of parents', () => {
    const l = layoutMap(input);
    assert.deepStrictEqual(layoutMap(input), l);
    const p = new Map(l.nodes.map((n) => [n.id, n]));
    assert.strictEqual(p.size, 6);
    assert.ok(p.get('a')!.x > p.get('s')!.x && p.get('c')!.x > p.get('a')!.x);
    assert.strictEqual(l.edges.length, 4);
  });
  it('never overlaps', () => {
    const ns = layoutMap(input).nodes;
    for (const a of ns) for (const b of ns) if (a.id < b.id) {
      assert.ok(Math.abs(a.x - b.x) >= NODE_W || Math.abs(a.y - b.y) >= NODE_H, `${a.id}/${b.id}`);
    }
  });
  it('survives duplicates and cycles', () => {
    const l = layoutMap([{ id: 'x', parent: 'y' }, { id: 'y', parent: 'x' }, { id: 'x' }]);
    assert.ok(l.nodes.length <= 2);
  });
});
