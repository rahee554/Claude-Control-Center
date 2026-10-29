/** Pure, vscode-free layout for the agents workflow map. Deterministic, no overlap. */
export interface MapIn { id: string; parent?: string }
export interface MapPos { id: string; depth: number; x: number; y: number }
export interface MapLayout { nodes: MapPos[]; edges: { from: string; to: string }[]; width: number; height: number }

export const NODE_W = 150, NODE_H = 34, COL_GAP = 50, ROW_GAP = 12;

/** Columns by depth; leaves take consecutive rows, parents are centred on their children. Unknown parents become roots. */
export function layoutMap(input: MapIn[]): MapLayout {
  const ids = new Set<string>();
  const items = input.filter((n) => !ids.has(n.id) && !!ids.add(n.id));
  const kids = new Map<string, string[]>();
  const roots: string[] = [];
  for (const n of items) {
    if (n.parent && n.parent !== n.id && ids.has(n.parent)) kids.set(n.parent, [...(kids.get(n.parent) ?? []), n.id]);
    else roots.push(n.id);
  }
  const pos = new Map<string, MapPos>();
  let row = 0;
  const edges: { from: string; to: string }[] = [];
  const place = (id: string, depth: number, seen: Set<string>): number => {
    seen.add(id);
    const cs = (kids.get(id) ?? []).filter((c) => !seen.has(c));
    let y: number;
    if (!cs.length) y = row++;
    else {
      const ys = cs.map((c) => { edges.push({ from: id, to: c }); return place(c, depth + 1, seen); });
      y = (ys[0] + ys[ys.length - 1]) / 2;
    }
    pos.set(id, { id, depth, x: depth * (NODE_W + COL_GAP), y: y * (NODE_H + ROW_GAP) });
    return y;
  };
  const seen = new Set<string>();
  for (const r of roots) place(r, 0, seen);
  const nodes = items.map((n) => pos.get(n.id)).filter((p): p is MapPos => !!p);
  const maxD = nodes.reduce((m, p) => Math.max(m, p.depth), 0);
  return { nodes, edges, width: (maxD + 1) * NODE_W + maxD * COL_GAP, height: Math.max(row, 1) * (NODE_H + ROW_GAP) - ROW_GAP };
}
