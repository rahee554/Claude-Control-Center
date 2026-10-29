// original: file text before the session's first edit (null = created this session, or too large to keep)
export type Changed = { path: string; added: number; removed: number; original?: string | null }
export type Usage = { contextPct?: number; fiveHour?: number; sevenDay?: number }

declare module 'claude-code' {
  interface PluginState {
    'control-center': {
      files: Shaped<Changed[]>
      subagents: number
      usage: Shaped<Usage>
      isHidden: boolean
      cwd: string
      isCollapsed: boolean
      showAll: boolean
    }
  }
}
