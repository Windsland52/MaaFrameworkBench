import { createWriteStream, readFileSync, writeFileSync } from 'node:fs'
import { bootFramesEnv, bootRemoteFramesEnv } from '../env/frames/boot.ts'

/**
 * 一个 run 的执行进程。runner 用子进程而不是直接跑，是因为 MaaFW 会 abort()、
 * agent 的 custom 代码会崩、超时要能硬杀整个进程组 —— 这些都会带走评测进程。
 */
export interface ExecConfig {
  workspace: string
  bundle: string
  ocrModelDir: string
  logDir: string
  eventsFile: string
  summaryFile: string
  entry: string
  /** 本地分支：帧数据随配置进子进程（闭环替身 / 自测沿用这个形态） */
  screens?: Array<{
    name: string
    path: string
    transitions?: Array<{ area: [number, number, number, number]; target: string }>
  }>
  /** 交出去的每张图落在哪（run 目录下的 screens/）。远程分支由宿主侧的服务留档，这里没有 */
  shotsDir?: string
  /** 远程分支：只有设备地址与令牌 —— 帧数据、命中区不进这个进程 */
  device?: { url: string; token: string }
}

/** 与 MaaFW 的 Status 常量同名，读日志的人不必再去查数字。 */
function statusName(status: number): 'succeeded' | 'failed' | 'error' {
  if (status === 3000) return 'succeeded'
  if (status === 4000) return 'failed'
  return 'error'
}

const cfg = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as ExecConfig
const events = createWriteStream(cfg.eventsFile, { flags: 'w' })

/** 框架侧回执：两种分支都交这份 */
interface FrameworkReceipt {
  ok: boolean
  status: string
  raw_status: number
  error?: string
}

/** 本地分支多交环境证据；远程分支的证据在宿主侧的服务里，不由这个进程经手 */
interface LocalSummary extends FrameworkReceipt {
  final_screen: string
  ops: unknown[]
  screens: Array<{ screen: string; at: number }>
}

async function emit(msg: unknown): Promise<void> {
  const line = JSON.stringify({ at: Date.now(), ...(msg as Record<string, unknown>) })
  if (!events.write(line + '\n')) {
    await new Promise((done) => events.once('drain', done))
  }
}

async function main(): Promise<void> {
  if (cfg.device && (cfg.screens !== undefined || cfg.shotsDir !== undefined))
    throw new Error('device 与 screens/shotsDir 互斥：远程分支不携带帧配置')
  if (!cfg.device && cfg.screens === undefined) throw new Error('本地分支需要 screens（帧配置）')

  // 本地句柄单独持有：FramesEnv 结构上是 RemoteFramesEnv 的超集，联合类型会被折叠，
  // 收窄不能靠 'actor' in env
  const local = cfg.device
    ? undefined
    : await bootFramesEnv({
        bundle: cfg.bundle,
        screens: cfg.screens!,
        ocrModelDir: cfg.ocrModelDir,
        logDir: cfg.logDir,
        shotsDir: cfg.shotsDir,
      })
  const env =
    local ??
    (await bootRemoteFramesEnv({
      bundle: cfg.bundle,
      ocrModelDir: cfg.ocrModelDir,
      logDir: cfg.logDir,
      device: cfg.device!,
    }))
  env.tasker.add_sink((_t, msg) => emit(msg))

  // 识别结果不落进事件的话，判分器只能证明"某个节点跑过了"，
  // 证明不了"它读到的是哪个数" —— 那正是这类任务唯一要判的东西。
  env.tasker.add_context_sink((_c, msg) => {
    if (msg.msg === 'Recognition.Succeeded') {
      // maa-node 把 Id 系类型标成 branded string，运行时其实是 number —— 这里只借它的类型
      const detail = env.tasker.recognition_detail(String(msg.reco_id) as maa.RecoId)?.detail
      const best =
        detail && typeof detail === 'object' && 'best' in detail
          ? (detail as { best: { text?: string } | null }).best
          : null
      return emit({ ...msg, text: best?.text ?? null })
    }
    return emit(msg)
  })

  if (!env.ok) {
    throw new Error('环境加载失败（资源包 / OCR 模型 / 控制器连接）')
  }

  let raw = 0
  let failure: string | undefined
  try {
    const job = env.tasker.post_task(cfg.entry)
    const status = await Promise.race([
      job.wait().status,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('run 内部超时')), 300_000)),
    ])
    raw = Number(status)
  } catch (err) {
    raw = 0
    failure = err instanceof Error ? err.message : String(err)
  }

  const receipt: FrameworkReceipt = {
    ok: failure === undefined && raw === 3000,
    status: failure === undefined ? statusName(raw) : 'error',
    raw_status: raw,
    ...(failure === undefined ? {} : { error: failure }),
  }
  const summary: FrameworkReceipt | LocalSummary = local
    ? { ...receipt, final_screen: local.actor.screen(), ops: local.actor.ops(), screens: local.actor.state() }
    : receipt
  writeFileSync(cfg.summaryFile, JSON.stringify(summary, null, 2))
  env.teardown()
  await new Promise<void>((done) => events.end(done))

  if (failure !== undefined) throw new Error(failure)
}

main()
  .then(() => {
    // MaaFW 的线程会让 node 不退出，这里必须强杀。
    process.exit(0)
  })
  .catch((err: unknown) => {
    process.stderr.write('[child] ' + (err instanceof Error ? err.message : String(err)) + '\n')
    process.exit(1)
  })
