import { expect, test } from 'claude-code/testing'
import { shortPath, shortName } from '../hooks/shortPath'

test('shortPath: relative, home, compressed, capped', async () => {
  expect(shortPath('C:\\w\\src\\a\\x.ts', 'C:/w', 'C:/Users/me')).toBe('src/a')
  expect(shortPath('C:/Users/me/p/x.ts', '/other', 'C:/Users/me')).toBe('~/p')
  expect(shortPath('C:/Users/me/AppData/Local/Temp/claude/g--Web/scratch/patch.py', '/other', 'C:/Users/me')).toBe('…/g--Web/scratch')
  expect(shortPath('/a/' + 'z'.repeat(60) + '/x.ts', '/other', '/h').length).toBe(28)
  expect(shortPath('/w/x.ts', '/w', '/h')).toBe('')
})

test('shortName: middle ellipsis keeps extension', async () => {
  expect(shortName('a.ts')).toBe('a.ts')
  const s = shortName('a'.repeat(50) + '.test.tsx')
  expect(s.length).toBeLessThanOrEqual(32)
  expect(s.endsWith('.tsx')).toBe(true)
})
