import { readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { REPO_ROOT } from '../src/runner/root.ts'
import { runTask } from '../src/runner/main.ts'
import { score } from '../src/scorer/main.ts'

/**
 * 闭环自检：跑一组**已知该过 / 该不过**的提交，确认判分器真的会判不过。
 *
 * 没有这一组，"判分器把所有东西都判过"和"判分器工作正常"看起来一模一样。
 * 它只是开发期自检，不是评测流程的一部分。
 *
 * 两处来自实测、不那么直觉的期望：
 *   - 识别不到的节点**不发 PipelineNode.Starting**，也不会有识别结果，
 *     所以"读错数量"会同时挂掉 node_hit 与 reco_text 两条，不是只挂 reco_text。
 *   - 未命中的 next 会重试到本节点 timeout（默认 20s），所以点错按钮那一例
 *     识别次数会很多 —— 它跑不完是判据该抓的事，不是判据坏了。
 */
interface Case {
  name: string
  pipeline: string
  repeat: number
  /** 期望的 passed */
  expectPass: boolean
  /** 期望具体哪几条断言不过（空的表示不该有断言失败） */
  expectFailing?: string[]
  budgetWallMs?: number
}

const cases: Case[] = [
  { name: '正确实现', pipeline: 'systems/ref/main.json', repeat: 1, expectPass: true },
  // 与上一条行为完全相同，只有节点名不同（Main.Start 是题面约定过的，其余不是）。
  // 它必须过 —— 判据锚定题面没约定的名字，判的就是实现风格。
  { name: '同样的行为、不同的节点名', pipeline: 'systems/ref/renamed-nodes.json', repeat: 7, expectPass: true },
  {
    name: '点错按钮（点在不响应的地方）',
    pipeline: 'systems/ref/wrong-button.json',
    repeat: 2,
    expectPass: false,
    expectFailing: ['env_state', 'reco_text'], // node_hit 只锚定入口，入口是命中的
  },
  {
    name: '读错数量',
    pipeline: 'systems/ref/wrong-answer.json',
    repeat: 3,
    expectPass: false,
    expectFailing: ['reco_text'], // 同理：进入库存页那步是命中的，挂的是没读到数量
  },
  {
    name: '跑不完（墙钟 400ms）',
    pipeline: 'systems/ref/main.json',
    repeat: 4,
    expectPass: false,
    expectFailing: ['env_state', 'node_hit', 'reco_text'],
    budgetWallMs: 400,
  },
]

/** 同一份提交跑两次必须得到同一个快照哈希，否则"只判首次提交"无从谈起。 */
async function checkReproducible(): Promise<boolean> {
  const hashes: string[] = []
  for (const repeat of [5, 6]) {
    rmSync(resolve(REPO_ROOT, 'runs', 't001-enter-inventory.verify.s1.r' + repeat), { recursive: true, force: true })
    const r = await runTask('t001-enter-inventory', {
      system: 'verify',
      seed: 1,
      repeat,
      pipelineFrom: resolve(REPO_ROOT, 'systems/ref/main.json'),
    })
    hashes.push(r.submissionSha256)
  }
  const same = hashes[0] === hashes[1]
  console.log((same ? 'OK  ' : 'FAIL') + ' | 同一提交两次快照哈希一致 | ' + hashes[0]!.slice(0, 16))
  return same
}

let failures = 0
if (!(await checkReproducible())) failures += 1
for (const c of cases) {
  // runner 不允许同一个 (task, system, seed, repeat) 有第二条记录，自检重跑先清自己的目录
  rmSync(resolve(REPO_ROOT, 'runs', 't001-enter-inventory.verify.s1.r' + c.repeat), { recursive: true, force: true })
  const result = await runTask('t001-enter-inventory', {
    system: 'verify',
    seed: 1,
    repeat: c.repeat,
    pipelineFrom: resolve(REPO_ROOT, c.pipeline),
    ...(c.budgetWallMs ? { budgetWallMs: c.budgetWallMs } : {}),
  })
  const scored = await score(result.runDir)
  const failing = scored.asserts
    .filter((a) => !a.ok)
    .map((a) => a.kind)
    .sort()
  const want = (c.expectFailing ?? []).slice().sort()
  const ok = scored.passed === c.expectPass && failing.join(',') === want.join(',')
  if (!ok) failures += 1
  console.log(
    (ok ? 'OK  ' : 'FAIL') +
      ' | ' +
      c.name +
      ' | status=' +
      result.status +
      ' passed=' +
      scored.passed +
      ' 断言失败=[' +
      failing.join(',') +
      ']' +
      ' 期望=[' +
      want.join(',') +
      ']',
  )
  console.log(
    '       ' +
      readFileSync(resolve(result.runDir, 'score.json'), 'utf8')
        .match(/"detail": "(.*)"/g)
        ?.join(' / '),
  )
}
console.log(failures === 0 ? '闭环自检通过' : '闭环自检失败 ' + failures + ' 例')
process.exitCode = failures === 0 ? 0 : 1
