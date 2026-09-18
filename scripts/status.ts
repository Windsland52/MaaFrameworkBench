import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { load } from 'js-yaml'
import { REPO_ROOT } from '../src/runner/root.ts'
import { loadTask } from '../src/runner/task.ts'

/**
 * 现状一条命令说清：有什么任务、什么环境、数据齐不齐、跑过几次、过了几次。
 *
 * 为什么不写成文档：**状态会过期，读仓库不会**。这里所有数字都是当场从
 * tasks/ / data/ / vendor/ / systems/ / runs/ 读出来的，所以它不会像"已实现/未实现"
 * 那种表格一样慢慢失真。
 */

const out: string[] = []
/** 中文是按两列显示的，padEnd 按字符数补空格会对不齐 —— 自己算显示宽度。 */
const displayWidth = (s: string): number => [...s].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0)
const line = (label: string, text: string): void => {
  out.push(label + ' '.repeat(Math.max(1, 12 - displayWidth(label))) + text)
}
const sub = (text: string): void => {
  out.push('            ' + text)
}
const gap = (): void => {
  out.push('')
}

/* ---- 任务包 ---- */
const tasksDir = resolve(REPO_ROOT, 'tasks')
const taskIds = existsSync(tasksDir)
  ? readdirSync(tasksDir)
      .filter((d) => statSync(join(tasksDir, d)).isDirectory())
      .sort()
  : []
line('任务包', taskIds.length + ' 个')
for (const id of taskIds) {
  try {
    const { task } = loadTask(REPO_ROOT, id)
    const env = task.env.type === 'frames' ? 'frames（' + task.env.screens.length + ' 屏）' : task.env.type
    sub(
      id + '  环境=' + env + '  断言=' + task.assert.length + ' 条  预算=' + String(task.budget.wall_ms ?? '-') + 'ms',
    )
  } catch (err) {
    sub(id + '  ⚠ 读不出来：' + (err instanceof Error ? err.message : String(err)))
  }
}
gap()

/* ---- 环境 ---- */
const envDir = resolve(REPO_ROOT, 'src', 'env')
const envs = existsSync(envDir)
  ? readdirSync(envDir)
      .filter((d) => statSync(join(envDir, d)).isDirectory())
      .sort()
  : []
line('环境', envs.length + ' 种：' + envs.join(' / '))
sub('契约里规划三种（frames / web / replay）；目录没有的就是还没建')

/* ---- 数据 ---- */
const manifest = load(readFileSync(resolve(REPO_ROOT, 'datasets.yaml'), 'utf8')) as {
  datasets: Record<string, { kind: string; target: string; files?: Array<{ name: string }> }>
}
line('数据', Object.keys(manifest.datasets).length + ' 个数据集')
for (const [id, spec] of Object.entries(manifest.datasets)) {
  const dir = resolve(REPO_ROOT, spec.target)
  const files = spec.files ?? []
  const missing = files.filter((f) => !existsSync(join(dir, f.name)))
  const state =
    missing.length === 0 ? '✓ ' + files.length + ' 个文件在位' : '✗ 缺 ' + missing.length + ' 个（跑 pnpm datasets）'
  sub(id.padEnd(20, ' ') + spec.kind.padEnd(11, ' ') + '-> ' + spec.target.padEnd(24, ' ') + state)
}
sub('在位不等于哈希对；哈希由 pnpm datasets 校验')
gap()

/* ---- 参照系统 ---- */
const systemsDir = resolve(REPO_ROOT, 'systems')
const systems = existsSync(systemsDir) ? readdirSync(systemsDir).sort() : []
line('被测系统', systems.length === 0 ? '还没有' : systems.length + ' 个：' + systems.join(' / '))
sub('systems/<name>/ 放真实被测系统交出来的东西；各任务的夹具在 tasks/<id>/fixtures/')

/* ---- run ---- */
const runsDir = resolve(REPO_ROOT, 'runs')
const runIds = existsSync(runsDir)
  ? readdirSync(runsDir)
      .filter((d) => existsSync(join(runsDir, d, 'run.json')))
      .sort()
  : []
interface RunInfo {
  id: string
  status: string
  passed: boolean | null
  finished: string
}
const runs: RunInfo[] = runIds.map((id) => {
  const meta = JSON.parse(readFileSync(join(runsDir, id, 'run.json'), 'utf8')) as {
    status?: string
    finished_at?: string
  }
  const scoreFile = join(runsDir, id, 'score.json')
  const passed = existsSync(scoreFile)
    ? (JSON.parse(readFileSync(scoreFile, 'utf8')) as { passed?: boolean }).passed === true
    : null
  return { id, status: meta.status ?? '?', passed, finished: meta.finished_at ?? '' }
})
line('run', runs.length + ' 条')
if (runs.length > 0) {
  const byStatus = new Map<string, number>()
  for (const r of runs) byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1)
  sub('跑完情况：' + [...byStatus.entries()].map(([s, n]) => s + ' ' + n).join(' / '))
  const judged = runs.filter((r) => r.passed !== null)
  if (judged.length > 0)
    sub(
      '已判分 ' +
        judged.length +
        ' 条：过 ' +
        judged.filter((r) => r.passed).length +
        ' / 不过 ' +
        judged.filter((r) => !r.passed).length,
    )
  const latest = runs[runs.length - 1]!
  sub('最新：' + latest.id + '  status=' + latest.status + '  passed=' + String(latest.passed))
} else {
  sub(
    '还没跑过。试：pnpm bench t001-enter-inventory --system ref --seed 1 --repeat 0 --pipeline tasks/t001-enter-inventory/fixtures/correct.json',
  )
}

console.log(out.join('\n'))
