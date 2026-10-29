// Generic fake data (no real accounts/paths) shaped like the messages the extension posts to the webview.
(function () {
  const now = Date.now(), min = 60000;
  const G = window.GEN || {};
  const tile = (id, label, value, pct, sub) => ({ id, label, value, pct, sub, source: 'status line', at: now });
  const tool = (id, name, target, ms, extra) => Object.assign({ id, name, ts: now - 9 * min, status: 'ok', ms, target }, extra);
  const f = (p, a, r, created) => { const n = p.split('/').pop(); return { path: '/work/acme-web/' + p, name: n, dir: p.slice(0, p.length - n.length - 1), added: a, removed: r, created: !!created, gone: false, icon: 'file' }; };
  const sid = '11111111-2222-3333-4444-555555555555';
  const activity = {
    sessions: [{ id: sid, label: 'acme-web: add pricing page' }], changes: [], staleAfterMs: 120000, paused: false, selected: sid, mcp: true,
    tiles: [tile('agents', 'Active agents', '2/3', undefined), tile('context', 'Context', '42%', 42, '84k / 200k'), tile('limit5h', '5h limit', '37%', 37), tile('limitWeek', 'Weekly limit', '71%', 71),
      Object.assign(tile('tokens', 'Tokens', '182k in · 41k out', undefined), { source: 'transcript' })],
    toggles: { monitoring: true, mirror: true, changes: true, chatBox: true, timeline: true, timelineText: true, models: true, limits: true, statusBar: true, accounts: true, delegation: true },
    accounts: { defaultId: 'main', list: [{ id: 'main', label: 'you@example.com', role: 'main', enabled: true, loggedIn: true, plan: 'Max', fiveHour: 37, weekly: 71 }, { id: 'sub1', label: 'team-sub', role: 'sub', enabled: true, loggedIn: true, plan: 'Pro', fiveHour: 12, weekly: 30 }] },
    lastActivity: now,
    now: [
      { id: sid, sessionId: sid, kind: 'session', label: 'acme-web: add pricing page', chip: 'running', tool: 'Edit', since: now - 14 * min, model: 'claude-opus-4' },
      { id: 'a1', sessionId: sid, kind: 'subagent', label: 'Explore routing', chip: 'running', tool: 'Grep', since: now - 2 * min, parent: sid, type: 'Explore', model: 'claude-haiku-4' },
      { id: 'a2', sessionId: sid, kind: 'subagent', label: 'Write unit tests', chip: 'permission', since: now - min, parent: sid, type: 'test-writer', model: 'claude-sonnet-4' }
    ],
    delegated: [{ id: 'task:1', kind: 'task', label: 'Refactor billing module', chip: 'running', account: 'team-sub', role: 'sub', since: now - 6 * min }, { id: 'task:2', kind: 'task', label: 'Update API docs', chip: 'done', account: 'team-sub', role: 'sub' }],
    compare: { main: { tokens: 223000, messages: 12, files: 7 }, deleg: { running: 1, done: 1, failed: 0, tasks: 2, tokens: 96000, files: 4 } },
    models: [{}, {}, {}],
    families: [{ family: 'opus', share: 58, tokens: { in: 90000, out: 25000, cache: 300000 }, agents: ['main'], active: 1 }, { family: 'sonnet', share: 30, tokens: { in: 50000, out: 12000, cache: 150000 }, agents: ['a2'], active: 1 }, { family: 'haiku', share: 12, tokens: { in: 20000, out: 4000, cache: 60000 }, agents: ['a1'], active: 1 }],
    timeline: { sessionId: sid, showText: true, model: 'claude-opus-4', turns: [
      { line: 40, ts: now - 12 * min, endTs: now - 9 * min, tokIn: 52000, tokOut: 9000, hasText: true, prompt: 'Add a pricing page with three tiers', reply: 'Created the page and wired it into the nav.',
        files: [{ path: '/work/acme-web/src/app/pricing/page.tsx', name: 'page.tsx', added: 84, removed: 0, created: true }, { path: '/work/acme-web/src/components/Nav.tsx', name: 'Nav.tsx', added: 4, removed: 1 }],
        tools: [tool('t1', 'Read', 'src/components/Nav.tsx', 120, { file: '/work/acme-web/src/components/Nav.tsx' }), tool('t2', 'Write', 'src/app/pricing/page.tsx', 80), tool('t3', 'Edit', 'src/components/Nav.tsx', 60), tool('t4', 'Bash', 'npm run lint', 4200)] },
      { line: 20, ts: now - 30 * min, endTs: now - 26 * min, tokIn: 31000, tokOut: 6000, hasText: true, prompt: 'Fix the failing checkout test', reply: 'Fixed the rounding bug.', files: [{ path: '/work/acme-web/src/lib/cart.ts', name: 'cart.ts', added: 6, removed: 3 }], tools: [tool('t5', 'Grep', 'checkout', 90), tool('t6', 'Edit', 'src/lib/cart.ts', 50), tool('t7', 'Bash', 'npm test', 6100)] }
    ] }
  };
  const groups = [
    { id: sid, label: 'acme-web: add pricing page', sub: 'acme-web', at: now - 2 * min, live: true, added: 111, removed: 9, changes: [f('src/app/pricing/page.tsx', 84, 0, true), f('src/components/Nav.tsx', 4, 1), f('src/app/page.tsx', 12, 5), f('src/styles/pricing.css', 11, 3)] },
    { id: 's2', label: 'Fix checkout test', sub: 'acme-web', at: now - 30 * min, live: false, added: 6, removed: 3, changes: [f('src/lib/cart.ts', 6, 3)] },
    { id: 's3', label: 'Refactor billing module', sub: 'acme-web', at: now - 90 * min, live: false, added: 40, removed: 22, delegated: 'team-sub', changes: [f('src/lib/billing.ts', 40, 22)] }
  ];
  const changes = { sessions: [], changes: [], tiles: [], staleAfterMs: 120000, paused: false, groups, icons: {} };
  const node = (id, label, state, extra) => Object.assign({ id, label, kind: 'subagent', state, stateText: state === 'running' ? 'running' : state, sessionId: sid, since: now - 10 * min }, extra);
  const nodes = [
    node(sid, 'acme-web: add pricing page', 'running', { kind: 'session', family: 'opus', tool: 'Edit' }),
    node('a1', 'Explore routing', 'running', { parent: sid, family: 'haiku', tool: 'Grep' }),
    node('a2', 'Write unit tests', 'input', { parent: sid, family: 'sonnet', stateText: 'waiting for input' }),
    node('a3', 'Review diff', 'done', { parent: 'a1', family: 'sonnet', end: now - min }),
    node('task:1', 'Refactor billing module', 'running', { kind: 'task', account: 'team-sub', family: 'sonnet', sessionId: undefined })
  ];
  const agents = { nodes, layout: G.layout, now };
  const ago = (m) => new Date(now - m * min).toISOString();
  const checkpoints = { busy: false, noWorkspace: false, items: [
    { id: 'c1', name: 'Before pricing page', createdAt: ago(8), trigger: 'manual', fileCount: 142, size: 2400000, changed: 5 },
    { id: 'c2', name: 'Auto: fix checkout test', createdAt: ago(45), trigger: 'auto', fileCount: 141, size: 2390000, changed: 7 },
    { id: 'c3', name: 'Before billing refactor', createdAt: ago(300), trigger: 'manual', fileCount: 139, size: 2350000, changed: 11 }] };
  const settings = Object.assign({}, activity, { tiles: [], now: [], delegated: [], settings: G.settings });
  window.MOCK = { activity, changes, agents, checkpoints, settings, badges: { changes: 6, agents: 2 } };
})();
