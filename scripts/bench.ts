import { runTask } from '../src/runner/main.ts'

/**
 * 跑一个任务：执行器 → run 目录 → 判分器 → score.json。
 *
 * 用法：node scripts/bench.ts <task_id> [--system name] [--seed 1] [--repeat 0] [--only-run]
 */
interface Args {
  taskId: string
  system: string
  seed: number
  repeat: number
  onlyRun: boolean
  pipelineFrom: string
}

function parseArgs(argv: string[]): Args {
  const taskId = argv.find((a) => !a.startsWith('--'))
  if (!taskId)
    throw new Error('用法: node scripts/bench.ts <task_id> [--system name] [--seed 1] [--repeat 0] [--only-run]')
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
  }
}

const args = parseArgs(process.argv.slice(2))
const result = await runTask(args.taskId, {
  system: args.system,
  seed: args.seed,
  repeat: args.repeat,
  ...(args.pipelineFrom ? { pipelineFrom: args.pipelineFrom } : {}),
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
if (!args.onlyRun) {
  const { score } = await import('../src/scorer/main.ts')
  const scored = await score(result.runDir)
  console.log('passed=' + scored.passed + ' score=' + scored.score)
}
process.exit(0)
