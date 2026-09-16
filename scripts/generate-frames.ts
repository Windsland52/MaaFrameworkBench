import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderFrames } from './lib/frames.ts'

/**
 * 把某个数据集声明的帧渲染到目标目录。产物必须是确定性的（逐字节可复现），
 * 否则 datasets.yaml 里记的 sha256 每次生成都会漂。
 *
 * 用法：node scripts/generate-frames.ts <out_dir>
 */
const outDir = process.argv[2]
if (!outDir) {
  console.error('用法: node scripts/generate-frames.ts <out_dir>')
  process.exit(1)
}
for (const frame of renderFrames()) {
  writeFileSync(join(outDir, frame.name), frame.png)
  console.log('  + ' + frame.name + ' (' + frame.png.length + ' B)')
}
