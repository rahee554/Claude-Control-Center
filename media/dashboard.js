// Activity + Claude Changes webviews. No inline handlers; text via textContent only (never innerHTML).
(function () {
  'use strict';
  let app = document.createElement('div'); // replaced by the shell's tab root on first render
  let tabId = 'activity';
  let postFn = () => undefined;
  const SVGNS = 'http://www.w3.org/2000/svg';
  const saved = window.CCC_STORE.get('dash');
  const closed = new Set(Array.isArray(saved.closed) ? saved.closed.filter((x) => typeof x === 'string').slice(-200) : []);
  const ui = {
    q: typeof saved.q === 'string' ? saved.q : '', tool: typeof saved.tool === 'string' ? saved.tool : '', errors: saved.errors === true,
    system: saved.system === true, delegated: saved.delegated === true,
    view: saved.view === 'session' ? 'session' : 'all', cs: ['all', 'new', 'mod', 'gone'].includes(saved.cs) ? saved.cs : 'all', cq: ''
  };
  const kept = new Set(); // optimistic Keep: rows hidden until the next state confirms
  let state, tl, pop, focusPop = false; // pop: 'accounts' | undefined
  const openTurns = new Set(), openSubs = new Set();

  function persist() { window.CCC_STORE.set('dash', { closed: [...closed], q: ui.q, tool: ui.tool, errors: ui.errors, system: ui.system, delegated: ui.delegated, view: ui.view, cs: ui.cs }); }
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = String(text);
    return e;
  }
  // 16x16 codicon-like strokes.
  const ICONS = {
    chev: 'M6 4l4 4-4 4',
    donut: 'M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11zM8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z',
    bars: 'M2.5 6h11v4h-11z',
    diff: 'M2.5 2.5h11v11h-11zM8 2.5v11M4.5 6h2M9.5 10h2',
    history: 'M2.5 8a5.5 5.5 0 1 0 1.8-4.1M2.5 2.5v3h3M8 5v3.2l2.2 1.5',
    keep: 'M3 8.5l3 3 7-7',
    undo: 'M5.5 3.5L2.5 6.5l3 3M2.5 6.5H10a3.5 3.5 0 0 1 0 7H7',
    plus: 'M8 4v8M4 8h8',
    minus: 'M4 8h8',
    pause: 'M5.5 3.5v9M10.5 3.5v9',
    play: 'M5 3l8 5-8 5z',
    export: 'M8 10V2M5 5l3-3 3 3M3 9v4.5h10V9',
    refresh: 'M13 8a5 5 0 1 1-1.5-3.5M13 2.5v3h-3',
    gear: 'M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4',
    caret: 'M4.5 6.5L8 10l3.5-3.5',
    term: 'M2.5 3.5h11v9h-11zM4.5 6.5l2 1.5-2 1.5M8 10h3.5',
    file: 'M4 2.5h5l3 3v8H4zM9 2.5v3h3',
    edit: 'M10.5 2.8l2.7 2.7-7.4 7.4H3.1v-2.7zM9 4.3l2.7 2.7',
    search: 'M7 2.8a4.2 4.2 0 1 0 0 8.4 4.2 4.2 0 0 0 0-8.4M10 10l3.5 3.5',
    globe: 'M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11M2.5 8h11M8 2.5c1.8 1.6 2.5 3.5 2.5 5.5S9.8 11.9 8 13.5C6.2 11.9 5.5 10 5.5 8S6.2 4.1 8 2.5',
    agents: 'M5 6a2 2 0 1 0 0-.01M11 6a2 2 0 1 0 0-.01M1.5 13c.5-2 2-3 3.5-3s3 1 3.5 3M8 13c.5-2 2-3 3-3s2.5 1 3 3',
    tool: 'M10 2.5a3 3 0 0 0-2.8 4L2.5 11.2l2.3 2.3 4.7-4.7a3 3 0 0 0 4-2.8l-1.8 1.2-1.7-1.7L11.2 3.7z',
    cog: 'M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11M8 5v3.2l2.2 1.6',
    check: 'M3 8.5l3 3 7-7',
    add: 'M8 3v10M3 8h10',
    back: 'M10 3.5L5.5 8l4.5 4.5M5.5 8h8'
  };
  const TOOL_ICON = { Bash: 'term', PowerShell: 'term', Read: 'file', Edit: 'edit', Write: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit', Grep: 'search', Glob: 'search', WebFetch: 'globe', WebSearch: 'globe', Agent: 'agents', Task: 'agents' };
  function icon(name, cls) {
    const s = document.createElementNS(SVGNS, 'svg');
    s.setAttribute('viewBox', '0 0 16 16');
    s.setAttribute('class', 'ico' + (cls ? ' ' + cls : ''));
    s.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS(SVGNS, 'path');
    p.setAttribute('d', ICONS[name] || ICONS.tool);
    s.appendChild(p);
    return s;
  }
  function btn(content, label, onClick, cls) {
    const b = el('button', 'btn' + (cls ? ' ' + cls : ''));
    b.type = 'button';
    if (typeof content === 'string') b.textContent = content; else b.appendChild(content);
    b.title = label;
    b.setAttribute('aria-label', label);
    b.addEventListener('click', (ev) => { ev.stopPropagation(); onClick(ev); });
    return b;
  }
  /** Clickable row/header: Enter/Space activate, focusable, aria-expanded when given. */
  function clickable(node, fn, expanded) {
    node.tabIndex = 0;
    node.setAttribute('role', 'button');
    if (expanded !== undefined) node.setAttribute('aria-expanded', String(expanded));
    node.addEventListener('click', fn);
    node.addEventListener('keydown', (ev) => { if ((ev.key === 'Enter' || ev.key === ' ') && ev.target === node) { ev.preventDefault(); fn(); } });
  }
  const send = (msg) => postFn(msg);
  const post = (msg) => () => send(msg);
  function ago(ms) {
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    return s < 60 ? s + 's ago' : s < 3600 ? Math.floor(s / 60) + 'm ago' : s < 86400 ? Math.floor(s / 3600) + 'h ago' : Math.floor(s / 86400) + 'd ago';
  }
  function dur(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    return d ? d + 'd ' + h + 'h' : h ? h + 'h ' + m + 'm' : m ? m + 'm ' + x + 's' : x + 's';
  }
  function tok(n) { return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'k' : String(n || 0); }
  function hhmm(ms) { return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
  function level(p) { return p < 60 ? 'ok' : p < 85 ? 'warn' : 'hot'; }
  function family(m) { const s = String(m || '').toLowerCase(); return s.includes('opus') ? 'opus' : s.includes('sonnet') ? 'sonnet' : s.includes('haiku') ? 'haiku' : 'other'; }
  function famChip(m) { const f = family(m); const c = el('span', 'fam f-' + f, f === 'other' ? String(m).slice(0, 12) : f); c.title = String(m); return c; }
  function counts(a, r) {
    const c = el('span', 'counts');
    c.setAttribute('role', 'img');
    c.setAttribute('aria-label', a + ' additions, ' + r + ' deletions');
    c.title = c.getAttribute('aria-label');
    c.appendChild(el('span', 'add', '+' + a));
    c.appendChild(el('span', 'del', '−' + r));
    return c;
  }
  function section(id, title, meta, opts) {
    const o = opts || {};
    const open = !closed.has(id);
    const s = el('section', 'sec' + (open ? '' : ' shut'));
    const h = el('div', 'sec-h');
    h.appendChild(icon('chev', 'chev' + (open ? ' open' : '')));
    h.appendChild(el('span', 'sec-t', title));
    if (meta) h.appendChild(el('span', 'sec-n', meta));
    clickable(h, () => { if (open) closed.add(id); else closed.delete(id); persist(); render(); }, open);
    if (o.actions) h.appendChild(o.actions);
    s.appendChild(h);
    return { s, open };
  }
  /** File row: click name → diff; Keep / Undo / Diff badges. */
  function fileRow(f, acts) {
    const li = el('li', 'file');
    li.title = f.path;
    const name = el('button', 'fname');
    name.type = 'button';
    name.setAttribute('aria-label', 'Open diff of ' + f.name);
    name.appendChild(el('span', 'base', f.name));
    if (f.created) name.appendChild(el('span', 'tag', 'new'));
    if (f.sub) { const t = el('span', 'tag', 'subagent'); t.title = 'subagent edit - no per-message backup'; name.appendChild(t); }
    if (f.dir) name.appendChild(el('span', 'dir', f.dir));
    name.addEventListener('click', acts.diff);
    li.appendChild(name);
    li.appendChild(counts(f.added, f.removed));
    const a = el('span', 'badges');
    if (acts.keep) a.appendChild(btn(icon('keep'), 'Keep ' + f.name, () => { li.remove(); acts.keep(); }, 'badge'));
    if (acts.undo) a.appendChild(btn(icon('undo'), acts.undoLabel || 'Undo changes to ' + f.name + ' (asks first)', acts.undo, 'badge'));
    a.appendChild(btn(icon('diff'), 'Open diff of ' + f.name, acts.diff, 'badge'));
    li.appendChild(a);
    return li;
  }

  // ---- Changes view --------------------------------------------------------
  const STATUS = { new: 'New', mod: 'Modified', gone: 'Removed' };
  const statusOf = (c) => (c.gone ? 'gone' : c.created ? 'new' : 'mod');
  function changeRow(c, sessions, acts) {
    const li = el('li', 'file crow');
    li.title = c.path + (sessions.length > 1 ? '\n' + sessions.length + ' sessions: ' + sessions.map((x) => x.label).join(', ') : '');
    const icUri = state.icons && state.icons[c.icon];
    if (typeof icUri === 'string' && icUri.startsWith('data:image/svg+xml')) { const im = el('img', 'fic'); im.src = icUri; im.alt = ''; li.appendChild(im); } else li.appendChild(icon('file', 'fic'));
    const name = el('button', 'fname');
    name.type = 'button';
    name.setAttribute('aria-label', 'Open diff of ' + c.name);
    name.appendChild(el('span', 'base', c.name));
    if (c.dir) name.appendChild(el('span', 'dir', c.dir));
    name.addEventListener('click', acts.diff);
    li.appendChild(name);
    const st = statusOf(c);
    li.appendChild(el('span', 'chip st-' + st, STATUS[st]));
    li.appendChild(el('span', 'tag sess', sessions.length > 1 ? sessions.length + ' sessions' : ''));
    li.appendChild(counts(c.added, c.removed));
    const a = el('span', 'badges');
    a.appendChild(btn(icon('keep'), 'Keep ' + c.name, acts.keep, 'badge'));
    a.appendChild(btn(icon('undo'), 'Undo changes to ' + c.name + ' (asks first)', acts.undo, 'badge'));
    a.appendChild(btn(icon('diff'), 'Open diff of ' + c.name, acts.diff, 'badge'));
    li.appendChild(a);
    return li;
  }
  function renderChanges(root) {
    const groups = (Array.isArray(state.groups) ? state.groups : []).map((g) => ({ ...g, changes: g.changes.filter((c) => !kept.has(g.id + '|' + c.path)) })).filter((g) => g.changes.length);
    if (!groups.length) {
      const e = el('div', 'empty');
      e.appendChild(el('div', 'empty-t', 'No changes from Claude yet'));
      e.appendChild(el('div', 'empty-s', 'Files Claude edits in this workspace show up here. Click a file to see its diff.'));
      root.appendChild(e);
      return;
    }
    // Merge across sessions: groups are newest first, so the first sighting of a path is the latest change.
    const byPath = new Map();
    groups.forEach((g) => g.changes.forEach((c) => {
      const e = byPath.get(c.path);
      if (e) e.sessions.push({ id: g.id, label: g.label }); else byPath.set(c.path, { c, owner: g.id, sessions: [{ id: g.id, label: g.label }] });
    }));
    const all = [...byPath.values()];
    const sum = { n: all.length, new: 0, mod: 0, gone: 0, a: 0, r: 0 };
    all.forEach((x) => { sum[statusOf(x.c)]++; sum.a += x.c.added; sum.r += x.c.removed; });
    const bar = el('div', 'csum');
    bar.appendChild(el('span', '', sum.n + (sum.n === 1 ? ' file' : ' files') + ' · created ' + sum.new + ' · modified ' + sum.mod + ' · removed ' + sum.gone + ' · '));
    bar.appendChild(el('span', 'add', '+' + sum.a));
    bar.appendChild(document.createTextNode(' '));
    bar.appendChild(el('span', 'del', '−' + sum.r));
    root.appendChild(bar);

    const tools = el('div', 'ctools');
    const seg = el('div', 'segc');
    seg.setAttribute('role', 'group');
    [['all', 'All files'], ['session', 'By session']].forEach(([k, t]) => {
      const b = btn(t, t, () => { ui.view = k; persist(); render(); }, 'flt' + (ui.view === k ? ' on' : ''));
      b.setAttribute('aria-pressed', String(ui.view === k));
      seg.appendChild(b);
    });
    tools.appendChild(seg);
    const q = el('input', 'csearch');
    q.type = 'search'; q.placeholder = 'Filter files'; q.maxLength = 200; q.value = ui.cq; q.setAttribute('aria-label', 'Filter files');
    tools.appendChild(q);
    root.appendChild(tools);
    const chips = el('div', 'cchips');
    root.appendChild(chips);
    const list = el('div', 'clist');
    root.appendChild(list);

    const visible = (c) => (ui.cs === 'all' || statusOf(c) === ui.cs) && (!ui.cq || c.path.toLowerCase().includes(ui.cq.toLowerCase()));
    const bulk = (op, items) => { if (!items.length) return; send({ type: 'bulk', op, items: items.slice(0, 2000) }); };
    const itemsOf = () => (ui.view === 'all'
      ? all.filter((x) => visible(x.c)).map((x) => ({ sessionId: x.owner, path: x.c.path }))
      : groups.flatMap((g) => g.changes.filter(visible).map((c) => ({ sessionId: g.id, path: c.path }))));

    function drawChips() {
      chips.replaceChildren();
      [['all', 'All'], ['new', 'New'], ['mod', 'Modified'], ['gone', 'Removed']].forEach(([k, t]) => {
        const b = btn(t, 'Show ' + t, () => { ui.cs = k; persist(); drawChips(); drawList(); }, 'flt' + (ui.cs === k ? ' on' : ''));
        b.setAttribute('aria-pressed', String(ui.cs === k));
        chips.appendChild(b);
      });
      const acts = el('span', 'badges');
      acts.appendChild(btn(icon('keep'), 'Keep all shown (asks first)', () => bulk('keep', itemsOf()), 'badge'));
      acts.appendChild(btn(icon('undo'), 'Undo all shown (asks first)', () => bulk('undo', itemsOf()), 'badge'));
      chips.appendChild(acts);
    }
    const rowActs = (sid, c) => ({
      diff: post({ type: 'openDiff', sessionId: sid, path: c.path }),
      keep: () => { kept.add(sid + '|' + c.path); send({ type: 'keep', sessionId: sid, path: c.path }); render(); },
      undo: post({ type: 'undo', sessionId: sid, path: c.path })
    });
    function drawList() {
      list.replaceChildren();
      if (ui.view === 'all') {
        const ul = el('ul', 'files');
        all.filter((x) => visible(x.c)).forEach((x) => ul.appendChild(changeRow(x.c, x.sessions, rowActs(x.owner, x.c))));
        list.appendChild(ul.childNodes.length ? ul : el('div', 'muted pad', 'No files match.'));
        return;
      }
      groups.forEach((g) => {
        const rows = g.changes.filter(visible);
        if (!rows.length) return;
        const a = rows.reduce((n, c) => n + c.added, 0), r = rows.reduce((n, c) => n + c.removed, 0);
        const acts = el('span', 'badges');
        acts.appendChild(btn(icon('keep'), 'Keep all in this session (asks first)', () => bulk('keep', rows.map((c) => ({ sessionId: g.id, path: c.path }))), 'badge'));
        acts.appendChild(btn(icon('undo'), 'Undo all in this session (asks first)', () => bulk('undo', rows.map((c) => ({ sessionId: g.id, path: c.path }))), 'badge'));
        const meta = (g.live ? '● ' : '') + (g.sub ? g.sub.split(' · ')[0] + ' · ' : '') + (g.at ? ago(g.at) + ' · ' : '') + rows.length + (rows.length === 1 ? ' file' : ' files') + ' · +' + a + ' −' + r;
        const { s, open } = section('g:' + g.id, g.label, meta, { actions: acts });
        const h = s.firstChild;
        h.insertBefore(el('span', 'tag ' + (g.delegated ? 'deleg' : 'main'), g.delegated ? 'delegated · ' + g.delegated : 'main'), h.querySelector('.sec-n'));
        if (open) {
          const ul = el('ul', 'files');
          rows.forEach((c) => ul.appendChild(changeRow(c, [{ id: g.id, label: g.label }], rowActs(g.id, c))));
          s.appendChild(ul);
        }
        list.appendChild(s);
      });
      if (!list.childNodes.length) list.appendChild(el('div', 'muted pad', 'No files match.'));
    }
    q.addEventListener('input', () => { ui.cq = q.value; persist(); drawList(); });
    drawChips();
    drawList();
  }

  // ---- Header: account · session · actions ----------------------------------
  function initial(s) { return (String(s || '?').trim()[0] || '?').toUpperCase(); }
  function renderHeader(root) {
    const bar = el('div', 'hdr');
    const t = state.toggles || {};
    const acc = state.accounts;
    if (acc && acc.list.length && t.delegation !== false) {
      const cur = acc.list.find((a) => a.id === acc.defaultId);
      const b = el('button', 'acct-btn');
      b.type = 'button';
      b.setAttribute('aria-haspopup', 'true');
      b.setAttribute('aria-expanded', String(pop === 'accounts'));
      b.setAttribute('aria-label', 'Delegation account: ' + (cur ? cur.label : 'Auto') + '. Switch account');
      b.title = 'Account used for delegated tasks';
      b.appendChild(el('span', 'avatar', cur ? initial(cur.label) : 'A'));
      b.appendChild(el('span', 'acct-l', cur ? cur.label : 'Auto'));
      if (cur && cur.plan) b.appendChild(el('span', 'acct-p', cur.plan));
      b.appendChild(icon('caret'));
      b.addEventListener('click', (ev) => { ev.stopPropagation(); pop = pop === 'accounts' ? undefined : 'accounts'; focusPop = true; render(); });
      bar.appendChild(b);
    }
    renderSwitcher(bar);
    if (state.mcp !== undefined) {
      const on = state.mcp === true;
      const c = btn(on ? 'MCP ●' : 'MCP off', on ? 'ccc-accounts MCP server is registered. Click to remove it.' : 'ccc-accounts MCP server is not installed. Click to install it.', post({ type: 'command', id: on ? 'ccc.uninstallMcp' : 'ccc.installMcp' }), 'mcp ' + (on ? 'on' : 'off'));
      bar.appendChild(c);
    }
    const icons = el('span', 'hdr-icons');
    icons.appendChild(btn(icon(t.monitoring === false ? 'play' : 'pause'), t.monitoring === false ? 'Resume monitoring' : 'Pause monitoring', post({ type: 'toggle', key: 'monitoring', on: t.monitoring === false }), 'ibtn'));
    icons.appendChild(btn(icon('refresh'), 'Refresh', post({ type: 'command', id: 'ccc.refresh' }), 'ibtn'));
    icons.appendChild(btn(icon('export'), 'Export session as Markdown', post({ type: 'exportSession' }), 'ibtn'));
    icons.appendChild(btn(icon('gear'), 'Settings', () => { pop = undefined; window.CCC_SHELL.select('settings'); }, 'ibtn'));
    bar.appendChild(icons);
    root.appendChild(bar);
    if (pop === 'accounts' && acc) root.appendChild(accountsMenu(acc));
  }
  function menu(label) {
    const m = el('div', 'pop');
    m.setAttribute('role', 'menu');
    m.setAttribute('aria-label', label);
    m.addEventListener('click', (ev) => ev.stopPropagation());
    m.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { pop = undefined; render(); } });
    return m;
  }
  function accItem(id, label, sub, on) {
    {
      const b = el('button', 'mi' + (on ? ' on' : ''));
      b.type = 'button';
      b.setAttribute('role', 'menuitemradio');
      b.setAttribute('aria-checked', String(!!on));
      b.appendChild(on ? icon('check') : el('span', 'ico'));
      const tx = el('span', 'mi-t');
      tx.appendChild(el('span', '', label));
      if (sub) tx.appendChild(el('span', 'mi-s', sub));
      b.appendChild(tx);
      b.addEventListener('click', () => { pop = undefined; send({ type: 'setAccount', id }); });
      return b;
    }
  }
  function accountsMenu(acc) {
    const m = menu('Accounts');
    const item = accItem;
    m.appendChild(item(undefined, 'Auto', 'Sub-account with the lowest 5h usage', !acc.defaultId));
    acc.list.filter((a) => a.enabled).forEach((a) => {
      const lim = [a.fiveHour !== undefined ? '5h ' + Math.round(a.fiveHour) + '%' : '', a.weekly !== undefined ? 'wk ' + Math.round(a.weekly) + '%' : ''].filter(Boolean).join(' · ');
      m.appendChild(item(a.id, a.label, [a.role, a.plan, a.loggedIn ? lim : 'signed out'].filter(Boolean).join(' · '), a.id === acc.defaultId));
    });
    m.appendChild(el('div', 'sep'));
    const act = (ic, label, id) => { const b = el('button', 'mi'); b.type = 'button'; b.setAttribute('role', 'menuitem'); b.appendChild(icon(ic)); b.appendChild(el('span', 'mi-t', label)); b.addEventListener('click', () => { pop = undefined; render(); send({ type: 'command', id }); }); return b; };
    m.appendChild(act('add', 'Add account…', 'ccc.accounts.add'));
    m.appendChild(act('gear', 'Manage accounts…', 'ccc.accounts.edit'));
    return m;
  }
  function renderSwitcher(root) {
    // Session menu removed from the header: sessions are switched by clicking rows in Now / Delegated.
    if (state.selectedDelegated) { const d = el('span', 'tag deleg', 'Delegated'); d.title = 'This session ran as a delegated task on ' + state.selectedDelegated; root.appendChild(d); }
  }

  // ---- Now -----------------------------------------------------------------
  const CHIP = { running: 'running', input: 'waiting for input', permission: 'waiting for permission', idle: 'idle', done: 'done', failed: 'failed', stale: 'stale' };
  function nowRow(i, nested) {
    const r = el('div', 'row now-row' + (nested ? ' nested' : '') + (i.sessionId === state.selected && i.kind === 'session' ? ' sel' : ''));
    const dot = el('span', 'dot c-' + (CHIP[i.chip] ? i.chip : 'idle'));
    dot.setAttribute('role', 'img');
    dot.setAttribute('aria-label', CHIP[i.chip] || 'idle');
    dot.title = CHIP[i.chip] || 'idle';
    r.appendChild(dot);
    const lbl = el('span', 'lbl', i.label);
    if (i.hint) lbl.title = i.hint;
    r.appendChild(lbl);
    if (i.type) r.appendChild(el('span', 'chip-dim', i.type));
    if (i.model) r.appendChild(famChip(i.model));
    if (i.kind === 'task' && i.account) r.appendChild(el('span', 'chip-dim', i.account));
    r.appendChild(el('span', 'tool-now', i.tool || (i.chip === 'input' || i.chip === 'permission' ? CHIP[i.chip] : '')));
    if (i.since) { const t = el('span', 'el', dur(Date.now() - i.since)); t.dataset.since = String(i.since); r.appendChild(t); }
    if (i.sessionId && i.kind === 'session') { r.title = 'Show this session below'; clickable(r, () => send({ type: 'select', sessionId: i.sessionId })); }
    if (i.kind === 'task') { r.title = i.sessionId ? 'Open this delegated session below' : 'Delegated task'; if (i.sessionId) clickable(r, () => send({ type: 'select', sessionId: i.sessionId })); }
    return r;
  }
  function renderNow(root) {
    const items = Array.isArray(state.now) ? state.now : [];
    const busy = items.filter((i) => i.chip === 'running' || i.chip === 'input' || i.chip === 'permission');
    if (!busy.length) {
      const idle = el('div', 'idle-line');
      idle.appendChild(el('span', 'dot c-idle'));
      idle.appendChild(el('span', '', state.paused ? 'Monitoring paused' : 'Idle' + (state.lastActivity ? ' · last activity ' + ago(state.lastActivity) : '')));
      root.appendChild(idle);
    } else {
      const { s, open } = section('now', 'Now', busy.filter((i) => i.chip === 'running').length + ' running');
      if (open) {
        const list = el('div', 'list');
        items.filter((i) => i.kind !== 'subagent').forEach((i) => {
          list.appendChild(nowRow(i, false));
          if (i.kind === 'session') items.filter((x) => x.kind === 'subagent' && x.parent === i.id).forEach((x) => list.appendChild(nowRow(x, true)));
        });
        s.appendChild(list);
      }
      root.appendChild(s);
    }
    const del = Array.isArray(state.delegated) ? state.delegated : [];
    if (del.length) {
      const { s, open } = section('delegated', 'Delegated', del.length + (del.length === 1 ? ' task' : ' tasks'));
      if (open) { const list = el('div', 'list scroll'); del.slice(0, 20).forEach((i) => list.appendChild(nowRow(i, false))); s.appendChild(list); }
      root.appendChild(s);
    }
  }

  // ---- Metrics: 4 mini meters ------------------------------------------------
  function renderMetrics(root) {
    const want = [['context', 'Ctx'], ['limit5h', '5h'], ['limitWeek', 'Week'], ['tokens', 'Tokens']];
    const row = el('div', 'meters');
    want.forEach(([id, short]) => {
      const t = (state.tiles || []).find((x) => x.id === id);
      if (!t) return;
      const m = el('div', 'meter' + (t.unavailable ? ' na' : ''));
      const value = t.unavailable ? '—' : id === 'tokens' ? t.value.split(' · ').map((x) => x.split(' ')[0]).join('/') : t.value;
      m.title = t.label + ': ' + t.value + (t.sub ? '\n' + t.sub : '') + (t.tooltip ? '\n' + t.tooltip : '') + '\nSource: ' + t.source + (t.at ? ' · ' + ago(t.at) : '');
      m.tabIndex = 0;
      m.setAttribute('aria-label', m.title.split('\n').slice(0, 2).join(', '));
      const top = el('div', 'm-top');
      top.appendChild(el('span', 'm-l', short));
      top.appendChild(el('span', 'm-v' + (t.pct !== undefined ? ' lv-' + level(t.pct) : ''), value));
      m.appendChild(top);
      const bar = el('div', 'bar');
      if (t.pct !== undefined) { const f = el('div', 'fill ' + level(t.pct)); f.style.width = Math.max(0, Math.min(100, t.pct)) + '%'; bar.appendChild(f); }
      m.appendChild(bar);
      row.appendChild(m);
    });
    root.appendChild(row);
  }

  // ---- Main vs Delegated ----------------------------------------------------
  /** segs: [{cls, share (0..100), tip}]; centre text. */
  function donut(segs, center) {
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('viewBox', '0 0 42 42'); svg.setAttribute('class', 'donut');
    const R = 15.915; let off = 25; // start at 12 o'clock
    const mk = (cls, dash, offset) => {
      const c = document.createElementNS(SVGNS, 'circle');
      c.setAttribute('cx', '21'); c.setAttribute('cy', '21'); c.setAttribute('r', String(R)); c.setAttribute('fill', 'none');
      c.setAttribute('class', 'seg ' + cls);
      if (dash) { c.setAttribute('stroke-dasharray', dash); c.setAttribute('stroke-dashoffset', String(offset)); }
      svg.appendChild(c);
      return c;
    };
    mk('ring');
    segs.forEach((f) => {
      if (!(f.share > 0)) return;
      const c = mk(f.cls, f.share + ' ' + (100 - f.share), off);
      const t = document.createElementNS(SVGNS, 'title'); t.textContent = f.tip; c.appendChild(t);
      off -= f.share;
    });
    const tx = document.createElementNS(SVGNS, 'text');
    tx.setAttribute('x', '21'); tx.setAttribute('y', '23'); tx.setAttribute('text-anchor', 'middle'); tx.setAttribute('class', 'donut-c'); tx.textContent = center;
    svg.appendChild(tx);
    return svg;
  }
  function renderCompare(root) {
    const c = state.compare;
    if (!c) return;
    const { s, open } = section('compare', 'Main vs Delegated', c.deleg.running + ' running');
    if (open) {
      const tot = c.main.tokens + c.deleg.tokens;
      const mp = tot > 0 ? Math.round((c.main.tokens / tot) * 100) : 0, dp = tot > 0 ? 100 - mp : 0;
      const box = el('div', 'model');
      const vis = el('div', 'chart-donut');
      vis.setAttribute('role', 'img');
      vis.setAttribute('aria-label', tot > 0 ? 'Token share: main ' + mp + '%, delegated ' + dp + '%' : 'No tokens recorded yet');
      vis.appendChild(donut([{ cls: 'cm', share: mp, tip: 'Main ' + mp + '% · ' + tok(c.main.tokens) + ' tokens' }, { cls: 'cd', share: dp, tip: 'Delegated ' + dp + '% · ' + tok(c.deleg.tokens) + ' tokens' }], tok(tot)));
      box.appendChild(vis);
      const leg = el('div', 'legend');
      [['cm', 'Main ' + mp + '%', c.main.messages + ' messages · ' + c.main.files + ' files'], ['cd', 'Delegated ' + dp + '%', c.deleg.tasks + (c.deleg.tasks === 1 ? ' task' : ' tasks') + ' · ' + c.deleg.files + ' files']].forEach(([cls, txt, sub]) => {
        const it = el('span', 'lg');
        it.appendChild(el('span', 'dot ' + cls));
        it.appendChild(document.createTextNode(txt + ' · ' + sub));
        leg.appendChild(it);
      });
      box.appendChild(leg);
      s.appendChild(box);
    }
    root.appendChild(s);
  }

  // ---- Models --------------------------------------------------------------
  const FAM_NAME = { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku', other: 'Other' };
  function famTip(f) { return FAM_NAME[f.family] + ' ' + f.share + '% · ' + tok(f.tokens.in) + ' in · ' + tok(f.tokens.out) + ' out · ' + tok(f.tokens.cache) + ' cache'; }
  function renderModels(root) {
    const ms = Array.isArray(state.models) ? state.models : [];
    if (!ms.length) return;
    const fams = (Array.isArray(state.families) ? state.families : []).filter((f) => f.share > 0 || f.agents.length);
    const { s, open } = section('models', 'Models', ms.length + (ms.length === 1 ? ' model' : ' models'));
    if (open) {
      const box = el('div', 'model');
      const shown = fams.filter((f) => f.share > 0);
      const vis = el('div', 'chart-bar');
      vis.setAttribute('role', 'img');
      vis.setAttribute('aria-label', 'Token share by model family: ' + (shown.map((f) => FAM_NAME[f.family] + ' ' + f.share + '%').join(', ') || 'no tokens yet'));
      const bar = el('div', 'stack');
      shown.forEach((f) => { const g = el('div', 'seg f-' + f.family); g.style.width = f.share + '%'; g.title = famTip(f); bar.appendChild(g); });
      vis.appendChild(bar);
      box.appendChild(vis);
      const leg = el('div', 'legend');
      fams.forEach((f) => {
        const it = el('span', 'lg');
        it.appendChild(el('span', 'dot f-' + f.family));
        it.appendChild(document.createTextNode(FAM_NAME[f.family] + ' ' + f.share + '%' + (f.active ? ' · ' + f.active + ' active' : '')));
        it.title = famTip(f);
        leg.appendChild(it);
      });
      box.appendChild(leg);
      s.appendChild(box);
    }
    root.appendChild(s);
  }

  // ---- Messages timeline -----------------------------------------------------
  function toolRow(t, sid) {
    const r = el('div', 'tool s-' + t.status);
    r.appendChild(icon(TOOL_ICON[t.name] || 'tool'));
    r.appendChild(el('span', 'tool-n', t.name));
    const target = el(t.file || t.command ? 'button' : 'span', 'tool-t' + (t.file || t.command ? ' link' : ''), t.target || '');
    if (t.file) { target.type = 'button'; target.title = 'Open ' + t.file; target.addEventListener('click', (ev) => { ev.stopPropagation(); send({ type: 'openFile', sessionId: sid, path: t.file }); }); }
    else if (t.command) { target.type = 'button'; target.title = t.command + '\n(click: focus Claude mirror terminal)'; target.addEventListener('click', (ev) => { ev.stopPropagation(); send({ type: 'focusMirror', sessionId: sid }); }); }
    r.appendChild(target);
    const st = el('span', 'tool-s');
    if (t.status === 'run') { st.textContent = dur(Date.now() - t.ts); st.dataset.since = String(t.ts); }
    else st.textContent = (t.status === 'ok' ? '' : '✗ ') + (t.ms !== undefined ? (t.ms < 1000 ? t.ms + 'ms' : dur(t.ms)) : '');
    st.setAttribute('aria-label', t.status === 'run' ? 'running' : t.status === 'ok' ? 'succeeded' : 'failed');
    r.appendChild(st);
    return r;
  }
  function matches(turn) {
    if (turn.system && !turn.prompt && !ui.system) return false;
    const q = ui.q.trim().toLowerCase();
    const tools = turn.tools.flatMap((t) => [t].concat(t.sub ? t.sub.tools : []));
    if (ui.errors && !tools.some((t) => t.status === 'err')) return false;
    if (ui.tool && !tools.some((t) => t.name === ui.tool)) return false;
    if (!q) return true;
    return [turn.prompt, turn.reply, turn.system].concat(tools.map((t) => t.name + ' ' + (t.target || '') + ' ' + (t.file || ''))).some((s) => s && s.toLowerCase().includes(q));
  }
  function firstLine(s) { return String(s).split('\n').find((l) => l.trim()) || ''; }

  function renderTimeline(root) {
    if (!tl) { if (state.selected && state.toggles && state.toggles.timeline !== false) root.appendChild(el('div', 'muted pad', 'Loading messages…')); return; }
    const turns = tl.turns || [];
    const { s, open } = section('messages', 'Messages', turns.filter((t) => t.prompt || !t.system).length + ' turns');
    root.appendChild(s);
    if (!open) return;
    if (tl.missing) { s.appendChild(el('div', 'muted pad', 'No local transcript for this session.')); return; }
    const f = el('div', 'filters');
    const q = el('input', 'q');
    q.type = 'search'; q.placeholder = 'Filter messages, tools, files'; q.value = ui.q; q.setAttribute('aria-label', 'Filter messages');
    q.addEventListener('input', () => { ui.q = q.value; persist(); drawList(); });
    f.appendChild(q);
    const names = [...new Set(turns.flatMap((t) => t.tools.map((x) => x.name)))].sort();
    const ts = el('select', 'tsel');
    ts.setAttribute('aria-label', 'Tool type');
    [''].concat(names).forEach((n) => { const o = el('option', '', n || 'All tools'); o.value = n; if (n === ui.tool) o.selected = true; ts.appendChild(o); });
    ts.addEventListener('change', () => { ui.tool = ts.value; persist(); drawList(); });
    f.appendChild(ts);
    const tgl = (key, label, title) => {
      const b = btn(label, title, () => { ui[key] = !ui[key]; persist(); b.classList.toggle('on', ui[key]); b.setAttribute('aria-pressed', String(ui[key])); drawList(); }, 'flt' + (ui[key] ? ' on' : ''));
      b.setAttribute('aria-pressed', String(ui[key]));
      return b;
    };
    f.appendChild(tgl('errors', 'Errors', 'Only messages with failed tools'));
    f.appendChild(tgl('system', 'System', 'Show system events (background task notifications, editor context)'));
    s.appendChild(f);
    const list = el('ol', 'turns');
    s.appendChild(list);
    function drawList() {
      list.textContent = '';
      const shown = turns.filter(matches);
      if (!shown.length) { list.appendChild(el('li', 'muted pad', 'No matching messages.')); return; }
      shown.slice().reverse().forEach((t) => {
        const key = String(t.line);
        if (t.system && !t.prompt) {
          const li = el('li', 'turn sys');
          li.appendChild(el('span', 'time', hhmm(t.ts)));
          li.appendChild(icon('cog'));
          li.appendChild(el('span', 'lbl', t.system + (t.tools.length ? ' · ' + t.tools.length + ' tools' : '')));
          list.appendChild(li);
          return;
        }
        const open = openTurns.has(key);
        const li = el('li', 'turn' + (open ? ' open' : ''));
        const h = el('div', 'turn-h');
        clickable(h, () => { if (open) openTurns.delete(key); else openTurns.add(key); drawList(); }, open);
        h.appendChild(el('span', 'time', hhmm(t.ts)));
        h.appendChild(el('span', 'lbl', tl.showText ? (t.prompt ? firstLine(t.prompt) : '(continued)') : 'Message at line ' + t.line));
        const errs = t.tools.filter((x) => x.status === 'err').length;
        const tf = t.files || [];
        const meta = el('span', 'turn-m');
        const cell = (cls, text) => meta.appendChild(el('span', 'c ' + cls, text));
        cell('c-f', tf.length ? tf.length + (tf.length === 1 ? ' file' : ' files') : '');
        if (tf.length) meta.appendChild(counts(tf.reduce((n, x) => n + x.added, 0), tf.reduce((n, x) => n + x.removed, 0))); else { cell('c-a', ''); cell('c-d', ''); }
        const tc = el('span', 'c c-t tc' + (errs ? ' err' : ''), '');
        if (t.tools.length) { tc.appendChild(icon('tool')); tc.appendChild(document.createTextNode(String(t.tools.length) + (errs ? ' · ' + errs + '✗' : ''))); tc.title = t.tools.length + ' tools' + (errs ? ', ' + errs + ' failed' : ''); }
        meta.appendChild(tc);
        h.appendChild(meta);
        const hb = el('span', 'badges');
        if (tf.length) hb.appendChild(btn(icon('undo'), 'Revert files to before this message (asks first)', post({ type: 'revertTurn', sessionId: tl.sessionId, line: t.line }), 'badge'));
        hb.appendChild(btn(icon('history'), 'Open transcript at this message', post({ type: 'openTurn', sessionId: tl.sessionId, line: t.line }), 'badge'));
        h.appendChild(hb);
        li.appendChild(h);
        if (open) {
          const body = el('div', 'turn-b');
          if (tl.showText && t.prompt && t.prompt.includes('\n')) body.appendChild(el('div', 'msg user', t.prompt));
          if (tf.length) {
            const fl = el('ul', 'files scroll');
            tf.forEach((x) => fl.appendChild(fileRow(x, {
              diff: post({ type: 'openFile', sessionId: tl.sessionId, path: x.path }),
              undo: post({ type: 'revertTurn', sessionId: tl.sessionId, line: t.line, path: x.path }),
              undoLabel: 'Revert ' + x.name + ' to before this message (asks first)'
            })));
            body.appendChild(fl);
          }
          t.tools.forEach((x) => {
            body.appendChild(toolRow(x, tl.sessionId));
            if (x.sub) {
              const sk = x.id;
              const so = openSubs.has(sk) || x.status === 'run';
              const box = el('div', 'sub');
              const sh = el('div', 'row sub-h');
              clickable(sh, () => { if (openSubs.has(sk)) openSubs.delete(sk); else openSubs.add(sk); drawList(); }, so);
              sh.appendChild(icon('chev', 'chev' + (so ? ' open' : '')));
              sh.appendChild(el('span', 'lbl', x.sub.description || x.sub.type || 'subagent'));
              if (x.sub.type && x.sub.type !== 'general-purpose' && x.sub.type !== x.sub.description) sh.appendChild(el('span', 'chip-dim', x.sub.type));
              if (x.sub.model) sh.appendChild(famChip(x.sub.model));
              sh.appendChild(el('span', 'meta', x.sub.tools.length + ' tools' + (x.sub.tokens ? ' · ' + tok(x.sub.tokens) : '')));
              box.appendChild(sh);
              if (so) x.sub.tools.forEach((y) => box.appendChild(toolRow(y, tl.sessionId)));
              body.appendChild(box);
            }
          });
          if (tl.showText && t.reply) body.appendChild(el('div', 'msg asst', t.reply));
          body.appendChild(el('div', 'turn-f', (t.tokIn || t.tokOut ? tok(t.tokIn) + ' in · ' + tok(t.tokOut) + ' out · ' : '') + hhmm(t.ts) + (t.endTs > t.ts ? '–' + hhmm(t.endTs) + ' (' + dur(t.endTs - t.ts) + ')' : '')));
          li.appendChild(body);
        }
        list.appendChild(li);
      });
    }
    drawList();
  }

  // ---- Settings page ---------------------------------------------------------
  function renderSettings(root) {
    const bar = el('div', 'hdr');
    bar.appendChild(btn(icon('back'), 'Back to Activity', () => window.CCC_SHELL.select('activity'), 'ibtn'));
    bar.appendChild(el('span', 'set-title', 'Settings'));
    const more = btn('All settings…', 'Open VS Code settings for this extension', post({ type: 'openSettings' }));
    more.classList.add('set-more');
    bar.appendChild(more);
    root.appendChild(bar);
    const S = state.settings;
    if (!S) { root.appendChild(el('div', 'muted pad', 'Loading settings…')); return; }
    const put = (key, value) => send({ type: 'setSetting', key, value });
    const groups = [];
    S.defs.forEach((d) => { if (!groups.includes(d.group)) groups.push(d.group); });
    groups.forEach((g) => {
      const sec = el('section', 'set-sec');
      sec.appendChild(el('div', 'set-g', g));
      S.defs.filter((d) => d.group === g).forEach((d) => {
        const v = S.values[d.key];
        const row = el('div', 'set-row');
        const tx = el('div', 'set-t');
        tx.appendChild(el('div', 'set-l', d.label));
        tx.appendChild(el('div', 'mi-s', d.desc));
        tx.title = 'ccc.' + d.key;
        row.appendChild(tx);
        let ctl;
        if (d.type === 'bool') {
          ctl = el('button', 'sw' + (v === true ? ' on' : ''));
          ctl.type = 'button';
          ctl.setAttribute('role', 'switch');
          ctl.setAttribute('aria-label', d.label);
          ctl.setAttribute('aria-checked', String(v === true));
          ctl.addEventListener('click', () => { const on = ctl.getAttribute('aria-checked') !== 'true'; ctl.setAttribute('aria-checked', String(on)); ctl.classList.toggle('on', on); put(d.key, on); });
        } else if (d.type === 'number') {
          ctl = el('input', 'setnum');
          ctl.type = 'number'; ctl.min = String(d.min); ctl.max = String(d.max); ctl.step = '1'; ctl.value = String(v);
          ctl.setAttribute('aria-label', d.label);
          ctl.addEventListener('change', () => { const n = Math.round(Number(ctl.value)); if (ctl.value !== '' && Number.isFinite(n) && n >= d.min && n <= d.max) put(d.key, n); else ctl.value = String(v); });
        } else if (d.type === 'path') {
          ctl = el('input', 'setnum wide');
          ctl.type = 'text'; ctl.maxLength = 260; ctl.value = String(v);
          ctl.setAttribute('aria-label', d.label);
          ctl.addEventListener('change', () => put(d.key, ctl.value.trim()));
        } else {
          ctl = el('select', 'setsel');
          ctl.setAttribute('aria-label', d.label);
          const opts = d.type === 'enum' ? d.options.map((o) => [o, o]) : [['auto', 'Auto'], ['main', 'Main account']].concat(S.accounts.map((a) => [a.id, a.label]));
          if (!opts.some((o) => o[0] === v)) opts.push([String(v), String(v)]);
          opts.forEach(([val, text]) => { const o = el('option', '', text); o.value = val; if (val === v) o.selected = true; ctl.appendChild(o); });
          ctl.addEventListener('change', () => put(d.key, ctl.value));
        }
        row.appendChild(ctl);
        if (d.type === 'bool') { row.classList.add('clk'); row.addEventListener('click', (ev) => { if (!ctl.contains(ev.target)) ctl.click(); }); }
        sec.appendChild(row);
      });
      root.appendChild(sec);
    });
  }

  function renderAccounts(root) {
    const acc = state.accounts, t = state.toggles || {};
    const bar = el('div', 'hdr');
    bar.appendChild(el('span', 'set-title', 'Accounts'));
    const ic = el('span', 'hdr-icons');
    ic.appendChild(btn(icon('add'), 'Add account…', post({ type: 'command', id: 'ccc.accounts.add' }), 'ibtn'));
    if (t.delegation !== false) ic.appendChild(btn(icon('agents'), 'Delegate a task…', post({ type: 'command', id: 'ccc.delegateTask' }), 'ibtn'));
    ic.appendChild(btn(icon('gear'), 'Manage accounts…', post({ type: 'command', id: 'ccc.accounts.edit' }), 'ibtn'));
    bar.appendChild(ic);
    root.appendChild(bar);
    if (!acc) { root.appendChild(el('div', 'muted pad', 'Accounts are turned off in Settings.')); return; }
    const list = el('div', 'list');
    list.appendChild(accItem(undefined, 'Auto', 'Sub-account with the lowest 5h usage', !acc.defaultId));
    acc.list.forEach((a) => {
      const lim = [a.fiveHour !== undefined ? '5h ' + Math.round(a.fiveHour) + '%' : '', a.weekly !== undefined ? 'wk ' + Math.round(a.weekly) + '%' : ''].filter(Boolean).join(' · ');
      list.appendChild(accItem(a.id, a.label, [a.role, a.plan, a.enabled ? '' : 'disabled', a.loggedIn ? lim : 'signed out'].filter(Boolean).join(' · '), a.id === acc.defaultId));
    });
    root.appendChild(list);
    const del = Array.isArray(state.delegated) ? state.delegated : [];
    const { s, open } = section('delegated', 'Delegated tasks', del.length ? String(del.length) : 'none');
    if (open) { const l = el('div', 'list scroll'); del.slice(0, 20).forEach((i) => l.appendChild(nowRow(i, false))); s.appendChild(l); }
    root.appendChild(s);
  }

  function render() {
    if (!state) return;
    const ae = document.activeElement;
    const focusQ = ae && ae.classList && ae.classList.contains('q') ? [ae.selectionStart, ae.selectionEnd] : undefined;
    const scroll = window.scrollY;
    const popBtns = [...app.querySelectorAll('.pop button')];
    const popIdx = popBtns.indexOf(ae);
    const out = document.createElement('div'); // built off-DOM, swapped in one step: no empty frame / flicker
    if (tabId === 'changes') { if (state.paused) out.appendChild(el('div', 'muted pad', 'Monitoring paused.')); renderChanges(out); app.replaceChildren(...out.childNodes); return; }
    if (tabId === 'accounts') { renderAccounts(out); app.replaceChildren(...out.childNodes); return; }
    if (tabId === 'settings') { renderSettings(out); app.replaceChildren(...out.childNodes); window.scrollTo(0, scroll); return; }
    renderHeader(out);
    if (!(state.sessions || []).length) {
      const e = el('div', 'empty');
      e.appendChild(el('div', 'empty-t', 'No Claude Code session yet'));
      e.appendChild(el('div', 'empty-s', 'Install the hooks so sessions show up here.'));
      e.appendChild(btn('Install hooks', 'Install Claude Code hooks', post({ type: 'command', id: 'ccc.installHooks' }), 'primary'));
      out.appendChild(e);
    }
    renderNow(out);
    renderMetrics(out);
    renderCompare(out);
    renderModels(out);
    renderTimeline(out);
    app.replaceChildren(...out.childNodes);
    if (focusQ) { const q = app.querySelector('.q'); if (q) { q.focus(); try { q.setSelectionRange(focusQ[0], focusQ[1]); } catch (e) { /* ignore */ } } }
    if (pop) { const bs = app.querySelectorAll('.pop button'); const b = bs[popIdx >= 0 ? popIdx : focusPop ? 0 : -1]; if (b) b.focus(); }
    focusPop = false;
    window.scrollTo(0, scroll);
  }

  document.addEventListener('click', () => { if (pop) { pop = undefined; render(); } });
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && pop) { pop = undefined; render(); } });
  let pending = false;
  function ingest(root, st, p) {
    app = root; postFn = p;
    if (!st || !Array.isArray(st.tiles)) { if (!state) root.textContent = 'Loading…'; return; }
    state = st;
    kept.clear();
    if (st.timeline && Array.isArray(st.timeline.turns)) tl = st.timeline;
    if (st.toggles && st.toggles.timeline === false) tl = undefined;
    // Don't rebuild while a dropdown is in use (it would close under the user); render on blur.
    const fa = document.activeElement;
    if (fa && (fa.tagName === 'SELECT' || (fa.classList && fa.classList.contains('setnum')))) { pending = true; return; }
    render();
  }
  ['activity', 'changes', 'accounts', 'settings'].forEach((id) => {
    window.CCC_TABS[id] = { render(root, st, p) { tabId = id; ingest(root, st, p); } };
  });
  document.addEventListener('focusout', () => { if (pending) { pending = false; setTimeout(render, 0); } });
  setInterval(() => {
    document.querySelectorAll('[data-since]').forEach((n) => { n.textContent = dur(Date.now() - Number(n.dataset.since)); });
  }, 1000);
})();
