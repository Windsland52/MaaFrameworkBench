import { methodProblems, type MethodEvidence } from '../src/runner/method.ts'

/**
 * 执行方法自检的自检，**每条正例配一条必须被抓到的负例**。
 *
 * 理由和"判分器真的会判不过吗"那条一样：一个从来没红过的检查，
 * 和"这个检查根本不工作"看起来一模一样。负例里特意放了 Dbg 型错位 ——
 * 它在总识别次数上完全看不出来，只有对着序列才现形。
 *
 * 合成负例只证明"规则写得对"。真跑那一步另有变异审计：把 actor 的 screencap 换成
 * Dbg 型环形轮播再跑一次正确提交，规则立刻报出三次"画面在跟着截图次数走"，
 * 而**那次 run 的 status 依然是 succeeded** —— 这种错位不会自己报错，只会悄悄失真。
 */

let failures = 0
const check = (name: string, problems: string[], expect: string | null): void => {
  const hit = problems.length > 0
  const ok = expect === null ? !hit : hit && problems.some((p) => p.includes(expect))
  if (!ok) failures += 1
  console.log((ok ? 'OK  ' : 'FAIL') + ' | ' + name + '\n       ' + (hit ? problems.join('；') : '无问题'))
}

const task = (entry = 'Main.Start'): Array<Record<string, unknown>> => [
  { msg: 'Task.Starting', entry },
  { msg: 'Task.Succeeded', entry },
]

/** 照抄仓库里那次真跑（正确实现）：点 STOCK 把画面从 home 带到 inventory。 */
const correctOps: Array<Record<string, unknown>> = [
  { op: 'screencap', screen: 'home', moved: false },
  { op: 'click', screen: 'home', moved: true },
  { op: 'screencap', screen: 'inventory', moved: false },
  { op: 'screencap', screen: 'inventory', moved: false },
]

/** 同样照抄真跑（点错按钮）：点在不响应的地方，画面一直停在 home。 */
const stuckOps: Array<Record<string, unknown>> = [
  { op: 'screencap', screen: 'home', moved: false },
  { op: 'click', screen: 'home', moved: false },
  { op: 'screencap', screen: 'home', moved: false },
  { op: 'screencap', screen: 'home', moved: false },
]

const run = (ops: Array<Record<string, unknown>>, events = task()): MethodEvidence => ({
  events,
  ops,
  entry: 'Main.Start',
})

check('一次 post + 换屏由输入造成', methodProblems(run(correctOps)), null)
check('点空处：画面不变也不算坏', methodProblems(run(stuckOps)), null)
check('被硬杀：没有过程证据就不指控', methodProblems(run([], [])), null)
check(
  '换屏出现在 screencap 那一行（Dbg 型错位）',
  methodProblems(run([...stuckOps, { op: 'screencap', screen: 'inventory', moved: false }])),
  '跟着截图次数走',
)
check(
  '逐节点投喂：事件流里两个 Task.Starting',
  methodProblems(run(correctOps, [...task(), { msg: 'Task.Starting', entry: 'Main.Start' }])),
  '只该 post 一次',
)
check(
  'post 的入口与任务声明不一致',
  methodProblems({ events: task('Other.Entry'), ops: correctOps, entry: 'Main.Start' }),
  '入口',
)
check(
  '输入自称带走了画面，画面却没换',
  methodProblems(
    run([
      { op: 'screencap', screen: 'home', moved: false },
      { op: 'click', screen: 'home', moved: true },
      { op: 'screencap', screen: 'home', moved: false },
    ]),
  ),
  '画面没换',
)

console.log(
  failures === 0 ? '执行方法自检通过（7 例：4 条正例 + 3 条该抓的坏法）' : '执行方法自检失败 ' + failures + ' 例',
)
process.exitCode = failures === 0 ? 0 : 1
