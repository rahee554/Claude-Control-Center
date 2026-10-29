const slash = (p: string) => p.split('\\').join('/')
const stripEnd = (p: string) => p.replace(/[/]+$/, '')
const under = (n: string, root: string) => !!root && n.toLowerCase().startsWith(root.toLowerCase() + '/')

// Directory part of `path`, shortened to at most `max` chars: relative to cwd, else ~ for home, then "…/last/two", then hard cap keeping the end.
export function shortPath(path: string, cwd: string, home: string, max = 28): string {
  let n = slash(path)
  const c = stripEnd(slash(cwd))
  const h = stripEnd(slash(home))
  let compressed = false
  if (under(n, c)) n = n.slice(c.length + 1)
  else if (under(n, h)) { n = '~/' + n.slice(h.length + 1); compressed = true } else compressed = true
  const i = n.lastIndexOf('/')
  let dir = i > 0 ? n.slice(0, i) : ''
  if (compressed && dir.length > max) {
    const segs = dir.split('/')
    if (segs.length > 2) dir = '…/' + segs.slice(-2).join('/')
  }
  return dir.length > max ? '…' + dir.slice(dir.length - (max - 1)) : dir
}

// Filename capped at `max` chars with a middle ellipsis, keeping the extension.
export function shortName(name: string, max = 32): string {
  if (name.length <= max) return name
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 && name.length - dot <= 8 ? name.slice(dot) : ''
  const head = max - ext.length - 1
  return name.slice(0, Math.max(1, head)) + '…' + ext
}
