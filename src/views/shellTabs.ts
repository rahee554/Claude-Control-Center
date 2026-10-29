// Tab routing for the single sidebar webview. vscode-free so it can be unit-tested.
export const TAB_IDS = ['activity', 'changes', 'agents', 'accounts', 'checkpoints', 'settings'] as const;
export type TabId = (typeof TAB_IDS)[number];
/** Tabs served by the dashboard controller (one shared state/validation path). */
export const DASH_TABS: ReadonlySet<string> = new Set(['activity', 'changes', 'accounts', 'settings']);

export function isTab(x: unknown): x is TabId { return typeof x === 'string' && (TAB_IDS as readonly string[]).includes(x); }

export type ShellMsg = { type: 'ready' } | { type: 'select'; id: TabId };

/** Parses a message the webview addressed to the shell itself (`tab: 'shell'`). */
export function parseShellMsg(m: unknown): ShellMsg | undefined {
  if (!m || typeof m !== 'object') return undefined;
  const o = m as Record<string, unknown>;
  if (o.tab !== 'shell') return undefined;
  if (o.type === 'ready') return { type: 'ready' };
  if (o.type === 'select' && isTab(o.id)) return { type: 'select', id: o.id };
  return undefined;
}

/** Where a webview message goes: a known tab id, 'shell', or undefined (dropped). */
export function routeOf(m: unknown): TabId | 'shell' | undefined {
  const t = m && typeof m === 'object' ? (m as Record<string, unknown>).tab : undefined;
  return t === 'shell' ? 'shell' : isTab(t) ? t : undefined;
}
