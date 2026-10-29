import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'control-center',
  component: 'Pane',
  requestId: 'ccc-changes',
  props: { title: 'Changes', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

test('an Edit result shows as a changed file with counts, on every surface', async ($, on) => {
  on('command.register', () => ({ value: { command: 'ccc-changes' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.surfaces', () => ({ value: ['vscode'] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: { filePath: '/w/src/a.ts', structuredPatch: [{ lines: [' x', '-y', '+z', '+w'] }] } }))

  await $.session.start({ cwd: '/', surface: 'vscode', isInteractive: true })
  await $.tool.call({ tool: 'Edit', file_path: '/w/src/a.ts', old_string: 'y', new_string: 'z\nw' })

  for (const surface of ['terminal', 'desktop', 'vscode'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Button', key: 'toggle' }))?.props.label).toContain('1 file changed')
    await ui.press({ key: 'toggle' })
    expect(await ui.find({ type: 'Text', text: /^a\.ts$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Button', key: 'open:/w/src/a.ts' })).toBeTruthy()
    await ui.press({ key: 'toggle' })
    expect((await ui.find({ type: 'Text', text: /subagents/ }))).toBeFalsy()
    await ui.unmount()
  }
})

const BAND = {
  plugin: 'control-center',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 80, scroll: { offset: 0, bodyRows: 19 }, view: {} },
} as const

test('the band above the prompt collapses, and Undo restores the original text', async ($, on) => {
  const writes: { path: string; text: string }[] = []
  on('command.register', () => ({ value: { command: 'ccc-changes' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.write', (_, e) => (writes.push(e), { value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.render', ($, e) => { const { Text } = $.ui.resolve(e); return <Text>engine</Text> })
  on('tool.call', () => ({ result: { filePath: '/w/b.ts', originalFile: 'old', structuredPatch: [{ lines: ['-old', '+new'] }] } }))

  await $.session.start({ cwd: '/', surface: 'vscode', isInteractive: true })
  await $.tool.call({ tool: 'Edit', file_path: '/w/b.ts', old_string: 'old', new_string: 'new' })

  const ui = await $.ui.mount({ ...BAND, surface: 'vscode' })
  expect(await ui.find({ type: 'Button', key: 'open:/w/b.ts' })).toBeFalsy()
  await ui.press({ key: 'toggle' })
  expect(await ui.find({ type: 'Button', key: 'open:/w/b.ts' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^\/w\/b\.ts$/ })).toBeFalsy() // basename only, one row per file
  await ui.press({ key: 'undo:/w/b.ts' })
  expect(writes).toEqual([{ path: expect.stringMatching(/w.b.ts$/), text: 'old' }])
  expect(await ui.find({ type: 'Button', key: 'open:/w/b.ts' })).toBeFalsy()
  await ui.unmount()
})
