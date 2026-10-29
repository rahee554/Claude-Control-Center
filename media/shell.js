// Tab shell: icon tab bar + one tab body. Tab modules register window.CCC_TABS[id] = { render(root, state, post), onMessage?(msg) }.
// Text via textContent only; every host message is { tab, ... }, every message we send carries `tab`.
(function () {
  'use strict';
  const api = acquireVsCodeApi();
  const NS = 'http://www.w3.org/2000/svg';
  const TABS = [
    ['activity', 'Activity', 'M1.5 8h3l2-5 3 10 2-5h3'],
    ['changes', 'Changes', 'M2.5 2.5h11v11h-11zM8 2.5v11M4.5 6h2M9.5 10h2'],
    ['agents', 'Agents', 'M5 6a2 2 0 1 0 0-.01M11 6a2 2 0 1 0 0-.01M1.5 13c.5-2 2-3 3.5-3s3 1 3.5 3M8 13c.5-2 2-3 3-3s2.5 1 3 3'],
    ['accounts', 'Accounts', 'M8 2.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5M3 13.5c.5-3 2.5-4.5 5-4.5s4.5 1.5 5 4.5'],
    ['checkpoints', 'Checkpoints', 'M3 2.5h10v11L8 10.5l-5 3zM3 5.5h10'],
    ['settings', 'Settings', 'M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4']
  ];
  const IDS = TABS.map((t) => t[0]);
  const store = (function () { const s = api.getState(); return s && typeof s === 'object' ? s : {}; })();
  let active = IDS.includes(store.tab) ? store.tab : 'activity';
  let chosen = IDS.includes(store.tab);
  const badges = { changes: 0, agents: 0 };
  const states = {};
  let drawn;
  const btns = {};

  window.CCC_TABS = {};
  window.CCC_STORE = {
    get(ns) { const v = store[ns]; return v && typeof v === 'object' ? v : {}; },
    set(ns, v) { store[ns] = v; api.setState(store); }
  };
  const post = (tab) => (msg) => api.postMessage(Object.assign({}, msg, { tab }));
  window.CCC_SHELL = { select: (id) => select(id, true) };

  function icon(d) {
    const s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', '0 0 16 16'); s.setAttribute('class', 'tico'); s.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); s.appendChild(p);
    return s;
  }
  function buildBar() {
    const bar = document.getElementById('tabs');
    bar.replaceChildren();
    TABS.forEach(([id, label, d]) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'tab'; b.dataset.id = id;
      b.setAttribute('role', 'tab'); b.title = label; b.setAttribute('aria-label', label);
      b.appendChild(icon(d));
      b.appendChild(Object.assign(document.createElement('span'), { className: 'tlabel', textContent: label }));
      b.appendChild(Object.assign(document.createElement('span'), { className: 'tbadge' }));
      b.addEventListener('click', () => select(id, true));
      b.addEventListener('keydown', (ev) => {
        const vis = TABS.map((t) => t[0]);
        const i = vis.indexOf(active);
        const to = ev.key === 'ArrowRight' ? vis[(i + 1) % vis.length] : ev.key === 'ArrowLeft' ? vis[(i + vis.length - 1) % vis.length] : ev.key === 'Home' ? vis[0] : ev.key === 'End' ? vis[vis.length - 1] : undefined;
        if (to) { ev.preventDefault(); select(to, true); btns[to].focus(); }
      });
      btns[id] = b; bar.appendChild(b);
    });
    paintBar();
  }
  function paintBar() {
    TABS.forEach(([id, label]) => {
      const b = btns[id];
      const on = id === active;
      b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1;
      const n = badges[id] || 0;
      const el = b.querySelector('.tbadge');
      el.textContent = n > 99 ? '99+' : n > 0 ? String(n) : '';
      el.hidden = n <= 0;
      b.setAttribute('aria-label', label + (n > 0 ? ', ' + n : ''));
    });
  }
  function select(id, notify) {
    if (!IDS.includes(id)) id = 'activity';
    chosen = true;
    if (id !== active) { active = id; store.tab = id; api.setState(store); }
    paintBar(); draw();
    if (notify) api.postMessage({ tab: 'shell', type: 'select', id });
  }
  function draw() {
    const root = document.getElementById('root');
    root.dataset.tab = active;
    const mod = window.CCC_TABS[active];
    if (drawn !== active) { root.replaceChildren(); drawn = active; }
    if (!mod) { root.textContent = 'This tab is unavailable.'; return; }
    try { mod.render(root, states[active], post(active)); } catch (e) { root.textContent = 'This tab failed to render.'; }
  }
  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (!m || typeof m !== 'object' || typeof m.tab !== 'string') return;
    if (m.tab === 'shell') {
      if (m.type === 'init') {
        if (m.badges && typeof m.badges === 'object') { badges.changes = Number(m.badges.changes) || 0; badges.agents = Number(m.badges.agents) || 0; }
        if (!chosen && IDS.includes(m.active)) { active = m.active; chosen = true; draw(); }
        paintBar();
      } else if (m.type === 'show' && IDS.includes(m.id)) select(m.id, false);
      return;
    }
    if (!IDS.includes(m.tab)) return;
    const mod = window.CCC_TABS[m.tab];
    if (m.type === 'state') { states[m.tab] = m.state; if (m.tab === active) draw(); }
    if (mod && mod.onMessage) { try { mod.onMessage(m); } catch (e) { /* a tab bug must not break the shell */ } }
  });
  document.addEventListener('DOMContentLoaded', () => {
    buildBar(); draw();
    api.postMessage({ tab: 'shell', type: 'ready' });
  });
})();
