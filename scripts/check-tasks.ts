import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { REPO_ROOT } from '../src/runner/root.ts'
import { deliveredPath, loadTask } from '../src/runner/task.ts'

/**
 * 工作区不带评测痕迹。
 *
 * 契约 §7 早就写着「反识别出评测（任务 ID 不出现在 agent 可见处）」和
 * 「夹具随机化（节点名 / 文件名 / 入口名 / 帧的出现形态）」——
 * 但在这次之前**没有东西在守它**：工作区里躺着 `maafw-bench-t001`、
 * `EnterInventory`、`home.png` 三样。
 *
 * 守的是两类**静默**泄漏（都不会报错，只会悄悄给难度打折）：
 *   1. 元数据替 agent 做判断 —— 文件名直接说"这是主页 / 这是库存页"
 *   2. 让它识别出"我在被评测" —— 项目名里带 bench，或任务 id 直接出现
 *
 * **像素不算泄漏**：画面上写着 HOME / INVENTORY 是应用自己的界面文字，
 * 开发者本来就该看到屏幕。泄漏的是文件名、目录名、项目名这些真实项目里
 * 不会有（或不会有语义）的东西。
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
  const { task } = loadTask(REPO_ROOT, taskId)
  const seedDir = join(tasksDir, taskId, 'seed')
  const problems: string[] = []

  // 1. seed/（agent 会看到的那部分）里不许出现任务 id 或"评测"字样的词
  for (const file of textFiles(seedDir)) {
    const text = readFileSync(file, 'utf8')
    const lower = text.toLowerCase()
    const hit = [taskId, ...TELL_WORDS].find((w) => lower.includes(w.toLowerCase()))
    if (hit !== undefined) problems.push(relative(REPO_ROOT, file) + ' 里出现「' + hit + '」')
  }

  // 2. 交付进工作区的名字不许撞上任何一屏的名字 —— 文件名替 agent 做映射。
  //    现在的交付名是 deliveredPath 推出来的 token，本来不可能带语义；
  //    这条守着的是**那个推导别哪天被改回去**（改回"直接拿数据集名字交付"就当场红）。
  const screenNames = task.env.type === 'frames' ? task.env.screens.map((s) => s.name) : []
  for (const v of task.visible) {
    const delivered = deliveredPath(v)
    const hit = screenNames.find((n) => delivered.toLowerCase().includes(n.toLowerCase()))
    if (hit !== undefined) problems.push('交付进工作区的「' + delivered + '」里含屏名「' + hit + '」')
  }

  report(
    problems.length === 0,
    taskId + ' 的工作区不带评测痕迹',
    problems.length === 0 ? 'seed/ 与 visible 都干净' : problems.join('；'),
  )
}

console.log(
  failures === 0 ? '任务包痕迹检查通过（' + taskIds.length + ' 个任务）' : '任务包痕迹检查失败 ' + failures + ' 例',
)
process.exitCode = failures === 0 ? 0 : 1
