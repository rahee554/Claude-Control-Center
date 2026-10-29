(function () {
  const saved = window.CCC_STORE.get('agents');
  let mode = saved.mode === 'tree' ? 'tree' : 'map'; // Map is the default until the user picks Tree
  let scope = saved.scope === 'all' ? 'all' : 'session'; // this session's agents by default; 'all' = every project
  let postFn = () => undefined;
  let sel, detail, lastReq = 0;
  const openMore = new Set();
  const collapsed = new Set(Array.isArray(saved.collapsed) ? saved.collapsed : ['__recent']);
  let st = null;
  let app = document.createElement('div');
  const SVG = 'http://www.w3.org/2000/svg';
  const save = () => window.CCC_STORE.set('agents', { mode, scope, collapsed: [...collapsed] });

  function el(tag, cls, text, ns) {
    const e = ns ? document.createElementNS(SVG, tag) : document.createElement(tag);
    if (cls) e.setAttribute('class', cls);
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function elapsed(n, now) {
    if (!n.since) return '';
    let s = Math.max(0, Math.floor(((n.end || now) - n.since) / 1000));
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    return m < 60 ? m + 'm ' + (s % 60) + 's' : Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
  }
  const agentOf = (n) => (n.kind === 'session' ? undefined : n.id);
  function request(n) {
    lastReq = Date.now();
    postFn({ type: 'detail', sessionId: n.sessionId, agentId: agentOf(n) });
  }
  const open = (n) => {
    if (!n.sessionId) return;
    sel = { sessionId: n.sessionId, agentId: agentOf(n), id: n.id };
    detail = undefined; following = true; showAll = false; expanded.clear(); fullOut.clear(); kept.clear(); openMore.delete('result');
    request(n);
    draw();
  };

  function header() {
    const bar = el('div', 'abar'), views = el('div', 'seg'), scopes = el('div', 'seg');
    bar.append(views, scopes);
    for (const m of ['tree', 'map']) {
      const b = el('button', '', m === 'tree' ? 'Tree' : 'Map');
      b.setAttribute('aria-pressed', String(mode === m));
      b.onclick = () => { mode = m; save(); draw(); };
      views.appendChild(b);
    }
    for (const s of ['session', 'all']) {
      const b = el('button', '', s === 'session' ? 'This session' : 'All agents');
      b.setAttribute('aria-pressed', String(scope === s));
      b.title = s === 'session' ? 'Agents of the session shown in Activity' : 'Agents running across all projects';
      b.onclick = () => { scope = s; save(); draw(); };
      scopes.appendChild(b);
    }
    return bar;
  }

  function treeRow(n, depth, now, hasKids) {
    const r = el('div', 's-' + n.state + ' row');
    r.style.paddingLeft = 8 + depth * 14 + 'px';
    const tw = el('span', 'twist', hasKids ? (collapsed.has(n.id) ? '▸' : '▾') : '');
    r.append(tw, el('span', 'dot'), el('span', 'lbl' + (n.kind === 'task' ? ' deleg' : ''), n.label));
    if (n.family) r.appendChild(el('span', 'chip f-' + n.family, n.family));
    const meta = [n.kind === 'task' ? 'Delegated · ' + (n.account || '') : '', n.stateText, n.tool, elapsed(n, now)].filter(Boolean).join(' · ');
    r.appendChild(el('span', 'meta', meta));
    r.title = n.label;
    r.onclick = (ev) => {
      if (hasKids && ev.target === tw) { collapsed.has(n.id) ? collapsed.delete(n.id) : collapsed.add(n.id); save(); draw(); } else open(n);
    };
    return r;
  }

  function drawTree(host) {
    const nodes = st.nodes.filter((n) => n.kind !== 'recent');
    const recent = st.nodes.filter((n) => n.kind === 'recent');
    const kids = new Map();
    for (const n of nodes) if (n.parent) kids.set(n.parent, (kids.get(n.parent) || []).concat(n));
    const ids = new Set(nodes.map((n) => n.id));
    const roots = nodes.filter((n) => !n.parent || !ids.has(n.parent));
    const walk = (n, d, seen) => {
      if (seen.has(n.id)) return;
      seen.add(n.id);
      const k = kids.get(n.id) || [];
      host.appendChild(treeRow(n, d, st.now, k.length > 0));
      if (!collapsed.has(n.id)) k.forEach((c) => walk(c, d + 1, seen));
    };
    const seen = new Set();
    roots.forEach((n) => walk(n, 0, seen));
    if (!nodes.length) host.appendChild(el('div', 'empty', 'No active Claude Code sessions'));
    if (recent.length) {
      const r = el('div', 'row', undefined);
      r.append(el('span', 'twist', collapsed.has('__recent') ? '▸' : '▾'), el('span', 'lbl', 'Recent'), el('span', 'meta', String(recent.length)));
      r.onclick = () => { collapsed.has('__recent') ? collapsed.delete('__recent') : collapsed.add('__recent'); save(); draw(); };
      host.appendChild(r);
      if (!collapsed.has('__recent')) recent.forEach((n) => host.appendChild(treeRow(n, 1, st.now, false)));
    }
  }

  function drawMap(host) {
    const L = st.layout, W = 150, H = 34, byId = new Map(st.nodes.map((n) => [n.id, n]));
    const pos = new Map(L.nodes.map((p) => [p.id, p]));
    if (!L.nodes.length) { host.appendChild(el('div', 'empty', 'No active Claude Code sessions')); return; }
    const wrap = el('div', 'mapwrap');
    const svg = el('svg', '', undefined, true);
    svg.setAttribute('width', L.width + 4); svg.setAttribute('height', L.height + 4);
    svg.setAttribute('viewBox', '-2 -2 ' + (L.width + 4) + ' ' + (L.height + 4));
    svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'Agent workflow map');
    for (const e of L.edges) {
      const a = pos.get(e.from), b = pos.get(e.to);
      if (!a || !b) continue;
      const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2, mx = (x1 + x2) / 2;
      const p = el('path', 'edge', undefined, true);
      p.setAttribute('d', 'M' + x1 + ' ' + y1 + 'C' + mx + ' ' + y1 + ' ' + mx + ' ' + y2 + ' ' + x2 + ' ' + y2);
      svg.appendChild(p);
    }
    for (const p of L.nodes) {
      const n = byId.get(p.id);
      if (!n) continue;
      const g = el('g', 'node s-' + n.state + (n.family ? ' f-' + n.family : '') + (n.kind === 'task' ? ' task' : ''), undefined, true);
      g.setAttribute('transform', 'translate(' + p.x + ' ' + p.y + ')');
      g.setAttribute('tabindex', '0'); g.setAttribute('role', 'button');
      const rect = el('rect', 'box', undefined, true);
      for (const [k, v] of [['width', W], ['height', H], ['rx', 6]]) rect.setAttribute(k, v);
      const stripe = el('rect', 'stripe', undefined, true);
      for (const [k, v] of [['width', 4], ['height', H], ['rx', 2]]) stripe.setAttribute(k, v);
      const dot = el('circle', 'dotc', undefined, true);
      for (const [k, v] of [['cx', 15], ['cy', 11], ['r', 4]]) dot.setAttribute(k, v);
      const t1 = el('text', '', n.label.length > 20 ? n.label.slice(0, 19) + '…' : n.label, true);
      t1.setAttribute('x', 24); t1.setAttribute('y', 14);
      const sub = [n.kind === 'task' ? 'Delegated · ' + (n.account || '') : n.stateText, n.tool].filter(Boolean).join(' · ');
      const t2 = el('text', '', (sub + ' ' + elapsed(n, st.now)).slice(0, 26), true);
      t2.setAttribute('x', 24); t2.setAttribute('y', 28); t2.setAttribute('opacity', '0.65');
      const tt = el('title', '', n.label + ' — ' + n.stateText, true);
      g.append(rect, stripe, dot, t1, t2, tt);
      g.onclick = () => open(n);
      g.onkeydown = (ev) => { if (ev.key === 'Enter' || ev.key === ' ') open(n); };
      svg.appendChild(g);
    }
    wrap.appendChild(svg);
    host.appendChild(wrap);
  }

  function draw() {
    const s0 = scroller(), top = s0.scrollTop, p0 = app.querySelector('.apane'), ptop = p0 ? p0.scrollTop : 0;
    app.replaceChildren(header());
    // With a drawer open the tab splits into three independently scrolling panes: agents / transcript / files.
    app.classList.toggle('asplit', !!sel);
    if (!st) return;
    const full = st, pane = el('div', 'apane');
    app.appendChild(pane);
    if (scope === 'session') st = { ...full, nodes: full.nodes.filter((n) => n.sessionId === full.current), layout: full.layoutCurrent || full.layout };
    try { (mode === 'map' ? drawMap : drawTree)(pane); } finally { st = full; }
    pane.scrollTop = ptop;
    drawDrawer(app);
    scroller().scrollTop = top;
  }

  function dur(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    return s < 60 ? s + 's' : s < 3600 ? Math.floor(s / 60) + 'm ' + (s % 60) + 's' : Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
  }
  function tok(n) { return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n || 0); }
  function section(title, meta) {
    const h = el('div', 'dh', title);
    if (meta) h.appendChild(el('span', 'meta', meta));
    return h;
  }
  /** Collapsible long text: summary line always visible, full text in <details>. */
  function more(label, text) {
    const d = el('details', 'more');
    d.open = openMore.has(label);
    d.addEventListener('toggle', () => { if (d.open) openMore.add(label); else openMore.delete(label); });
    d.appendChild(el('summary', '', label));
    d.appendChild(el('pre', 'txt', text));
    return d;
  }
  /** Markdown-lite via textContent only: fenced code, headings, lists, paragraphs. */
  function md(text) {
    const frag = document.createDocumentFragment();
    const parts = String(text).split(/^```.*$/m);
    parts.forEach((part, i) => {
      if (i % 2 === 1) { frag.appendChild(el('pre', 'code', part.replace(/^\n|\n$/g, ''))); return; }
      for (const blk of part.split(/\n{2,}/)) {
        const lines = blk.split('\n').filter((l) => l.trim());
        if (!lines.length) continue;
        if (lines.every((l) => /^\s*([-*•]|\d+[.)])\s+/.test(l))) {
          const ol = /^\s*\d/.test(lines[0]);
          const list = el(ol ? 'ol' : 'ul', 'mdl');
          lines.forEach((l) => list.appendChild(el('li', '', l.replace(/^\s*([-*•]|\d+[.)])\s+/, ''))));
          frag.appendChild(list);
        } else if (/^#{1,6}\s/.test(lines[0]) && lines.length === 1) frag.appendChild(el('div', 'mdh', lines[0].replace(/^#+\s+/, '')));
        else frag.appendChild(el('p', 'mdp', lines.join('\n')));
      }
    });
    return frag;
  }

  const expanded = new Map(), fullOut = new Set(), kept = new Set();
  let following = true, showAll = false, lastKey = '', intent = 0, durEl = null, icons = {};
  function scroller() {
    const mid = app.querySelector('.dmid');
    if (mid) return mid;
    for (let p = app.parentElement; p; p = p.parentElement) { const o = getComputedStyle(p).overflowY; if ((o === 'auto' || o === 'scroll') && p.scrollHeight > p.clientHeight) return p; }
    return document.scrollingElement || document.documentElement;
  }
  const atBottom = (s) => s.scrollHeight - s.scrollTop - s.clientHeight < 40;
  let listening = false;
  const toBottom = () => requestAnimationFrame(() => { const s = scroller(); s.scrollTop = s.scrollHeight; });
  function listen() {
    if (listening) return;
    listening = true;
    const mark = () => { intent = Date.now(); };
    for (const t of ['wheel', 'touchmove', 'keydown', 'pointerdown']) window.addEventListener(t, mark, { capture: true, passive: true });
    window.addEventListener('scroll', (ev) => {
      const s = scroller(), t = ev.target;
      if (t !== document && t !== s && t !== document.scrollingElement) return;
      if (atBottom(s)) following = true; else if (Date.now() - intent < 600) following = false;
      const pill = app.querySelector('.newpill'); if (pill) pill.hidden = following;
    }, true);
  }

  function toolRow(t, i, running, last) {
    const key = t.id || 'i' + i;
    // Only the latest call is open by default; older ones fold as new calls arrive unless the user toggled them.
    const isOpen = expanded.has(key) ? expanded.get(key) : last;
    const wrap = el('div', 'tcall s-' + t.status);
    const r = el('button', 'trow s-' + t.status);
    r.type = 'button';
    const can = !!(t.input || t.out);
    const sp = t.status === 'run' && running ? el('span', 'ts spin') : el('span', 'ts', t.status === 'ok' ? '✓' : t.status === 'err' ? '✗' : '…');
    r.append(el('span', 'tn', t.name), el('span', 'tt', t.target || ''), t.ms !== undefined ? el('span', 'meta', dur(t.ms)) : el('span'), sp);
    r.title = (t.input || t.target || t.name).slice(0, 400);
    r.setAttribute('aria-expanded', String(isOpen));
    r.onclick = () => {
      if (!can) return;
      expanded.set(key, !isOpen);
      renderDrawer();
    };
    wrap.appendChild(r);
    if (can && isOpen) {
      const body = el('div', 'tbody');
      if (t.input) { body.appendChild(el('div', 'io', 'IN')); body.appendChild(el('pre', 'code', t.input)); }
      if (t.out !== undefined) {
        const lines = t.out.split('\n');
        const all = fullOut.has(key);
        body.appendChild(el('div', 'io', 'OUT'));
        body.appendChild(el('pre', 'code', all || lines.length <= 30 ? t.out : lines.slice(0, 30).join('\n')));
        if (lines.length > 30) {
          const b = el('button', 'dlink', all ? 'Show less' : 'Show full output (' + lines.length + ' lines)');
          b.type = 'button';
          b.onclick = () => { all ? fullOut.delete(key) : fullOut.add(key); renderDrawer(); };
          body.appendChild(b);
        }
      }
      wrap.appendChild(body);
    }
    return wrap;
  }

  function fileRow(f) {
    const r = el('div', 'frow');
    r.tabIndex = 0; r.title = 'Diff ' + f.path;
    const img = el('img', 'ficon');
    if (icons[f.icon]) img.src = icons[f.icon];
    img.alt = '';
    const act = el('span', 'facts');
    const mk = (label, fn) => { const b = el('button', 'fbtn', label); b.type = 'button'; b.onclick = (ev) => { ev.stopPropagation(); fn(); }; return b; };
    const ref = { sessionId: sel.sessionId, agentId: sel.agentId };
    const diff = () => postFn({ type: 'diffFile', ...ref, path: f.path });
    act.append(mk('Diff', diff), mk('Open', () => postFn({ type: 'openFile', ...ref, path: f.path })), mk('Keep', () => { kept.add(sel.id + '|' + f.path); renderDrawer(); }));
    r.append(img, el('span', 'tt', f.name), el('span', 'add', '+' + f.added), el('span', 'del', '−' + f.removed), act);
    r.onclick = diff;
    r.onkeydown = (ev) => { if (ev.key === 'Enter') diff(); };
    return r;
  }

  function buildDrawer() {
    let box = el('div', 'drawer');
    box.setAttribute('aria-label', 'Agent details');
    durEl = null;
    let d = detail && detail.id === sel.id && detail.sessionId === sel.sessionId ? detail : undefined;
    // One status source: the map node (AgentService state) wins over a possibly stale detail payload.
    const nd = d && st && st.nodes.find((x) => x.id === sel.id);
    if (nd) d = { ...d, state: nd.state, stateText: nd.stateText, end: nd.end || d.end };
    const close = el('button', 'dclose', '✕');
    close.type = 'button'; close.title = 'Close details'; close.setAttribute('aria-label', 'Close details');
    close.onclick = () => { sel = undefined; detail = undefined; postFn({ type: 'closeDetail' }); draw(); };
    if (!d) { box.append(close, el('div', 'empty', 'Loading details…')); return box; }
    const running = d.state === 'running';
    const head = el('div', 'dhead');
    head.appendChild(el('div', 'dtitle', d.title));
    const chips = el('div', 'dchips');
    if (d.type) chips.appendChild(el('span', 'chip', d.type));
    if (d.model) { const f = /opus/i.test(d.model) ? 'opus' : /sonnet/i.test(d.model) ? 'sonnet' : /haiku/i.test(d.model) ? 'haiku' : ''; chips.appendChild(el('span', 'chip' + (f ? ' f-' + f : ''), f || d.model)); }
    chips.appendChild(el('span', 'chip s-' + d.state, d.stateText));
    if (d.since) { durEl = el('span', 'meta', dur((d.end || Date.now()) - d.since)); durEl.dataset.since = String(d.since); if (!d.end && running) durEl.dataset.live = '1'; chips.appendChild(durEl); }
    if (d.tokens) chips.appendChild(el('span', 'meta', tok(d.tokens) + ' tokens'));
    const link = el('button', 'dlink', 'Open full transcript');
    link.type = 'button';
    link.onclick = () => postFn({ type: 'open', sessionId: sel.sessionId, agentId: sel.agentId });
    chips.appendChild(link);
    head.appendChild(chips);
    box.append(close, head);
    const outer = box, mid = el('div', 'dmid');
    box.appendChild(mid);
    box = mid;
    if (d.promptHead) {
      box.appendChild(section('Prompt'));
      box.appendChild(el('pre', 'txt', d.promptHead));
      if (d.prompt.length > d.promptHead.length) box.appendChild(more('Full prompt', d.prompt));
    }
    if (d.tools.length) {
      box.appendChild(section('Tool calls', String(d.tools.length)));
      const l = el('div', 'tlist');
      const lt = d.tools[d.tools.length - 1], lk = lt.id || 'i' + (d.tools.length - 1);
      if (lk !== lastKey) { lastKey = lk; expanded.clear(); } // a new call arrived: fold everything older
      const skip = showAll ? 0 : Math.max(0, d.tools.length - 40);
      if (skip) {
        const b = el('button', 'dlink', 'Show ' + skip + ' earlier');
        b.type = 'button';
        b.onclick = () => { showAll = true; renderDrawer(); };
        l.appendChild(b);
      }
      d.tools.forEach((t, i) => { if (i >= skip) l.appendChild(toolRow(t, i, running, i === d.tools.length - 1)); });
      box.appendChild(l);
    }
    if (d.result) {
      box.appendChild(section('Result'));
      const full = openMore.has('result');
      const r = el('div', 'md');
      r.appendChild(md(full ? d.resultFull : d.result));
      box.appendChild(r);
      if (d.resultMore) {
        const b = el('button', 'dlink', full ? 'Show less' : 'Show full result');
        b.type = 'button';
        b.onclick = () => { full ? openMore.delete('result') : openMore.add('result'); renderDrawer(); };
        box.appendChild(b);
      }
    }
    const pill = el('button', 'newpill', '↓ New activity');
    pill.type = 'button'; pill.hidden = following;
    pill.onclick = () => { following = true; toBottom(); pill.hidden = true; };
    mid.appendChild(pill);
    const files = d.files.filter((f) => !kept.has(d.id + '|' + f.path));
    if (files.length) {
      const fbox = el('div', 'dfiles');
      fbox.appendChild(section('Files changed', String(files.length)));
      files.forEach((f) => fbox.appendChild(fileRow(f)));
      outer.appendChild(fbox);
    }
    return outer;
  }

  /** Replaces only the drawer (keeps scroll; follows the newest item while running unless the user scrolled up). */
  function renderDrawer(stick) {
    const old = app.querySelector('.drawer');
    if (!sel) return;
    listen();
    const top = scroller().scrollTop, f0 = app.querySelector('.dfiles'), ftop = f0 ? f0.scrollTop : 0, box = buildDrawer();
    if (old) old.replaceWith(box); else app.appendChild(box);
    const f1 = box.querySelector('.dfiles'); if (f1) f1.scrollTop = ftop;
    if (stick && following) toBottom(); else scroller().scrollTop = top;
  }
  function drawDrawer() { if (sel) { listen(); app.appendChild(buildDrawer()); } }
  setInterval(() => { if (durEl && durEl.dataset.live && durEl.isConnected) durEl.textContent = dur(Date.now() - Number(durEl.dataset.since)); }, 1000);

  const tab = {
    render(root, state, post) {
      app = root; postFn = post;
      if (state && Array.isArray(state.nodes) && state.layout) {
        st = state;
        // Keep a running agent's drawer fresh (at most every 3s).
        const n = sel && st.nodes.find((x) => x.id === sel.id);
        if (n && n.state === 'running' && Date.now() - lastReq > 3000) request(n);
      }
      draw();
    },
    onMessage(m) {
      if (m.type === 'detail' && m.detail && typeof m.detail === 'object') {
        detail = m.detail;
        if (m.icons && typeof m.icons === 'object') icons = m.icons;
        if (app.dataset.tab === 'agents' && sel) { if (app.querySelector('.drawer')) renderDrawer(true); else { draw(); if (following) toBottom(); } }
      }
    }
  };
  window.CCC_TABS.agents = tab;
  setInterval(() => { if (st && mode === 'tree' && app.dataset.tab === 'agents' && !sel) { st.now = Date.now(); draw(); } }, 5000);
})();
