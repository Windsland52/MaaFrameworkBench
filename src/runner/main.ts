import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hashFile, hashTree } from './hash.ts'
import { envIdentity, scorerIdentity, taskIdentity } from './identity.ts'
import { parseLooseJson, preflightPipeline, scanForbiddenActions } from './preflight.ts'
import { parseUsage, type Usage } from './usage.ts'
import { OCR_MODEL_DIR, REPO_ROOT } from './root.ts'
import { deliveredPath, loadTask, type TaskDef } from './task.ts'

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
  /**
   * 被测系统自报的 token / 时间账。**记账坏了不影响 run** ——
   * 一次真实测量比一次记账贵得多，所以坏输入只记 usage_error，不终止。
   */
  usageFrom?: string
}

export interface RunResult {
  runId: string
  runDir: string
  status: 'succeeded' | 'failed' | 'timeout' | 'error'
  submissionSha256: string
  /** 记账被丢弃时的原因（run 仍然有效；这条是给批量脚本看的信号） */
  usageError?: string
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
    const out = join(dest, deliveredPath(task, visible))
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
  // 刻意**不**在工作区里留任何来源说明：SOURCE.json 这种东西只有评测才会有
  // （它还会顺手把数据集名和帧的文件名告诉 agent）。要交代的写进题面。
}

/**
 * 把任务规定的默认值写进资源包。**必须在 post_bundle 之前写** ——
 * 实测：Default 是在加载时合并进每个节点的，事后再 override_pipeline 完全没用
 * （走错按钮那例：不注入 22 次识别 / 22s，注入 5 次 / 4.5s）。
 *
 * 写在 agent 用的那个文件名上：框架 .jsonc 优先于 .json，写错文件我们的值会被它盖掉。
 * 只动 Default 的这一个键，agent 原有的默认值保留。返回注入的内容，好写进 run.json ——
 * 没有它，同一份 artifact 重跑不出同一次 run。
 */
function applyHarnessDefaults(bundle: string, task: TaskDef): Record<string, unknown> | undefined {
  const timeout = task.budget.node_timeout_ms
  if (timeout === undefined) return undefined

  const jsonc = join(bundle, 'default_pipeline.jsonc')
  const json = join(bundle, 'default_pipeline.json')
  const target = existsSync(jsonc) ? jsonc : json
  const isObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v)

  const base = existsSync(target) ? (parseLooseJson(readFileSync(target, 'utf8')) as unknown) : {}
  const root = isObject(base) ? base : {}
  const dflt = isObject(root.Default) ? root.Default : {}
  const merged = { ...root, Default: { ...dflt, timeout } }
  writeFileSync(target, JSON.stringify(merged, null, 2))
  return { Default: { timeout } }
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
  let harnessDefaults: Record<string, unknown> | undefined
  try {
    materialize(task, workspace, repoRoot)
    if (opts.pipelineFrom) {
      const target = join(workspace, 'resource', 'base', 'pipeline', basename(opts.pipelineFrom))
      mkdirSync(dirname(target), { recursive: true })
      cpSync(resolve(opts.pipelineFrom), target)
    }

    const bundle = join(workspace, 'resource', 'base')
    // 结构检查 + 动作白名单：两者都不过就不起进程。动作检查放在最前，
    // 因为它挡的是"在跑评测的机器上执行任意程序"，不该等到跑起来才发现。
    const problems = [...scanForbiddenActions(bundle, task.allow_actions), ...preflightPipeline(bundle, task.entry)]
    // **提交就在这里冻结**：再往后工作区既会被注入（harness 默认值）、又会被跑。
    // 先拍快照再注入，artifact 就只是"我们收到的那份东西"，而不是被动过手脚的版本。
    // 工作区本身要留到跑完（子进程从它加载资源包），所以在 finally 里才收。
    cpSync(workspace, artifact, { recursive: true })
    submissionSha256 = hashTree(artifact).sha256

    if (problems.length > 0) {
      failure = '提交不合规: ' + problems.join('；')
    } else {
      harnessDefaults = applyHarnessDefaults(bundle, task)
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

  // 账在跑完之后补：它是这次 run 的附带事实，坏掉不该影响已经测到的东西。
  let usage: Usage | undefined
  let usageError: string | undefined
  let usageFile: { path: string; sha256: string; bytes: number } | undefined
  if (opts.usageFrom) {
    const archive = join(runDir, 'usage.json')
    try {
      // 先原样归档再解析：这样"这份账属于哪次 run"能追（指纹进 run.json），
      // 厂商的原始报文也只落在归档文件里，不把 run.json 撑大。
      cpSync(resolve(opts.usageFrom), archive)
      usageFile = { path: 'usage.json', sha256: hashFile(archive), bytes: statSync(archive).size }
      usage = parseUsage(JSON.parse(readFileSync(archive, 'utf8')) as unknown)
    } catch (err) {
      usageError = (err instanceof Error ? err.message : String(err)) + '（文件: ' + opts.usageFrom + '）'
      process.stderr.write('[usage] 记账被丢弃：' + usageError + '\n')
    }
  }

  // 失败的跑也留记录：否则「没交东西」和「跑挂了」在目录里长得一样，都是空。
  const finishedAt = new Date()
  writeFileSync(
    join(runDir, 'run.json'),
    JSON.stringify(
      {
        schema_version: 1,
        run_id: runId,
        task_id: task.id,
        // 三份身份：改题、改判据、换数据集，都靠它们才判断得出"这批和那批能不能比"
        task: { id: task.id, sha256: taskIdentity(task.id) },
        env: { dataset: task.env.dataset, sha256: envIdentity(task.env.dataset) },
        system: { harness: 'none@0', model: opts.system },
        seed: opts.seed,
        repeat_index: opts.repeat,
        started_at: startedAt.toISOString(),
        finished_at: finishedAt.toISOString(),
        status,
        submission: { path: 'artifact/', sha256: submissionSha256 },
        framework: { maa_node: maaNodeVersion() },
        scorer: scorerIdentity(),
        task_file: taskFile,
        error: failure,
        // 我们测的：这次跑了多久（exec 的明细在 ops.jsonl，不在这里重复存）
        wall_ms: finishedAt.getTime() - started,
        // 被测系统自报的：拿不到就整个缺省，不做空壳
        ...(usage === undefined ? {} : { usage }),
        // 我们注入进包里的默认值：没有它，同一份 artifact 重跑不出同一次 run
        ...(harnessDefaults === undefined ? {} : { harness_defaults: harnessDefaults }),
        ...(usageFile === undefined ? {} : { usage_file: usageFile }),
        ...(usageError === undefined ? {} : { usage_error: usageError }),
      },
      null,
      2,
    ),
  )
  return {
    runId,
    runDir,
    status,
    submissionSha256,
    ...(failure === undefined ? {} : { error: failure }),
    ...(usageError === undefined ? {} : { usageError }),
  }
}

/** MaaFW 版本进 run.json：同一批分数必须能看出框架版本，否则跨版本不可比。 */
function maaNodeVersion(): string {
  // 绑定不导出 package.json，只能按目录名解析（pnpm 下真实路径不在 node_modules/ 顶层）
  const entry = createRequire(import.meta.url).resolve('@maaxyz/maa-node')
  const pkg = JSON.parse(readFileSync(resolve(dirname(entry), '..', 'package.json'), 'utf8')) as { version: string }
  return pkg.version
}
