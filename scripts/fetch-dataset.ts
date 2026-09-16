import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

type FileSpec = { name: string; sha256?: string }
type DatasetSpec = {
  kind: 'dependency' | 'images' | 'recording' | 'env' | 'log'
  target: string
  license?: string
  note?: string
  base_url?: string
  files?: FileSpec[]
}
type Manifest = { defaults?: { data_root?: string }; datasets: Record<string, DatasetSpec> }

const sha256 = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex')

async function fetchOne(id: string, spec: DatasetSpec): Promise<boolean> {
  if (spec.kind !== 'dependency' || !spec.base_url || !spec.files) {
    console.error(`  [${id}] kind=${spec.kind} 尚未实现（当前只支持 dependency + base_url + files）`)
    return false
  }
  const dest = resolve(ROOT, spec.target)
  mkdirSync(dest, { recursive: true })
  let allOk = true

  for (const f of spec.files) {
    const out = join(dest, f.name)
    // 已存在且哈希对得上就跳过（幂等）
    if (existsSync(out) && f.sha256 && sha256(readFileSync(out)) === f.sha256) {
      console.log(`  = ${f.name} (已就绪)`)
      continue
    }
    const url = spec.base_url + '/' + f.name
    const res = await fetch(url)
    if (!res.ok) {
      console.error(`  ! ${f.name} 下载失败 HTTP ${res.status}`)
      allOk = false
      continue
    }
    const buf = Buffer.from(await res.arrayBuffer())
    if (f.sha256) {
      const got = sha256(buf)
      if (got !== f.sha256) {
        console.error(`  ! ${f.name} 哈希不符\n      期望 ${f.sha256}\n      实际 ${got}`)
        allOk = false
        continue
      }
    }
    writeFileSync(out, buf)
    console.log(`  + ${f.name} (${(buf.length / 1048576).toFixed(1)} MB)`)
  }
  return allOk
}

const args = process.argv.slice(2)
const manifest = load(readFileSync(resolve(ROOT, 'datasets.yaml'), 'utf8')) as Manifest
const ids = args.includes('--all') || args.length === 0 ? Object.keys(manifest.datasets) : args

let status = 0
for (const id of ids) {
  const spec = manifest.datasets[id]
  if (!spec) {
    console.error(`未知数据集: ${id}`)
    console.error(`可用: ${Object.keys(manifest.datasets).join(', ')}`)
    status = 2
    break
  }
  console.log(`[${id}] kind=${spec.kind} -> ${spec.target}`)
  if (!(await fetchOne(id, spec)) && status === 0) status = 1
}
// 不要用 process.exit()：Node 24 的 fetch（undici）在退出收尾时会和它抢跑，
// Windows 上会触发 libuv 断言。本脚本没有需要强杀的线程，设 exitCode 自然退出即可。
process.exitCode = status
