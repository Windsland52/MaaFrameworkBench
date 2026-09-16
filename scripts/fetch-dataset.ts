import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
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
  generate?: string
  files?: FileSpec[]
  env?: Record<string, string>
}
type Manifest = { defaults?: { data_root?: string }; datasets: Record<string, DatasetSpec> }

const sha256 = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex')

function verify(id: string, dest: string, files: FileSpec[]): boolean {
  let ok = true
  for (const f of files) {
    const out = join(dest, f.name)
    if (!existsSync(out)) {
      console.error('  ! ' + f.name + ' 缺失')
      ok = false
      continue
    }
    const got = sha256(readFileSync(out))
    if (f.sha256 && got !== f.sha256) {
      console.error('  ! ' + f.name + ' 哈希不符\n      期望 ' + f.sha256 + '\n      实际 ' + got)
      ok = false
    }
  }
  for (const entry of readdirSync(dest)) {
    if (entry.startsWith('.') || entry.endsWith('.sha256')) continue
    if (!files.some((f) => f.name === entry)) {
      console.error('  ! ' + entry + ' 不在清单里（数据集目录只放清单里的文件）')
      ok = false
    }
  }
  if (ok) console.log('  = ' + id + ' 的 ' + files.length + ' 个文件全部就绪')
  return ok
}

/** 已是权威的：kind=dependency 从 base_url 下载，按哈希幂等跳过。 */
async function fetchRemote(dest: string, spec: DatasetSpec): Promise<boolean> {
  let ok = true
  for (const f of spec.files ?? []) {
    const out = join(dest, f.name)
    if (existsSync(out) && f.sha256 && sha256(readFileSync(out)) === f.sha256) {
      console.log('  = ' + f.name + ' (已就绪)')
      continue
    }
    const res = await fetch(spec.base_url + '/' + f.name)
    if (!res.ok) {
      console.error('  ! ' + f.name + ' 下载失败 HTTP ' + res.status)
      ok = false
      continue
    }
    const buf = Buffer.from(await res.arrayBuffer())
    if (f.sha256 && sha256(buf) !== f.sha256) {
      console.error('  ! ' + f.name + ' 哈希不符，拒绝覆盖')
      ok = false
      continue
    }
    writeFileSync(out, buf)
    console.log('  + ' + f.name + ' (' + (buf.length / 1048576).toFixed(1) + ' MB)')
  }
  return ok
}

/** 由脚本确定性生成的：画完之后仍然按清单校验，生成器漂了会被抓住。 */
function generate(dest: string, spec: DatasetSpec): boolean {
  const entry = resolve(ROOT, spec.generate ?? '')
  if (!spec.generate || !existsSync(entry)) {
    console.error('  ! 生成脚本不在: ' + String(spec.generate))
    return false
  }
  const res = spawnSync(process.execPath, [entry, dest], { stdio: 'inherit', env: { ...process.env } })
  return res.status === 0
}

async function fetchOne(id: string, spec: DatasetSpec): Promise<boolean> {
  const dest = resolve(ROOT, spec.target)
  mkdirSync(dest, { recursive: true })
  const files = spec.files ?? []

  switch (spec.kind) {
    case 'dependency':
      if (!spec.base_url) {
        console.error('  ! dependency 必须有 base_url')
        return false
      }
      return (await fetchRemote(dest, spec)) && verify(id, dest, files)
    case 'images':
      return generate(dest, spec) && verify(id, dest, files)
    default:
      console.error('  ! kind=' + spec.kind + ' 尚未实现')
      return false
  }
}

const args = process.argv.slice(2)
const manifest = load(readFileSync(resolve(ROOT, 'datasets.yaml'), 'utf8')) as Manifest
const ids = args.length > 0 ? args : Object.keys(manifest.datasets)

let status = 0
for (const id of ids) {
  const spec = manifest.datasets[id]
  if (!spec) {
    console.error('未知数据集: ' + id)
    console.error('可用: ' + Object.keys(manifest.datasets).join(', '))
    status = 2
    break
  }
  console.log('[' + id + '] kind=' + spec.kind + ' -> ' + spec.target)
  if (!(await fetchOne(id, spec)) && status === 0) status = 1
}
// 不要用 process.exit()：Node 24 的 fetch（undici）在退出收尾时会和它抢跑，
// Windows 上会触发 libuv 断言。本脚本没有需要强杀的线程，设 exitCode 自然退出即可。
process.exitCode = status
