import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer, type AddressInfo } from 'node:net'
import { execInChild, runTask, settleOutcome } from '../src/runner/main.ts'
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

async function runFault(name: string, url: string, token: string, boundMs: number): Promise<void> {
  const ws = faultWorkspace()
  try {
    const started = Date.now()
    const r = await runChildCfg({ ...ws.cfg, device: { url, token } })
    const wall = Date.now() - started
    // 不预设退出码 —— 这里要的证据是"有界终止、不挂住"；独立上界按场景收紧（见各调用处），
    // 只靠 60s 硬预算的话，客户端超时漂到几十秒也照样绿
    check(
      !r.timedOut && r.code !== null && wall < boundMs,
      name,
      wall +
        'ms（上界 ' +
        boundMs +
        'ms）退出码=' +
        r.code +
        (r.stderr.trim() === '' ? '' : ' stderr=' + r.stderr.trim().slice(0, 120)),
    )
  } finally {
    rmSync(ws.dir, { recursive: true, force: true })
  }
}

const screenPath = resolve(REPO_ROOT, 'data/maafw-demo-frames/home.png')

// 已关闭端口：子进程拿到的就是一个死地址（观察值 ~2.8s = 节点超时 2s + 装载）
{
  const svc = await serveFrames([{ name: 'home', path: screenPath }])
  const url = svc.url
  await svc.close()
  await runFault('已关闭端口：连接失败能正常收尾', url, svc.token, 15_000)
}

// 错 token：拒绝访问，且不产生环境操作证据
{
  const dir = mkdtempSync(join(tmpdir(), 'maafwbench-fault-svc-'))
  const svc = await serveFrames([{ name: 'home', path: screenPath }], { shotsDir: join(dir, 'shots') })
  try {
    await runFault('错 token：拒绝访问、有界终止', svc.url, '0'.repeat(64), 15_000)
    check(svc.frames.ops().length === 0, '错 token：不产生环境操作证据', svc.frames.ops().length + ' 条')
    check(!existsSync(join(dir, 'shots')), '错 token：不留任何截图')
  } finally {
    await svc.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

// 黑洞：收请求不响应 —— 客户端 5s 超时是这条路径上唯一的保险。
// 独立上界 12s = 5s abort + 装载与收尾裕量；abort 漂移（比如 30s）会在这里被抓红。
{
  let received = 0
  const hole = createServer((sock) => {
    sock.resume()
    sock.on('data', () => {
      received += 1
    })
  })
  await new Promise<void>((done) => hole.listen(0, '127.0.0.1', done))
  const port = (hole.address() as AddressInfo).port
  try {
    await runFault('黑洞（收请求不响应）：客户端 5s 超时确实生效', 'http://127.0.0.1:' + port, 'x', 12_000)
    check(received > 0, '黑洞确实收到了请求（不是没连上就失败）', received + ' 个数据块')
  } finally {
    hole.close()
  }
}

/* ---------- 退出结算：进程结局优先于回执；stderr 在 close 结算 ---------- */

// 回执只说明框架任务的结果 —— 它写在 teardown 之前，之后的卡死/崩溃不能被成功回执盖掉
{
  const cases: Array<{
    name: string
    summary: { status: string; error?: string } | null
    exec: { code: number | null; timedOut: boolean; stderr: string; stdioIncomplete?: true }
    want: string
    failureIncludes?: string
  }> = [
    {
      name: '成功回执 + 干净退出',
      summary: { status: 'succeeded' },
      exec: { code: 0, timedOut: false, stderr: '' },
      want: 'succeeded',
    },
    {
      name: '成功回执 + 墙钟内没退出（teardown 卡死）',
      summary: { status: 'succeeded' },
      exec: { code: null, timedOut: true, stderr: '' },
      want: 'timeout',
      failureIncludes: '回执 succeeded',
    },
    {
      name: '成功回执 + 退出码 1（teardown 崩溃）',
      summary: { status: 'succeeded' },
      exec: { code: 1, timedOut: false, stderr: '[child] boom' },
      want: 'error',
      failureIncludes: 'boom',
    },
    {
      name: '框架失败回执 + 干净退出（识别未命中是正常失败）',
      summary: { status: 'failed' },
      exec: { code: 0, timedOut: false, stderr: '' },
      want: 'failed',
    },
    {
      name: '成功回执 + 干净退出码 + 输出收尾不完整（宽限强关管道）',
      summary: { status: 'succeeded' },
      exec: { code: 0, timedOut: false, stderr: '', stdioIncomplete: true },
      want: 'error',
      failureIncludes: '输出收尾不完整',
    },
    {
      name: '墙钟超时 + 输出收尾不完整（两条并存，超时主导）',
      summary: { status: 'succeeded' },
      exec: { code: null, timedOut: true, stderr: '', stdioIncomplete: true },
      want: 'timeout',
      failureIncludes: '输出收尾不完整',
    },
    {
      name: '无回执 + 超时',
      summary: null,
      exec: { code: null, timedOut: true, stderr: '' },
      want: 'timeout',
    },
    {
      name: '无回执 + 退出码 1',
      summary: null,
      exec: { code: 1, timedOut: false, stderr: '[child] 环境加载失败' },
      want: 'error',
      failureIncludes: '环境加载失败',
    },
    {
      name: '无回执 + 退出码 0（回执丢了）',
      summary: null,
      exec: { code: 0, timedOut: false, stderr: '' },
      want: 'error',
    },
  ]
  for (const c of cases) {
    const outcome = settleOutcome(c.summary, c.exec)
    check(
      outcome.status === c.want &&
        (c.failureIncludes === undefined || (outcome.failure ?? '').includes(c.failureIncludes)),
      '结算优先级：' + c.name,
      'status=' + outcome.status + ' failure=' + (outcome.failure ?? '（无）'),
    )
  }
}

// 退出前写出的 stderr 必须收齐：exit 不保证 stdio 已关，结算在 close 才做
{
  const dir = mkdtempSync(join(tmpdir(), 'maafwbench-exit-'))
  try {
    const cfgFile = join(dir, 'cfg.json')
    writeFileSync(cfgFile, '{}')
    const trailing = join(dir, 'trailing.mjs')
    // 大块写出，**write 回调里才退出**：异步管道平台上，写完就 process.exit 可能截掉
    // 子进程自己还没写出的部分 —— 那不是父进程的锅。回调保证了"已写出"，测试只剩
    // "父进程是否收齐"这一件事，于是可以断言逐字节一致。
    const trailingOut = 'trailing-start\n' + 'x'.repeat(64 * 1024) + '\ntrailing-end\n'
    writeFileSync(trailing, 'process.stderr.write(' + JSON.stringify(trailingOut) + ', () => process.exit(0))\n')
    const r = await execInChild(cfgFile, 30_000, trailing)
    check(
      r.code === 0 && r.stderr === trailingOut,
      '退出前的 stderr 逐字节收齐（close 结算）',
      'stderr ' + r.stderr.length + ' 字节（期望 ' + trailingOut.length + '）',
    )

    // 孤儿进程拽住管道：close 永不到来。宽限到期必须强关**本端管道**并打 stdioIncomplete ——
    // 只让 Promise 有界返回而管道不放，runner 进程自己也会被拽住
    const holder = join(dir, 'holder.mjs')
    writeFileSync(
      holder,
      [
        "import { spawn } from 'node:child_process'",
        "spawn(process.execPath, ['-e', 'setTimeout(() => {}, 8000)'], { stdio: ['ignore', 'inherit', 'inherit'], detached: true })",
        "process.stderr.write('parent-exiting\\n')",
        'process.exit(0)',
      ].join('\n'),
    )
    const started = Date.now()
    const r2 = await execInChild(cfgFile, 30_000, holder)
    const wall = Date.now() - started
    check(
      r2.code === 0 &&
        r2.timedOut === false &&
        r2.stdioIncomplete === true &&
        wall < 7500 &&
        r2.stderr.includes('parent-exiting'),
      '孤儿拽住管道：宽限到期强关管道、标记不完整（5s 宽限 < 孤儿存活的 8s）',
      wall + 'ms incomplete=' + String(r2.stdioIncomplete === true),
    )

    // 墙钟在子进程退出后不得再触发：预算 1s < 宽限 5s，等收尾期间预算到期，
    // 不能把一次正常退出误报成"墙钟超时"、对已死的 PID 补刀
    const r3 = await execInChild(cfgFile, 1000, holder)
    check(
      r3.code === 0 && r3.timedOut === false && r3.stdioIncomplete === true,
      '子进程已退出后墙钟停表（执行与收尾两段分开计时）',
      'code=' + r3.code + ' timedOut=' + r3.timedOut + ' incomplete=' + String(r3.stdioIncomplete === true),
    )

    // 外层进程级验证：runner 自己也得能结束 —— 强关管道后事件循环不再被拽住。
    // 孤儿存活 12s：若管道未释放，外层要等到孤儿死（>12s）才能退；上界 9s 能区分两者
    const holder12 = join(dir, 'holder12.mjs')
    writeFileSync(
      holder12,
      [
        "import { spawn } from 'node:child_process'",
        "spawn(process.execPath, ['-e', 'setTimeout(() => {}, 12000)'], { stdio: ['ignore', 'inherit', 'inherit'], detached: true })",
        'process.exit(0)',
      ].join('\n'),
    )
    const outer = join(dir, 'outer.ts')
    writeFileSync(
      outer,
      [
        'import { execInChild } from ' +
          JSON.stringify(pathToFileURL(join(REPO_ROOT, 'src', 'runner', 'main.ts')).href),
        'const r = await execInChild(' + JSON.stringify(cfgFile) + ', 30_000, ' + JSON.stringify(holder12) + ')',
        "process.stderr.write('outer-result incomplete=' + (r.stdioIncomplete === true) + ' code=' + r.code + '\\n')",
        'process.exitCode = 0',
      ].join('\n'),
    )
    const startedOuter = Date.now()
    const r4 = await execInChild(cfgFile, 20_000, outer)
    const wallOuter = Date.now() - startedOuter
    check(
      r4.code === 0 &&
        wallOuter < 9000 &&
        r4.stderr.includes('outer-result incomplete=true') &&
        r4.stdioIncomplete === undefined,
      '强关管道后外层 runner 进程有界结束（不是只有 Promise 有界）',
      wallOuter + 'ms',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log(failures.length === 0 ? '远程设备集成测试通过' : '远程设备集成测试失败：' + failures.join('；'))
process.exitCode = failures.length === 0 ? 0 : 1
