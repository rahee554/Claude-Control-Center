// Maps a file name to a vendored Material icon id and a data: URI (webview CSP allows img-src data:). vscode-free.
import { ICONS } from '../../mod/icons/icons';

const BY_EXT: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'json', md: 'markdown', mdx: 'markdown', css: 'css', scss: 'css', less: 'css', html: 'html', htm: 'html', py: 'python',
  txt: 'document', toml: 'settings', yml: 'settings', yaml: 'settings', ini: 'settings', env: 'settings'
};

export function iconId(name: string): string {
  const n = name.toLowerCase();
  if (/\.(test|spec)\.[jt]sx?$/.test(n)) return 'test-ts';
  return BY_EXT[n.slice(n.lastIndexOf('.') + 1)] ?? 'file';
}

export function iconUri(id: string): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(ICONS[id] ?? ICONS.file)}`;
}
