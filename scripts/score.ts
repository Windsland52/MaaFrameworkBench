import { score } from '../src/scorer/main.ts'

/** 单独对一个已存在的 run 目录判分：node scripts/score.ts runs/<run_id> */
const runDir = process.argv[2]
if (!runDir) {
  console.error('用法: node scripts/score.ts <run_dir>')
  process.exit(1)
}
const result = await score(runDir)
console.log(JSON.stringify(result, null, 2))
process.exit(0)
