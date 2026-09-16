import { runTask } from '../src/runner/main.ts'

/**
 * 跑一个任务：执行器 → run 目录 → 判分器 → score.json。
 *
 * 用法：node scripts/bench.ts <task_id> [--system name] [--seed 1] [--repeat 0] [--only-run]
 *       [--pipeline <pipeline.json>] [--usage <usage.json>]
 */
interface Args {
  taskId: string
  system: string
  seed: number
  repeat: number
  onlyRun: boolean
  pipelineFrom: string
  usageFrom: string
}

function parseArgs(argv: string[]): Args {
  const taskId = argv.find((a) => !a.startsWith('--'))
  if (!taskId)
    throw new Error(
      '用法: node scripts/bench.ts <task_id> [--system name] [--seed 1] [--repeat 0] [--only-run] [--pipeline <f>] [--usage <f>]',
    )
  const value = (flag: string, fallback: string): string => {
    const i = argv.indexOf(flag)
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1]! : fallback
  }
  return {
    taskId,
    system: value('--system', 'seed-pipeline'),
    seed: Number(value('--seed', '1')),
    repeat: Number(value('--repeat', '0')),
    onlyRun: argv.includes('--only-run'),
    pipelineFrom: value('--pipeline', ''),
    usageFrom: value('--usage', ''),
  }
}

const args = parseArgs(process.argv.slice(2))
const result = await runTask(args.taskId, {
  system: args.system,
  seed: args.seed,
  repeat: args.repeat,
  ...(args.pipelineFrom ? { pipelineFrom: args.pipelineFrom } : {}),
  ...(args.usageFrom ? { usageFrom: args.usageFrom } : {}),
})
console.log(
  'run ' +
    result.runId +
    ' status=' +
    result.status +
    ' submission=' +
    result.submissionSha256.slice(0, 12) +
    ' -> ' +
    result.runDir,
)
// 记账状态单独一行：批量脚本按退出码判断"账齐不齐"会全绿（run 本身是成功的），
// 所以这里给一个可 grep 的显式信号；run.json 里的 usage_error 才是权威来源。
if (result.usageError) console.log('usage=ERROR ' + result.usageError)
else if (args.usageFrom) console.log('usage=ok 已记入 run.json，原始文件归档为 ' + result.runDir + '\\usage.json')

if (!args.onlyRun) {
  const { score } = await import('../src/scorer/main.ts')
  const scored = await score(result.runDir)
  console.log('passed=' + scored.passed + ' score=' + scored.score)
}
process.exit(0)
