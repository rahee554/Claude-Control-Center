// Checkpoints tab. All text via textContent; messages carry ids/paths only (validated host-side).
(function () {
  'use strict';
  const open = new Set();
  const details = {};
  let post = () => {};
  let last;
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const btn = (label, fn, cls) => { const b = el('button', cls, label); b.type = 'button'; b.addEventListener('click', fn); return b; };
  function ago(iso) {
    const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    return Math.floor(s / 86400) + ' d ago';
  }
  const size = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.ceil(n / 1024) + ' KB');
  function item(it) {
    const box = el('div', 'item');
    box.appendChild(el('div', 'name', it.name));
    const meta = el('div', 'meta');
    meta.appendChild(el('span', 'badge', it.trigger));
    meta.appendChild(document.createTextNode(ago(it.createdAt) + ' - ' + it.fileCount + ' files, ' + size(it.size) + (typeof it.changed === 'number' ? ' - ' + it.changed + ' changed since' : '')));
    box.appendChild(meta);
    const row = el('div', 'row');
    const isOpen = open.has(it.id);
    row.appendChild(btn(isOpen ? 'Hide changes' : 'Changes', () => {
      if (isOpen) open.delete(it.id); else { open.add(it.id); post({ type: 'expand', id: it.id }); }
      render(last.root, last.state);
    }));
    row.appendChild(btn('Restore all', () => post({ type: 'restoreAll', id: it.id }), 'pri'));
    row.appendChild(btn('Delete', () => post({ type: 'delete', id: it.id })));
    box.appendChild(row);
    if (isOpen) {
      const d = details[it.id];
      if (!d) box.appendChild(el('div', 'meta', 'Loading...'));
      else if (!d.length) box.appendChild(el('div', 'meta', 'No changes since this checkpoint.'));
      else d.slice(0, 300).forEach((c) => {
        const f = el('div', 'file');
        f.appendChild(el('span', 'k-' + c.kind, c.kind === 'added' ? 'A' : c.kind === 'deleted' ? 'D' : 'M'));
        const p = el('span', 'p', c.path); p.title = c.path; f.appendChild(p);
        if (c.kind !== 'added') {
          f.appendChild(btn('Diff', () => post({ type: 'diff', id: it.id, path: c.path })));
          f.appendChild(btn('Restore', () => post({ type: 'restoreFile', id: it.id, path: c.path })));
        }
        box.appendChild(f);
      });
    }
    return box;
  }
  function render(root, state, p) {
    if (p) post = p;
    last = { root, state };
    root.replaceChildren();
    const wrap = el('div', 'ckp');
    root.appendChild(wrap);
    if (!state) { wrap.appendChild(el('div', 'empty', 'Loading...')); return; }
    if (state.noWorkspace) { wrap.appendChild(el('div', 'empty', 'Open a folder to use checkpoints.')); return; }
    const row = el('div', 'row');
    const c = btn(state.busy ? 'Working...' : 'Create checkpoint', () => post({ type: 'create' }), 'pri');
    c.disabled = !!state.busy;
    row.appendChild(c);
    row.appendChild(btn('Refresh', () => post({ type: 'refresh' })));
    wrap.appendChild(row);
    if (!state.items.length) wrap.appendChild(el('div', 'empty', 'No checkpoints yet. They snapshot your workspace files independent of git.'));
    state.items.forEach((it) => wrap.appendChild(item(it)));
  }
  window.CCC_TABS = window.CCC_TABS || {};
  window.CCC_TABS.checkpoints = {
    render,
    onMessage(m) {
      if (m.type === 'detail' && typeof m.id === 'string' && Array.isArray(m.changes)) {
        details[m.id] = m.changes.filter((c) => c && typeof c.path === 'string' && ['added', 'modified', 'deleted'].includes(c.kind));
        if (last && document.getElementById('root').dataset.tab === 'checkpoints') render(last.root, last.state);
      }
    }
  };
})();
