// Pure terminal ownership classification. Decides what the extension may close.

export enum Ownership {
  ExtensionOwned = 'extensionOwned',
  ClaudeConfirmed = 'claudeConfirmed',
  ClaudeLikely = 'claudeLikely',
  /** Read-only pseudoterminal mirroring a session's shell commands. Never part of group termination. */
  ClaudeMirror = 'claudeMirror',
  Unrelated = 'unrelated',
  Unknown = 'unknown'
}

export const OWNER_ENV = 'CCC_OWNER';
export const SESSION_ENV = 'CCC_SESSION';

export interface OwnershipInput {
  /** Value of env[CCC_OWNER] in the terminal's creationOptions. */
  ownerTag?: string;
  /** This extension instance's tag. */
  expectedTag: string;
  terminalPid?: number;
  name: string;
  /** Session id when the terminal is one of our mirror pseudoterminals. */
  mirrorSessionId?: string;
  shellHint?: string;
  /** Ancestor pid -> session ids whose hook-reported pid descends from it. */
  claudeAncestors: Map<number, string[]>;
}

export interface OwnershipResult {
  ownership: Ownership;
  sessionIds: string[];
}

export function classifyTerminal(i: OwnershipInput): OwnershipResult {
  if (i.mirrorSessionId) return { ownership: Ownership.ClaudeMirror, sessionIds: [i.mirrorSessionId] };
  if (i.ownerTag !== undefined && i.ownerTag === i.expectedTag) {
    const sessionIds = i.terminalPid !== undefined ? (i.claudeAncestors.get(i.terminalPid) ?? []) : [];
    return { ownership: Ownership.ExtensionOwned, sessionIds };
  }
  if (i.terminalPid !== undefined) {
    const s = i.claudeAncestors.get(i.terminalPid);
    if (s?.length) return { ownership: Ownership.ClaudeConfirmed, sessionIds: s };
  }
  if (/claude/i.test(i.name) || /claude/i.test(i.shellHint ?? '')) return { ownership: Ownership.ClaudeLikely, sessionIds: [] };
  return { ownership: i.terminalPid === undefined ? Ownership.Unknown : Ownership.Unrelated, sessionIds: [] };
}

/** Group termination is allowed only for terminals we created or that are proven to host the session. */
export function canTerminateAsGroup(o: Ownership): boolean {
  return o === Ownership.ExtensionOwned || o === Ownership.ClaudeConfirmed;
}

/** Builds ancestor->sessions map from hook pids and their resolved ancestor chains. */
export function buildAncestorMap(chains: { sessionId: string; chain: number[] }[]): Map<number, string[]> {
  const m = new Map<number, string[]>();
  for (const { sessionId, chain } of chains) {
    for (const p of chain) {
      const cur = m.get(p) ?? [];
      if (!cur.includes(sessionId)) m.set(p, [...cur, sessionId]);
    }
  }
  return m;
}
