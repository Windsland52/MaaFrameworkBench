import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { bootFramesEnv } from '../src/env/frames/boot.ts'
import { materialize, sourcePath } from '../src/runner/main.ts'
import { preflightPipeline } from '../src/runner/preflight.ts'
import { OCR_MODEL_DIR, REPO_ROOT } from '../src/runner/root.ts'
import { loadTask } from '../src/runner/task.ts'

/**
 * 自测入口：把设备起起来，**post 一次 task**，把过程打出来。
 *
 * 它就是"开发时手上那台设备"：写到工作区里的 pipeline 能不能跑、跑到哪一步、设备
 * 交出来的是哪几张图，都在这里看。跟评测那一跑共用同一段环境代码（`bootFramesEnv`
 * + `post_task(entry)`）—— 自测和评测走的不是同一条路，自测就是在骗自己。
 *
 * 两条纪律写在实现里：
 *   - **每次调用 = 一台新设备**：新进程、新 boot、初始屏。这就是"重置"，不需要额外接口。
 *   - **屏名不出去**：环境内部那个名字（`home` / `inventory-zero`）是 `env_state` 的
 *     判据词汇，给出去等于把答案和 held-out 变体一起交出去。对外只报 `s1` / `s2`。
 */

interface Args {
  workspace: string
  taskId: string
  peek: boolean
  /** 图与日志落在哪；缺省 <工作区>/.self-test */
  out: string
  rounds: number
  /** 我们调试用：连屏名一起打（给 agent 看时不要开） */
  names: boolean
  /** 摊一个工作区出来，不跑 */
  init: string
  pipelineFrom: string
  force: boolean
}

const USAGE = [
  '用法:',
  '  node scripts/self-test.ts <工作区> [--task <id>]         起设备 → post 一次 task → 打印轨迹',
  '  node scripts/self-test.ts <工作区> --peek                只看一眼当前屏（不跑 pipeline）',
  '  node scripts/self-test.ts --new <目录> [--pipeline <f>]  摊一个工作区出来（种子项目）',
  '',
  '选项:',
  '  --task <id>     用哪个任务的设备（task.yaml 的 env.screens）；只有一个任务时可省略',
  '  --out <dir>     图与 MaaFW 日志落在哪（默认 <工作区>/.self-test）',
  '  --rounds <n>    重复跑 n 轮，每轮一台新设备（默认 1）',
  '  --names         连环境内部的屏名一起打（调试用）',
].join('\n')

function parseArgs(argv: string[]): Args {
  const value = (flag: string, fallback: string): string => {
    const i = argv.indexOf(flag)
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1]! : fallback
  }
  const positional = argv.find((a, i) => !a.startsWith('--') && (i === 0 || !argv[i - 1]!.startsWith('--')))
  return {
    workspace: resolve(positional ?? '.'),
    taskId: value('--task', ''),
    peek: argv.includes('--peek'),
    out: value('--out', ''),
    rounds: Math.max(1, Number(value('--rounds', '1')) || 1),
    names: argv.includes('--names'),
    init: value('--new', ''),
    pipelineFrom: value('--pipeline', ''),
    force: argv.includes('--force'),
  }
}

const args = parseArgs(process.argv.slice(2))

/** 任务包的 id：没给就取唯一那个（只有一个任务时省事）。 */
function pickTask(given: string): string {
  if (given !== '') return given
  const ids = readdirSync(join(REPO_ROOT, 'tasks')).sort()
  if (ids.length !== 1) throw new Error('有 ' + ids.length + ' 个任务，请用 --task 指定：' + ids.join(', '))
  return ids[0]!
}

const taskId = pickTask(args.taskId)
const { task } = loadTask(REPO_ROOT, taskId)

/* ---------- --new：摊一个工作区出来 ---------- */
if (args.init !== '') {
  const dest = resolve(args.init)
  if (existsSync(dest) && readdirSync(dest).length > 0 && !args.force) {
    throw new Error(dest + ' 非空；要覆盖就加 --force（或者换个目录）')
  }
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dest, { recursive: true })
  materialize(task, dest, REPO_ROOT)
  if (args.pipelineFrom !== '') {
    const target = join(dest, 'resource', 'base', 'pipeline', basename(args.pipelineFrom))
    mkdirSync(join(dest, 'resource', 'base', 'pipeline'), { recursive: true })
    cpSync(resolve(args.pipelineFrom), target)
    console.log('放进 pipeline: resource/base/pipeline/' + basename(args.pipelineFrom))
  }
  console.log('工作区摊好了: ' + dest)
  console.log('跑它: node scripts/self-test.ts ' + args.init)
  process.exit(0)
}

/* ---------- 设备与落盘 ---------- */
const workspace = args.workspace
if (!existsSync(workspace)) throw new Error('工作区不在: ' + workspace)
const bundle = join(workspace, 'resource', 'base')
const outDir = args.out !== '' ? resolve(args.out) : join(workspace, '.self-test')
const shotsDir = join(outDir, 'shots')

const screens = task.env.screens.map((s) => ({ ...s, path: sourcePath(REPO_ROOT, task, s.path) }))
for (const s of screens) if (!existsSync(s.path)) throw new Error('设备画面不在: ' + s.path)

/** 屏名 -> s1 / s2…（同一次自测里稳定；名字本身不出这套映射） */
const handles = new Map<string, string>()
const label = (name: string): string => {
  if (args.names) return name
  if (!handles.has(name)) handles.set(name, 's' + (handles.size + 1))
  return handles.get(name)!
}

interface Row {
  at: number
  who: string
  what: string
}

async function boot(round: number): Promise<Awaited<ReturnType<typeof bootFramesEnv>>> {
  const t0 = Date.now()
  const env = await bootFramesEnv({
    bundle,
    screens,
    ocrModelDir: OCR_MODEL_DIR,
    logDir: outDir,
    shotsDir,
  })
  console.log('第 ' + round + ' 轮  起设备 ' + (Date.now() - t0) + 'ms' + (env.ok ? '' : '  ⚠ 环境没起全'))
  return env
}

function printTrace(rows: Row[], t0: number): void {
  rows.sort((a, b) => a.at - b.at)
  for (const r of rows) {
    console.log('+' + String(r.at - t0).padStart(6) + 'ms  ' + r.who + '  ' + r.what)
  }
}

/* ---------- --peek：只看一眼当前屏 ---------- */
if (args.peek) {
  const env = await boot(1)
  await env.ctrl.post_screencap().wait().get()
  const last = [...env.actor.ops()].reverse().find((op) => op.shot !== undefined)
  console.log('当前屏 ' + label(env.actor.screen()) + (last?.shot ? '  →  ' + join(shotsDir, last.shot) : ''))
  env.teardown()
  process.exit(0)
}

/* ---------- 跑：前置结构检查 + post 一次 task ---------- */
const problems = preflightPipeline(bundle, task.entry)
if (problems.length > 0) {
  console.error('跑不起来，先修这些：')
  for (const p of problems) console.error('  - ' + p)
  process.exit(1)
}

let failed = 0
for (let round = 1; round <= args.rounds; round += 1) {
  const t0 = Date.now()
  const env = await boot(round)
  const rows: Row[] = []

  // 任务级事件（Task.*）走 tasker sink；节点 / 识别 / 动作走 context sink —— 实测就是这么分的
  env.tasker.add_sink((_t, msg) => {
    const m = msg as Record<string, unknown>
    if (m.msg === 'Task.Starting')
      rows.push({ at: Date.now(), who: '框架', what: 'post 一次 task（入口 ' + String(m.entry) + '）' })
    else if (m.msg === 'Task.Succeeded' || m.msg === 'Task.Failed')
      rows.push({ at: Date.now(), who: '框架', what: 'task ' + (m.msg === 'Task.Succeeded' ? '成功' : '失败') })
  })
  env.tasker.add_context_sink((_c, msg) => {
    const m = msg as Record<string, unknown>
    const at = Date.now()
    const who = '「' + String(m.name) + '」'
    if (m.msg === 'Recognition.Succeeded') {
      const detail = env.tasker.recognition_detail(String(m.reco_id) as maa.RecoId)?.detail
      const best =
        detail && typeof detail === 'object' && 'best' in detail
          ? (detail as { best: { text?: string } | null }).best
          : null
      rows.push({ at, who: '框架', what: who + '识别成功 → ' + JSON.stringify(best?.text ?? null) })
    } else if (m.msg === 'Recognition.Failed') {
      rows.push({ at, who: '框架', what: who + '识别失败' })
    } else if (m.msg === 'Action.Succeeded') {
      const a = m.action_details as { action?: string } | undefined
      rows.push({ at, who: '框架', what: who + '动作 ' + String(a?.action) })
    } else if (m.msg === 'PipelineNode.Failed') {
      rows.push({ at, who: '框架', what: who + '节点失败（识别没命中且没有 next）' })
    }
  })

  const job = env.tasker.post_task(task.entry)
  const status = Number(await job.wait().status)
  const ok = status === 3000
  if (!ok) failed += 1

  for (const op of env.actor.ops()) {
    const arg = op.arg === undefined || op.arg === null ? '' : ' ' + JSON.stringify(op.arg)
    rows.push({
      at: op.at,
      who: '设备',
      what:
        op.op +
        arg +
        '  → 画面 ' +
        label(op.screen) +
        (op.moved ? '（被带走）' : '') +
        (op.shot ? '  交出 ' + op.shot : ''),
    })
  }
  printTrace(rows, t0)
  const ops = env.actor.ops()
  const count = (op: string): number => ops.filter((o) => o.op === op).length
  console.log(
    '第 ' +
      round +
      ' 轮结束: ' +
      (ok ? 'task 成功' : 'task 失败 status=' + status) +
      '（' +
      (Date.now() - t0) +
      'ms）  最终屏 ' +
      label(env.actor.screen()) +
      '  识别 ' +
      count('screencap') +
      ' 次 / 点击 ' +
      count('click') +
      ' 次  交出的图 → ' +
      shotsDir,
  )
  console.log('')
  env.teardown()
}

process.exit(failed === 0 ? 0 : 1)
