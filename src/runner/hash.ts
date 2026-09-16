import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, posix, sep } from 'node:path'

const sha256 = (buf: Buffer | string): string => createHash('sha256').update(buf).digest('hex')

export interface TreeEntry {
  /** 相对 root 的 POSIX 路径 */
  path: string
  sha256: string
  bytes: number
}

/**
 * 目录树的**确定性**清单：先排序再哈希，所以同一棵树在任何机器上都得到同一个值。
 * 提交哈希靠它 —— 顺序不定的话，"只判首次提交"就无从谈起。
 */
export function hashTree(
  dir: string,
  skip: (rel: string) => boolean = () => false,
): { sha256: string; files: TreeEntry[] } {
  const files: TreeEntry[] = []
  const walk = (rel: string): void => {
    const abs = rel === '' ? dir : join(dir, rel)
    for (const entry of readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const childRel = rel === '' ? entry.name : posix.join(rel.split(sep).join(posix.sep), entry.name)
      if (skip(childRel)) continue
      if (entry.isDirectory()) {
        walk(childRel)
        continue
      }
      if (!entry.isFile()) continue
      const buf = readFileSync(join(dir, childRel))
      files.push({ path: childRel, sha256: sha256(buf), bytes: buf.length })
    }
  }
  walk('')
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const manifest = files.map((f) => f.path + '\t' + f.sha256).join('\n')
  return { sha256: sha256(manifest), files }
}

export function hashFile(path: string): string {
  return sha256(statSync(path).isFile() ? readFileSync(path) : readFileSync(path))
}
