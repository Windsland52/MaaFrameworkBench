import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { maafw } from '../maa.ts'
import { remoteFramesActor } from '../env/frames/remote.ts'

/**
 * 可独立分发的自测入口：拿着项目与一台远程设备，post 一次 task，把过程打出来。
 *
 * 依赖闭包只有三份文件：本入口、`env/frames/remote.ts` 适配器、`maa.ts` 门面，
 * 外加 maa-node 运行时与 OCR 目录（运行环境配置）—— 不 import runner、任务加载器、
 * 判分器。复制这三份到任何地方即可离仓运行（`pnpm check:selftest` 验收的就是这个）。
 *
 * 它能给的只有三样：执行状态、识别轨迹、调试截图。断言与环境内部状态（屏名、转移
 * 规则）在设备服务那侧 —— 不是不愿意给，是这个进程结构上就拿不到。
 *
 * 退出码说的是**链路健康**，不是判分：识别未命中 / task failed 且全程无设备通信异常 → 0；
 * 设备通信异常、加载失败、框架错误状态 → 1。设备调用失败在**回调边界**记录并原样抛回 ——
 * 不靠解析 stderr，也不靠启动探活（设备可能中途断开）。
 */

const USAGE = [
  '用法: node entry.ts --project <dir> --entry <节点> --device <url> --token <t> [--ocr <dir>] [--out <dir>]',
  '',
  '选项:',
  '  --ocr <dir>   OCR 模型目录；缺省读环境变量 MAAFW_OCR_DIR（镜像里作为运行环境配置给好）',
  '  --out <dir>   调试截图与 MaaFW 日志落在哪（默认 <project>/.self-test，提交时整目录排除）',
  '',
  '退出码: 0 = 链路健康（识别未命中 / task failed 不算）；1 = 设备通信异常 / 加载失败 / 框架错误',
].join('\n')

interface Args {
  project: string
  entry: string
  device: string
  token: string
  ocr: string
  out: string
}

function parseArgs(argv: string[]): Args {
  const value = (flag: string): string => {
    const i = argv.indexOf(flag)
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1]! : ''
  }
  return {
    project: value('--project'),
    entry: value('--entry'),
    device: value('--device'),
    token: value('--token'),
    ocr: value('--ocr'),
    out: value('--out'),
  }
}

const args = parseArgs(process.argv.slice(2))
if (args.project === '' || args.entry === '' || args.device === '' || args.token === '') {
  console.error(USAGE)
  process.exit(1)
}

const project = resolve(args.project)
const bundle = join(project, 'resource', 'base')
if (!existsSync(join(bundle, 'pipeline'))) {
  console.error('项目里没有 resource/base/pipeline：' + bundle)
  process.exit(1)
}
// 先判原始值再 resolve：resolve('') 是当前目录，空值检查永远打不中
const ocrRaw = args.ocr !== '' ? args.ocr : (process.env.MAAFW_OCR_DIR ?? '')
if (ocrRaw === '') {
  console.error('OCR 目录没给（--ocr 或环境变量 MAAFW_OCR_DIR）')
  process.exit(1)
}
const ocrModelDir = resolve(ocrRaw)
if (!existsSync(ocrModelDir) || !statSync(ocrModelDir).isDirectory()) {
  console.error('OCR 目录不在（--ocr 或 MAAFW_OCR_DIR）：' + ocrModelDir)
  process.exit(1)
}
const outDir = resolve(args.out !== '' ? args.out : join(project, '.self-test'))
const shotsDir = join(outDir, 'shots')
mkdirSync(shotsDir, { recursive: true })

/** 与 MaaFW 自己保存截图同一种名字 —— 一张图的名字就是它被交出去的那一刻 */
const pad = (value: number, width = 2): string => String(value).padStart(width, '0')
let lastShotAt = 0
let shots = 0
function saveShot(bytes: ArrayBuffer): string {
  const now = Date.now()
  lastShotAt = now > lastShotAt ? now : lastShotAt + 1
  const d = new Date(lastShotAt)
  const name =
    d.getFullYear() +
    '.' +
    pad(d.getMonth() + 1) +
    '.' +
    pad(d.getDate()) +
    '-' +
    pad(d.getHours()) +
    '.' +
    pad(d.getMinutes()) +
    '.' +
    pad(d.getSeconds()) +
    '.' +
    pad(d.getMilliseconds(), 3) +
    '.png'
  writeFileSync(join(shotsDir, name), Buffer.from(bytes))
  return name
}

/**
 * 设备调用边界：失败记一笔再原样抛回 —— 退出码靠这份记录，不靠解析 stderr，
 * 也不靠启动探活（connect 本地即真，且设备可能中途断开，探活证明不了什么）。
 */
const deviceErrors: string[] = []
const guard = async <T>(what: string, call: () => maa.MaybePromise<T>): Promise<T> => {
  try {
    return await call()
  } catch (err) {
    deviceErrors.push(what + ': ' + (err instanceof Error ? err.message : String(err)))
    throw err
  }
}

/** screencap 的字节顺手留档：自测里设备交了哪些图，是排错的第一手材料 */
const device = remoteFramesActor(args.device, args.token)
const actor: maa.CustomControllerActor = {
  ...device,
  screencap: async () => {
    const bytes = await guard('screencap', () => device.screencap!())
    if (bytes === null) {
      deviceErrors.push('screencap: 设备返回 null')
      return null
    }
    shots += 1
    saveShot(bytes)
    return bytes
  },
  click: (x, y) => guard('click', () => device.click!(x, y)),
  swipe: (x1, y1, x2, y2, duration) => guard('swipe', () => device.swipe!(x1, y1, x2, y2, duration)),
  shell: (cmd, timeout) => guard('shell', () => device.shell!(cmd, timeout)),
}

interface Row {
  at: number
  what: string
}
const rows: Row[] = []

async function main(): Promise<number> {
  maafw.Global.log_dir = outDir
  maafw.Global.stdout_level = 'Off'

  // 加载顺序与仓库内 boot.ts 同源（阶段 0 实测）：bundle → OCR → connection → 绑定
  const res = new maafw.Resource()
  const ctrl = new maafw.CustomController(actor)
  const tasker = new maafw.Tasker()
  const loadJob = res.post_bundle(bundle)
  await loadJob.wait()
  const ocrJob = res.post_ocr_model(ocrModelDir)
  await ocrJob.wait()
  const connJob = ctrl.post_connection()
  await connJob.wait()
  if (!(loadJob.succeeded && ocrJob.succeeded && connJob.succeeded))
    throw new Error('环境加载失败（资源包 / OCR 模型 / 控制器连接）')
  tasker.resource = res
  tasker.controller = ctrl

  // 任务级事件（Task.*）走 tasker sink；节点 / 识别 / 动作走 context sink —— 实测就是这么分的
  tasker.add_sink((_t, msg) => {
    const m = msg as Record<string, unknown>
    if (m.msg === 'Task.Starting') rows.push({ at: Date.now(), what: 'post 一次 task（入口 ' + String(m.entry) + '）' })
    else if (m.msg === 'Task.Succeeded' || m.msg === 'Task.Failed')
      rows.push({ at: Date.now(), what: 'task ' + (m.msg === 'Task.Succeeded' ? '成功' : '失败') })
  })
  tasker.add_context_sink((_c, msg) => {
    const m = msg as Record<string, unknown>
    const who = '「' + String(m.name) + '」'
    if (m.msg === 'Recognition.Succeeded') {
      // maa-node 把 Id 系类型标成 branded string，运行时其实是 number —— 这里只借它的类型
      const detail = tasker.recognition_detail(String(m.reco_id) as maa.RecoId)?.detail
      const best =
        detail && typeof detail === 'object' && 'best' in detail
          ? (detail as { best: { text?: string } | null }).best
          : null
      rows.push({ at: Date.now(), what: who + '识别成功 → ' + JSON.stringify(best?.text ?? null) })
    } else if (m.msg === 'Recognition.Failed') rows.push({ at: Date.now(), what: who + '识别失败' })
    else if (m.msg === 'Action.Succeeded') {
      const a = m.action_details as { action?: string } | undefined
      rows.push({ at: Date.now(), what: who + '动作 ' + String(a?.action) })
    } else if (m.msg === 'PipelineNode.Failed')
      rows.push({ at: Date.now(), what: who + '节点失败（识别没命中且没有 next）' })
  })

  const t0 = Date.now()
  const job = tasker.post_task(args.entry)
  const status = Number(
    await Promise.race([
      job.wait().status,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('run 内部超时')), 300_000)),
    ]),
  )

  for (const r of rows.sort((a, b) => a.at - b.at)) {
    console.log('+' + String(r.at - t0).padStart(6) + 'ms  ' + r.what)
  }
  const statusName = status === 3000 ? 'succeeded' : status === 4000 ? 'failed' : 'error'
  console.log('状态: ' + statusName + (status === 3000 ? '' : '（status=' + status + '）'))
  if (deviceErrors.length > 0)
    console.log('设备通信异常: ' + deviceErrors.length + ' 次（第 1 次: ' + deviceErrors[0]! + '）')
  console.log('截图: ' + shots + ' 张 → ' + shotsDir)
  ctrl.destroy()
  res.destroy()
  tasker.destroy()
  return status
}

let finalStatus = 0
try {
  finalStatus = await main()
} catch (err) {
  console.error('自测没跑成: ' + (err instanceof Error ? err.message : String(err)))
  process.exit(1)
}
// 链路健康 = 全程无设备通信异常，且框架以正常状态收场（succeeded / failed 都算；
// 其余 raw status 是框架侧错误）。task failed 是业务结果，不是链路问题。
const healthy = deviceErrors.length === 0 && (finalStatus === 3000 || finalStatus === 4000)
// MaaFW 的线程会让 node 不退出，这里必须强杀；本进程也用 fetch（经远程适配器），
// 是铁律里两条的交集场景 —— 与执行子进程同款，由 check:selftest 守着
process.exit(healthy ? 0 : 1)
