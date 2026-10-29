// Regenerates docs/images/*.png. Needs `npm run compile` first (uses out/src) and Edge or Chrome. No dependencies.
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const root = path.resolve(__dirname, '..', '..');
const dir = __dirname;
const images = path.join(root, 'docs', 'images');
const gen = path.join(dir, '.gen');
const browser = [process.env.BROWSER_EXE, 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => p && fs.existsSync(p));
if (!browser) throw new Error('No Edge/Chrome found; set BROWSER_EXE');

const out = (f) => path.join(root, 'out', 'src', 'views', f);
const { layoutMap } = require(out('agentsMap.js'));
const { SETTINGS } = require(out('settingsView.js'));
const { buildCard } = require(out('statusCard.js'));

// Layout must match the node ids/parents in mock.js.
const S = '11111111-2222-3333-4444-555555555555';
const layout = layoutMap([{ id: S }, { id: 'a1', parent: S }, { id: 'a2', parent: S }, { id: 'a3', parent: 'a1' }, { id: 'task:1' }]);
const values = Object.fromEntries(SETTINGS.map((d) => [d.key, d.def]));
fs.mkdirSync(gen, { recursive: true });
fs.mkdirSync(images, { recursive: true });
fs.writeFileSync(path.join(gen, 'gen.js'), `window.GEN=${JSON.stringify({ layout, settings: { defs: SETTINGS, values, accounts: [{ id: 'main', label: 'you@example.com' }, { id: 'sub1', label: 'team-sub' }] } })};`);

// Status bar hover card: render the real markdown with a tiny converter.
const now = Date.now();
const md = buildCard({ now, account: { plan: 'Max' }, fiveHour: { pct: 37, resetsAt: (now + 2 * 3600e3) / 1000 }, sevenDay: { pct: 71, resetsAt: (now + 3 * 86400e3) / 1000 }, context: { pct: 42, tokens: 84000 },
  active: 2, models: { opus: 58, sonnet: 30, haiku: 12 }, tasks: 1, paused: false });
const html = md.split('\n').map((l) => l
  .replace(/\[([^\]]+)\]\(command:[^)]*\)/g, '<a href="#">$1</a>').replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/(^|[\s(])_(.+?)_/g, '$1<i>$2</i>')
  .replace(/\$\((ccc-claude|sync)\)/g, (m, n) => (n === 'sync' ? '&#8635;' : '&#10033;')).replace(/\\([\\`*_{}[\]()#+\-.!|<>])/g, '$1') + '<br>').join('\n');
fs.writeFileSync(path.join(dir, '.gen', 'status-card.html'), `<!DOCTYPE html><meta charset="utf-8"><body style="margin:0;background:#1f1f1f;padding:18px"><div style="width:340px;box-sizing:border-box;background:#202020;border:1px solid #454545;border-radius:6px;padding:10px 14px;color:#ccc;font:13px/1.5 'Segoe UI',sans-serif;box-shadow:0 2px 8px #000a">${html}</div><style>a{color:#4daafc;text-decoration:none}</style>`);

fs.writeFileSync(path.join(dir, '.gen', 'chat-band.html'), `<!DOCTYPE html><meta charset="utf-8"><body style="margin:0;background:#1f1f1f;padding:16px;font:13px 'Segoe UI',sans-serif;color:#ccc;width:520px">
<div style="font-size:11px;color:#9d9d9d;margin-bottom:6px">Illustration: the band the optional mod adds above the Claude Code chat prompt</div>
<div style="border:1px solid #313131;border-radius:6px;background:#181818;padding:8px 10px;display:flex;gap:10px;align-items:center"><span style="color:#cca700">&#9679;</span><b>3 files changed</b><span style="color:#81b88b">+111</span><span style="color:#c74e39">&minus;9</span><span style="flex:1"></span><span style="background:#0078d4;color:#fff;border-radius:3px;padding:2px 8px">Keep all</span><span style="background:#313131;border-radius:3px;padding:2px 8px">Undo all</span></div>
<div style="margin-top:8px;border:1px solid #3c3c3c;border-radius:6px;background:#313131;padding:10px;color:#989898">Message Claude&hellip;</div>`);

const shots = [['activity', 'activity.png', '420,720'], ['changes', 'changes.png', '420,300'], ['agents', 'agents-map.png', '560,215'], ['checkpoints', 'checkpoints.png', '420,350'], ['settings', 'settings.png', '420,860']];
const snap = (url, file, size) => execFileSync(browser, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=2', `--window-size=${size}`, `--screenshot=${path.join(images, file)}`, '--virtual-time-budget=2000', url], { stdio: 'ignore' });
for (const [tab, file, size] of shots) snap(pathToFileURL(path.join(dir, 'harness.html')).href + `?tab=${tab}&w=${size.split(',')[0]}`, file, size);
snap(pathToFileURL(path.join(gen, 'status-card.html')).href, 'status-card.png', '400,330');
snap(pathToFileURL(path.join(gen, 'chat-band.html')).href, 'chat-band.png', '552,150');
setTimeout(() => console.log('Wrote', fs.readdirSync(images).join(', ')), 3000); // Edge flushes the PNG shortly after exiting
