// ccc-changes mod: Copilot-style "N files changed +A -R  Keep Undo" strip above the prompt.
// Data comes from the mods API itself: tool.call results (structuredPatch) and session.measure.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderInput } from 'claude-code'

import type { Changed } from '../types'
import { ICONS } from '../icons/icons'
import { shortPath, shortName } from './shortPath'

const PANE = 'ccc-changes'
const files = atom({ plugin: 'control-center', key: 'files' } as const, [], { shape: 'files-1' })
const isCollapsed = atom({ plugin: 'control-center', key: 'isCollapsed' } as const, true)
const MAX_ORIGINAL = 256 * 1024 // ponytail: originals over 256KB are not kept, so no Undo for them
const showAll = atom({ plugin: 'control-center', key: 'showAll' } as const, false)
const isHidden = atom({ plugin: 'control-center', key: 'isHidden' } as const, false)

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
type PatchResult = { filePath?: string; type?: string; content?: string; originalFile?: string | null; structuredPatch?: { lines?: string[] }[] }

function count(r: PatchResult): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const h of r.structuredPatch ?? []) {
    for (const l of h.lines ?? []) {
      if (l.startsWith('+')) added++
      else if (l.startsWith('-')) removed++
    }
  }
  if (r.type === 'create' && added === 0 && typeof r.content === 'string') added = r.content.split('\n').length
  return { added, removed }
}

const slash = (p: string) => p.split('\\').join('/')
const base = (p: string) => slash(p).split('/').pop() ?? p
const cwdAtom = atom({ plugin: 'control-center', key: 'cwd' } as const, '')

const ROWS = 6 // ponytail: rows shown before "+K more"; the band also scrolls past maxRows

async function enabled($: EngineInterface): Promise<boolean> {
  try {
    const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
    if (!home) return true
    const text = await $.fs.read(`${home}/.control-center/config.json`)
    return JSON.parse(String(text)).chatBox !== false
  } catch {
    return true // no file / unreadable -> default on
  }
}

// Bridge to the VS Code extension: the mods API cannot call VS Code, so drop a request file it watches.
async function openDiff($: EngineInterface, path: string) {
  try {
    const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
    if (!home) return
    const ts = Date.now()
    const name = `${ts}-${Math.random().toString(36).slice(2, 10)}.json`
    await $.fs.write(`${home}/.control-center/requests/${name}`, JSON.stringify({ v: 1, action: 'openDiff', path, sessionId: await $.session.id(), ts }))
  } catch {
    // bridge is best effort
  }
}

async function undoAll($: EngineInterface, list: Changed[]) {
  const ok = list.filter(f => typeof f.original === 'string')
  for (const f of ok) await $.fs.write(f.path, f.original as string)
  await update($, files, l => l.filter(x => !ok.some(f => f.path === x.path)))
  $.ui.toast(`Restored ${ok.length} ${ok.length === 1 ? 'file' : 'files'}`)
}

// File icon: real Material Icon Theme SVGs (vendored) via Svg; terminal has no Svg, so a plain glyph there.
const BY_EXT: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', md: 'markdown', css: 'css', html: 'html', py: 'python', txt: 'document',
}
const BY_NAME: Record<string, string> = { 'tsconfig.json': 'settings', '.eslintrc.json': 'settings', '.editorconfig': 'settings' }
function iconId(p: string): string {
  const n = base(p).toLowerCase()
  if (BY_NAME[n]) return BY_NAME[n]
  if (/\.(test|spec)\.tsx?$/.test(n)) return 'test-ts'
  return BY_EXT[n.split('.').pop() ?? ''] ?? 'file'
}

async function keepOne($: EngineInterface, path: string) {
  await update($, files, l => l.filter(x => x.path !== path))
}

async function tree($: EngineInterface, e: RenderInput<'AbovePrompt' | 'Pane'>, max: number) {
  const { Box, Text, Button, Svg } = $.ui.resolve(e) as ReturnType<typeof $.ui.resolve> & { Svg?: typeof Text }
  const list = await read($, files)
  const open = !(await read($, isCollapsed)) // atom name kept; false = collapsed (Copilot default)
  const all = await read($, showAll)
  const added = list.reduce((s, f) => s + f.added, 0)
  const removed = list.reduce((s, f) => s + f.removed, 0)
  const newest = [...list].reverse()
  const shown = open ? (all ? newest : newest.slice(0, Math.max(1, max))) : []
  const cwd = await read($, cwdAtom)
  const home = (await $.env.get('USERPROFILE').catch(() => '')) || (await $.env.get('HOME').catch(() => '')) || ''
  const canUndo = list.some(f => typeof f.original === 'string')
  // ponytail: vscode ignores `hover` and `plain`; Button is always a native button (dimColor = ghost, else green). Rows use dim Buttons only for actions.
  return (
    <Box flexDirection="column">
      <Box gap={1}>
        <Text dimColor>{open ? '⌄' : '›'}</Text>
        <Button key="toggle" dimColor label={`${list.length} ${list.length === 1 ? 'file' : 'files'} changed`} onPress={() => update($, isCollapsed, v => !v)} />
        <Text color="green">+{added}</Text>
        <Text color="red">-{removed}</Text>
        <Box flexGrow={1} />
        <Button key="keep" label="Keep" onPress={() => update($, files, () => [])} />
        {canUndo && <Button key="undo" dimColor label="Undo" onPress={() => undoAll($, list)} />}
      </Box>
      {shown.map(f => {
        const dir = shortPath(f.path, cwd, home)
        const id = iconId(f.path)
        const canRestore = typeof f.original === 'string'
        return (
          <Box key={f.path} gap={1} paddingLeft={2}>
            {Svg ? <Svg source={ICONS[id]} alt={id} width={14} height={14} /> : <Text dimColor>·</Text>}
            <Text>{shortName(base(f.path))}</Text>
            {dir && <Text dimColor>{dir}</Text>}
            {!canRestore && <Text dimColor>new</Text>}
            <Box flexGrow={1} />
            <Box flexShrink={0} gap={1}>
              <Text color="green">+{f.added}</Text>
              <Text color="red">-{f.removed}</Text>
              <Button key={`open:${f.path}`} dimColor label="⇄" onPress={() => openDiff($, f.path)} />
              <Button key={`keep:${f.path}`} dimColor label="✓" onPress={() => keepOne($, f.path)} />
              {canRestore && <Button key={`undo:${f.path}`} dimColor label="↶" onPress={() => undoAll($, [f])} />}
            </Box>
          </Box>
        )
      })}
      {open && list.length > Math.max(1, max) && (
        <Button key="more" plain dimColor label={all ? '  show less' : `  +${list.length - shown.length} more`} onPress={() => update($, showAll, v => !v)} />
      )}
    </Box>
  )
}

async function record($: EngineInterface, r: PatchResult) {
  if (typeof r.filePath !== 'string') return
  const path = r.filePath
  const { added, removed } = count(r)
  const first: string | null = typeof r.originalFile === 'string' && r.originalFile.length <= MAX_ORIGINAL ? r.originalFile : null
  await update($, files, list => {
    const rest = list.filter(f => f.path !== path)
    const cur = list.find(f => f.path === path) ?? { path, added: 0, removed: 0, original: first }
    return [...rest, { ...cur, added: cur.added + added, removed: cur.removed + removed }].slice(-200)
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await update($, cwdAtom, () => e.cwd ?? '')
    await $.command.register({ name: 'ccc-changes', description: 'Show or hide the changed-files band (arg pane opens it as a pane)', argumentHint: '[pane]' })
    return next(e)
  })

  on('command.run', { command: 'ccc-changes' }, async ($, e) => {
    if (e.args.trim() === 'pane') {
      await $.ui.open({ id: PANE, title: 'Changes' })
      return { text: 'Changes pane opened.' }
    }
    const hidden = await update($, isHidden, v => !v)
    return { text: hidden ? 'Changed-files band hidden.' : 'Changed-files band shown.' }
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (EDIT_TOOLS.has(e.tool) && 'result' in ran && ran.result && typeof ran.result === 'object') {
      await record($, ran.result as PatchResult).catch(() => undefined) // never fail the tool call
    }
    return ran
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isHidden)) || !(await enabled($)) || (await read($, files)).length === 0) return next(e)
    return tree($, e, Math.max(1, Math.min(ROWS, e.props.maxRows - 3)))
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => tree($, e, Math.max(1, (e.viewport?.rows ?? 12) - 3)))
}
