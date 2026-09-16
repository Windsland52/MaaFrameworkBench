import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hashTree } from './hash.ts'
import { preflightPipeline } from './preflight.ts'
import { OCR_MODEL_DIR, REPO_ROOT } from './root.ts'
import { loadTask, type TaskDef } from './task.ts'

const CHILD = resolve(dirname(fileURLToPath(import.meta.url)), 'child.ts')

export interface RunOptions {
  /** 被测系统标识，进 run_id */
  system: string
  seed: number
  repeat: number
  runsRoot?: string
  /**
   * 替 agent 交上来的 pipeline。正常流程里 pipeline 由被测系统写进工作区；
   * 闭环验证时用它在"提交快照"上钉一份已知正确的产出 —— 它同样会进 artifact，
   * 所以哈希覆盖的仍然是真正跑过的那份东西。
   */
  pipelineFrom?: string
  /** 覆盖 task.yaml 的墙钟预算，用来单独验证超时路径 */
  budgetWallMs?: number
}

export interface RunResult {
  runId: string
  runDir: string
  status: 'succeeded' | 'failed' | 'timeout' | 'error'
  submissionSha256: string
  /** 跑不完时说明卡在哪一步 */
  error?: string
}

interface ExecSummary {
  ok: boolean
  status: string
  raw_status: number
  final_screen: string
  ops: Array<Record<string, unknown>>
  screens: Array<{ screen: string; at: number }>
  error?: string
}

/**
 * 任务包里的路径：以 tasks/ 开头相对仓库根，其余相对数据集目录。
 * 数据集目录由 task.yaml 的 env 声明，这里不猜。
 */
function sourcePath(repoRoot: string, task: TaskDef, declared: string): string {
  if (declared.split('/').includes('..')) throw new Error('可见文件路径不能含 ..: ' + declared)
  if (declared.startsWith('tasks/')) return resolve(repoRoot, declared)
  const datasetDir = task.env.type === 'frames' ? task.env.dir : ''
  return resolve(repoRoot, 'data', datasetDir, declared)
}

/**
 * 物化工作区：只放白名单里的东西。
 * 断言、held-out 变体、环境自己的持出画面一律不进来 —— 能看到就能硬编码。
 */
function materialize(task: TaskDef, dest: string, repoRoot: string): void {
  const seed = resolve(repoRoot, 'tasks', task.id, 'seed')
  if (existsSync(seed)) cpSync(seed, dest, { recursive: true })
  const copied: string[] = []
  for (const visible of task.visible) {
    const src = sourcePath(repoRoot, task, visible)
    if (!existsSync(src)) throw new Error('visible 不在: ' + visible + ' -> ' + src)
    // 目录形式（tasks/.../visible/ 以 / 结尾）复制进去，文件形式直接落到目标名
    const out = visible.startsWith('tasks/')
      ? join(dest, visible.replace(/^tasks\/[^/]+\//, ''))
      : join(dest, 'frames', visible)
    const isDir = statSync(src).isDirectory() && (visible.endsWith('/') || !visible.includes('.'))
    if (isDir) {
      mkdirSync(out, { recursive: true })
      cpSync(src, out, { recursive: true })
    } else {
      mkdirSync(dirname(out), { recursive: true })
      cpSync(src, out)
    }
    copied.push(visible)
  }
  // 画面来自数据集、不属于种子项目，落一张来源说明免得被当成项目文件改
  if (copied.length > 0 && !copied.some((p) => p.startsWith('tasks/'))) {
    writeFileSync(
      join(dest, 'frames', 'SOURCE.json'),
      JSON.stringify({ dataset: task.env.type === 'frames' ? task.env.dataset : null, files: copied }, null, 2),
    )
  }
}

async function execInChild(
  cfgFile: string,
  wallMs: number,
): Promise<{ code: number | null; timedOut: boolean; stderr: string }> {
  return await new Promise((done) => {
    const child = spawn(process.execPath, [CHILD, cfgFile], { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    let timedOut = false
    let settled = false
    child.stderr.on('data', (chunk: Buffer) => {
      if (settled) return // 结算后再来的输出没有归属，丢掉比串到下一条记录里好
      stderr += chunk.toString()
    })
    const timer = setTimeout(() => {
      timedOut = true
      // 整个进程组：MaaFW 会起子线程，detach 的进程也不能留下
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      killer.on('error', () => {})
      child.kill('SIGKILL')
    }, wallMs)
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      done({ code: null, timedOut, stderr: stderr + String(err) })
    })
    child.on('exit', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      done({ code, timedOut, stderr })
    })
  })
}

export async function runTask(taskId: string, opts: RunOptions): Promise<RunResult> {
  const repoRoot = REPO_ROOT
  const runsRoot = opts.runsRoot ?? resolve(repoRoot, 'runs')
  const { task, taskFile } = loadTask(repoRoot, taskId)
  const runId = [taskId, opts.system, 's' + opts.seed, 'r' + opts.repeat].join('.')
  // 同一个 (task, system, seed, repeat) 只允许一条记录：允许覆盖的话，
  // "这批数字是哪次跑出来的"就再也说不清了。
  const runDir = resolve(runsRoot, runId)
  if (existsSync(runDir)) throw new Error('run 已存在，不覆盖: ' + runDir + '（换 --repeat 或删掉重跑）')
  mkdirSync(runDir, { recursive: true })

  const workspace = mkdtempSync(join(tmpdir(), 'maafwbench-ws-'))
  const logDir = join(runDir, 'logs')
  mkdirSync(logDir, { recursive: true })
  const artifact = join(runDir, 'artifact')

  const startedAt = new Date()
  const started = Date.now()
  let status: RunResult['status'] = 'error'
  let submissionSha256 = ''
  let failure: string | undefined
  try {
    materialize(task, workspace, repoRoot)
    if (opts.pipelineFrom) {
      const target = join(workspace, 'resource', 'base', 'pipeline', basename(opts.pipelineFrom))
      mkdirSync(dirname(target), { recursive: true })
      cpSync(resolve(opts.pipelineFrom), target)
    }

    const bundle = join(workspace, 'resource', 'base')
    const problems = preflightPipeline(bundle, task.entry)
    if (problems.length > 0) {
      failure = '提交不合规: ' + problems.join('；')
    } else {
      const screens =
        task.env.type === 'frames'
          ? task.env.screens.map((s) => ({ ...s, path: sourcePath(repoRoot, task, s.path) }))
          : []
      for (const s of screens) if (!existsSync(s.path)) throw new Error('环境画面不在: ' + s.path)

      const cfgFile = join(runDir, 'exec-config.json')
      writeFileSync(
        cfgFile,
        JSON.stringify(
          {
            workspace,
            bundle,
            ocrModelDir: OCR_MODEL_DIR,
            logDir,
            eventsFile: join(runDir, 'events.jsonl'),
            summaryFile: join(runDir, 'exec-summary.json'),
            entry: task.entry,
            screens,
          } satisfies Record<string, unknown>,
          null,
          2,
        ),
      )

      const exec = await execInChild(cfgFile, opts.budgetWallMs ?? task.budget.wall_ms ?? 120_000)
      rmSync(cfgFile, { force: true })

      const summary: ExecSummary | null = existsSync(join(runDir, 'exec-summary.json'))
        ? (JSON.parse(readFileSync(join(runDir, 'exec-summary.json'), 'utf8')) as ExecSummary)
        : null

      if (summary) {
        writeFileSync(
          join(runDir, 'ops.jsonl'),
          summary.ops.map((op) => JSON.stringify(op)).join('\n') + (summary.ops.length ? '\n' : ''),
        )
        status = summary.status === 'succeeded' ? 'succeeded' : summary.status === 'failed' ? 'failed' : 'error'
        failure = summary.error
      } else if (exec.timedOut) {
        status = 'timeout'
        failure = '墙钟超时，已硬杀进程组'
      } else if (exec.code !== 0) {
        failure = exec.stderr.trim() || '子进程退出码 ' + String(exec.code)
      }
    }
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err)
  }

  // 提交 = 结束那一刻工作区的快照，整棵拷、不过滤：漏掉任何一个目录，
  // 都等于给 agent 留了一块"改了也不算"的地方。先落快照、再算哈希，之后只认这个哈希。
  try {
    cpSync(workspace, artifact, { recursive: true })
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
  submissionSha256 = hashTree(artifact).sha256

  // 失败的跑也留记录：否则「没交东西」和「跑挂了」在目录里长得一样，都是空。
  const finishedAt = new Date()
  writeFileSync(
    join(runDir, 'run.json'),
    JSON.stringify(
      {
        schema_version: 1,
        run_id: runId,
        task_id: task.id,
        system: { harness: 'none@0', model: opts.system },
        seed: opts.seed,
        repeat_index: opts.repeat,
        started_at: startedAt.toISOString(),
        finished_at: finishedAt.toISOString(),
        status,
        submission: { path: 'artifact/', sha256: submissionSha256 },
        framework: { maa_node: maaNodeVersion() },
        task_file: taskFile,
        error: failure,
        wall_ms: finishedAt.getTime() - started,
      },
      null,
      2,
    ),
  )
  return { runId, runDir, status, submissionSha256, ...(failure === undefined ? {} : { error: failure }) }
}

/** MaaFW 版本进 run.json：同一批分数必须能看出框架版本，否则跨版本不可比。 */
function maaNodeVersion(): string {
  // 绑定不导出 package.json，只能按目录名解析（pnpm 下真实路径不在 node_modules/ 顶层）
  const entry = createRequire(import.meta.url).resolve('@maaxyz/maa-node')
  const pkg = JSON.parse(readFileSync(resolve(dirname(entry), '..', 'package.json'), 'utf8')) as { version: string }
  return pkg.version
}
