import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { REPO_ROOT } from '../src/runner/root.ts'
import { loadTask } from '../src/runner/task.ts'

/**
 * 工作区不带评测痕迹。
 *
 * 工作区不带评测痕迹。
 *
 * 契约 §7 写着「反识别出评测（任务 ID 不出现在 agent 可见处）」——
 * 但在补这条检查之前**没有东西在守它**：工作区里躺着 `maafw-bench-t001`、
 * `EnterInventory` 这些只有评测才会有的名字。
 *
 * 守的是**静默**泄漏：不会报错，只会让 agent 认出"我在被评测"，悄悄给难度打折。
 * 帧那类泄漏已经随"画面不进工作区"一起没了 —— 工作区里只有种子项目，没有截图，
 * 也就没有"文件名替 agent 做映射"这件事。
 */

const TELL_WORDS = ['bench', 'benchmark', 'evaluate', '评测']

function textFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (abs: string): void => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const full = join(abs, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!entry.isFile()) continue
      const head = readFileSync(full).subarray(0, 8192)
      if (head.includes(0)) continue // 二进制，跳过
      out.push(full)
    }
  }
  if (statSync(dir).isDirectory()) walk(dir)
  return out
}

let failures = 0
const report = (ok: boolean, name: string, detail: string): void => {
  if (!ok) failures += 1
  console.log((ok ? 'OK  ' : 'FAIL') + ' | ' + name + '\n       ' + detail)
}

const tasksDir = join(REPO_ROOT, 'tasks')
const taskIds = readdirSync(tasksDir)
  .filter((d) => statSync(join(tasksDir, d)).isDirectory())
  .sort()

for (const taskId of taskIds) {
  // 顺带确认任务包读得出来：读不出来这里就抛，不必等跑起来才发现
  loadTask(REPO_ROOT, taskId)
  const seedDir = join(tasksDir, taskId, 'seed')
  const problems: string[] = []

  // seed/（agent 会看到的那部分）里不许出现任务 id 或"评测"字样的词
  for (const file of textFiles(seedDir)) {
    const text = readFileSync(file, 'utf8')
    const lower = text.toLowerCase()
    const hit = [taskId, ...TELL_WORDS].find((w) => lower.includes(w.toLowerCase()))
    if (hit !== undefined) problems.push(relative(REPO_ROOT, file) + ' 里出现「' + hit + '」')
  }

  report(
    problems.length === 0,
    taskId + ' 的工作区不带评测痕迹',
    problems.length === 0 ? 'seed/ 干净' : problems.join('；'),
  )
}

console.log(
  failures === 0 ? '任务包痕迹检查通过（' + taskIds.length + ' 个任务）' : '任务包痕迹检查失败 ' + failures + ' 例',
)
process.exitCode = failures === 0 ? 0 : 1
