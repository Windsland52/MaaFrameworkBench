import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer, type AddressInfo } from 'node:net'
import { execInChild, runTask } from '../src/runner/main.ts'
import { score } from '../src/scorer/main.ts'
import { runMethodProblems } from '../src/runner/method.ts'
import { loadTask } from '../src/runner/task.ts'
import { serveFrames } from '../src/env/frames/service.ts'
import { OCR_MODEL_DIR, REPO_ROOT } from '../src/runner/root.ts'

/**
 * 远程设备形态的集成测试：真实 runTask → 执行子进程 → 判分，外加设备故障矩阵。
 *
 * check-device 只证明了协议本身；这里证明 CustomController 经 HTTP 协议驱动真框架
 * （OCR、点击、换屏、证据合入）依然成立，且错误实现仍被判不过 —— 这是上隔离环境前
 * 必须补的一环。依赖 maa-node 原生库与 vendor/ocr；不依赖 WSL、不调模型、
 * runsRoot 指到临时目录（不写 runs/）。
 */

const failures: string[] = []
const check = (ok: boolean, name: string, detail = ''): void => {
  if (!ok) failures.push(name)
  console.log((ok ? 'OK  ' : 'FAIL') + ' | ' + name + (detail === '' ? '' : ' | ' + detail))
}

/* ---------- 真实通路：三夹具 + 一轮重跑（重复运行与退出稳定性） ---------- */

const runsRoot = mkdtempSync(join(tmpdir(), 'maafwbench-integ-'))
const entry = loadTask(REPO_ROOT, 't001-enter-inventory').task.entry
const cases = [
  { name: '正确夹具', fixture: 'correct.json', expectPass: true, expectFailing: [] as string[] },
  { name: '点错按钮', fixture: 'wrong-button.json', expectPass: false, expectFailing: ['env_state', 'reco_text'] },
  { name: '读错数量', fixture: 'wrong-answer.json', expectPass: false, expectFailing: ['reco_text'] },
]

let recoReadTwelve = false
for (let i = 0; i < cases.length + 1; i += 1) {
  const c = cases[i < cases.length ? i : 0]! // 最后一轮重跑正确夹具
  const label = '[' + c.name + ' r' + i + ']'
  const r = await runTask('t001-enter-inventory', {
    system: 'remote-integration',
    seed: 1,
    repeat: i,
    pipelineFrom: resolve(REPO_ROOT, 'tasks/t001-enter-inventory/fixtures', c.fixture),
    runsRoot,
    device: {},
  })
  const scored = await score(r.runDir)
  const failing = scored.asserts
    .filter((a) => !a.ok)
    .map((a) => a.kind)
    .sort()
  const want = c.expectFailing.slice().sort()
  const method = runMethodProblems(r.runDir, entry)

  // fetch（undici）与 process.exit 的冲突在这里实测：退不干净会落成 error/timeout，
  // 正常失败（识别未命中 → MaaFW 4000）与正常成功一样是干净退出
  check(
    r.status === (c.expectPass ? 'succeeded' : 'failed'),
    label + ' 子进程干净退出（fetch 与强制退出的实测）',
    'status=' + r.status,
  )
  check(
    scored.passed === c.expectPass && failing.join(',') === want.join(','),
    label + ' 判分与期望一致',
    'passed=' + scored.passed + ' 断言失败=[' + failing.join(',') + ']',
  )
  check(method.length === 0, label + ' 执行方法成立（一次 post + 画面由输入驱动）', method.join('；'))
  // 绑定层诊断（"expect ArrayBuffer, got …"）只该出现在故障注入里：
  // 正常路径上冒出同类信息说明回调悄悄失败过 —— 是异常，不是噪音
  const cleanStderr = !existsSync(join(r.runDir, 'exec-stderr.log'))
  check(cleanStderr, label + ' 子进程 stderr 干净（绑定层诊断 = 异常信号）')

  if (c.name === '正确夹具') {
    // 证据分家：子进程回执只有框架侧；环境证据由宿主从服务合入
    const summary = JSON.parse(readFileSync(join(r.runDir, 'exec-summary.json'), 'utf8')) as Record<string, unknown>
    check(
      !('ops' in summary) && !('final_screen' in summary) && !('screens' in summary),
      label + ' 子进程回执只含框架侧',
      'keys=' + Object.keys(summary).join(','),
    )
    const ops = readFileSync(join(r.runDir, 'ops.jsonl'), 'utf8').trim().split('\n').filter(Boolean)
    check(
      ops.length > 0 && ops.every((l) => JSON.parse(l)!.op !== undefined),
      label + ' ops.jsonl 由宿主侧合入',
      ops.length + ' 条',
    )
    const shots = readdirSync(join(r.runDir, 'screens'))
    check(shots.length > 0, label + ' 截图在宿主侧留档', shots.length + ' 张')
    if (readFileSync(join(r.runDir, 'events.jsonl'), 'utf8').includes('"text":"12"')) recoReadTwelve = true
  }
}
check(recoReadTwelve, '真实 OCR 经 HTTP 读到数量（reco text=12）')
rmSync(runsRoot, { recursive: true, force: true })

/* ---------- 子进程自己守互斥：远程分支不携带帧配置 ---------- */

async function runChildCfg(
  cfg: Record<string, unknown>,
): Promise<{ code: number | null; timedOut: boolean; stderr: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'maafwbench-child-'))
  try {
    const cfgFile = join(dir, 'cfg.json')
    writeFileSync(cfgFile, JSON.stringify(cfg))
    return await execInChild(cfgFile, 60_000)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const baseCfg = {
  bundle: '',
  ocrModelDir: OCR_MODEL_DIR,
  logDir: '',
  eventsFile: '',
  summaryFile: '',
  entry: 'Main.Start',
}
const both = await runChildCfg({ ...baseCfg, device: { url: 'http://127.0.0.1:1', token: 'x' }, screens: [] })
check(both.code === 1 && both.stderr.includes('互斥'), 'device 与 screens 同时出现被子进程拒绝', both.stderr.trim())

const neither = await runChildCfg({ ...baseCfg })
check(neither.code === 1 && neither.stderr.includes('screens'), '两个分支都不给被子进程拒绝', neither.stderr.trim())

/* ---------- 故障矩阵：设备坏了，执行进程要有界终止 ---------- */

/** 与 runner 的 applyHarnessDefaults 同一件事：节点超时收短，故障路径不必等默认 20s */
function faultWorkspace(): { dir: string; cfg: Record<string, unknown> } {
  const dir = mkdtempSync(join(tmpdir(), 'maafwbench-fault-'))
  const bundle = join(dir, 'resource', 'base')
  mkdirSync(join(bundle, 'pipeline'), { recursive: true })
  mkdirSync(join(dir, 'logs'))
  cpSync(resolve(REPO_ROOT, 'tasks/t001-enter-inventory/fixtures/correct.json'), join(bundle, 'pipeline', 'main.json'))
  writeFileSync(join(bundle, 'default_pipeline.json'), JSON.stringify({ Default: { timeout: 2000 } }))
  return {
    dir,
    cfg: {
      workspace: dir,
      bundle,
      ocrModelDir: OCR_MODEL_DIR,
      logDir: join(dir, 'logs'),
      eventsFile: join(dir, 'events.jsonl'),
      summaryFile: join(dir, 'summary.json'),
      entry: 'Main.Start',
    },
  }
}

async function runFault(name: string, url: string, token: string): Promise<void> {
  const ws = faultWorkspace()
  try {
    const started = Date.now()
    const r = await runChildCfg({ ...ws.cfg, device: { url, token } })
    const wall = Date.now() - started
    // 不预设退出码 —— 这里要的证据是"有界终止、不挂住"，退出码原样报出来
    check(
      !r.timedOut && r.code !== null,
      name,
      wall + 'ms 退出码=' + r.code + (r.stderr.trim() === '' ? '' : ' stderr=' + r.stderr.trim().slice(0, 120)),
    )
  } finally {
    rmSync(ws.dir, { recursive: true, force: true })
  }
}

const screenPath = resolve(REPO_ROOT, 'data/maafw-demo-frames/home.png')

// 已关闭端口：子进程拿到的就是一个死地址
{
  const svc = await serveFrames([{ name: 'home', path: screenPath }])
  const url = svc.url
  await svc.close()
  await runFault('已关闭端口：连接失败能正常收尾', url, svc.token)
}

// 错 token：拒绝访问，且不产生环境操作证据
{
  const dir = mkdtempSync(join(tmpdir(), 'maafwbench-fault-svc-'))
  const svc = await serveFrames([{ name: 'home', path: screenPath }], { shotsDir: join(dir, 'shots') })
  try {
    await runFault('错 token：拒绝访问、有界终止', svc.url, '0'.repeat(64))
    check(svc.frames.ops().length === 0, '错 token：不产生环境操作证据', svc.frames.ops().length + ' 条')
    check(!existsSync(join(dir, 'shots')), '错 token：不留任何截图')
  } finally {
    await svc.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

// 黑洞：收请求不响应 —— 客户端 5s 超时是这条路径上唯一的保险，任务预算兜底
{
  const hole = createServer((sock) => {
    sock.resume()
  })
  await new Promise<void>((done) => hole.listen(0, '127.0.0.1', done))
  const port = (hole.address() as AddressInfo).port
  try {
    await runFault('黑洞（收请求不响应）：客户端超时生效、预算兜底', 'http://127.0.0.1:' + port, 'x')
  } finally {
    hole.close()
  }
}

console.log(failures.length === 0 ? '远程设备集成测试通过' : '远程设备集成测试失败：' + failures.join('；'))
process.exitCode = failures.length === 0 ? 0 : 1
