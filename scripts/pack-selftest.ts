import { cpSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { load } from 'js-yaml'
import { REPO_ROOT, OCR_MODEL_DIR } from '../src/runner/root.ts'

// 只复制显式清单，不递归打包仓库或用户配置；目标必须不存在。
const target = process.argv[2]
if (!target || process.argv.length !== 3) throw new Error('用法: node scripts/pack-selftest.ts <新目录>')
const dest = resolve(target)
if (existsSync(dest)) throw new Error('分发目录已存在，不覆盖: ' + dest)
if (!existsSync(dirname(dest)) || !statSync(dirname(dest)).isDirectory())
  throw new Error('分发目录的父目录不存在或不是目录: ' + dirname(dest))
const manifest = load(readFileSync(join(REPO_ROOT, 'datasets.yaml'), 'utf8')) as {
  datasets: Record<string, { target: string; files: Array<{ name: string; sha256: string }> }>
}
const ocr = Object.values(manifest.datasets).find((spec) => resolve(REPO_ROOT, spec.target) === OCR_MODEL_DIR)
if (!ocr?.files.length) throw new Error('datasets.yaml 中没有 OCR 文件清单')
// 校验与写入使用同一份字节，避免校验后源文件变化；额外文件不进入分发包。
const ocrFiles = ocr.files.map(({ name, sha256 }) => {
  const bytes = readFileSync(join(OCR_MODEL_DIR, name))
  if (createHash('sha256').update(bytes).digest('hex') !== sha256)
    throw new Error('OCR 文件哈希不符，拒绝打包: ' + name)
  return { name, bytes }
})
mkdirSync(dest, { recursive: false })
const files = ['selftest/entry.ts', 'env/frames/remote.ts', 'maa.ts']
for (const file of files) {
  mkdirSync(dirname(join(dest, file)), { recursive: true })
  cpSync(join(REPO_ROOT, 'src', file), join(dest, file))
}
mkdirSync(join(dest, 'ocr'))
for (const { name, bytes } of ocrFiles) writeFileSync(join(dest, 'ocr', name), bytes)
const entry = createRequire(import.meta.url).resolve('@maaxyz/maa-node')
const pkg = JSON.parse(readFileSync(resolve(dirname(entry), '..', 'package.json'), 'utf8')) as { version: string }
writeFileSync(
  join(dest, 'package.json'),
  JSON.stringify(
    {
      private: true,
      type: 'module',
      engines: { node: '>=24' },
      dependencies: { '@maaxyz/maa-node': pkg.version },
    },
    null,
    2,
  ) + '\n',
)
console.log('自测分发包: ' + dest)
console.log('仅含入口源码、OCR 与固定版本依赖声明；不含 node_modules、项目、设备令牌或模型 key。')
