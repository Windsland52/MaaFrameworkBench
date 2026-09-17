import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
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
  /** 期望 run.json 的 error 里含这段字（用来证明"被拦下"而不是"跑挂了"） */
  expectErrorIncludes?: string
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
    name: '提交里藏 Command 动作（必须在起进程前拦下）',
    pipeline: 'systems/ref/command.json',
    repeat: 10,
    expectPass: false,
    expectFailing: ['env_state', 'node_hit', 'reco_text'],
    expectErrorIncludes: '被禁止的动作 Command',
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

/**
 * 记账这条支路的端到端覆盖。
 *
 * 为什么单独有这一段：在它之前，"坏账不影响 run"这句承诺**零覆盖** —— check-usage.ts
 * 只测纯函数，从没跑过 main.ts 的 usageFrom 分支；而一轮审查实测出来的结论才是唯一证据。
 * 承诺和检查必须成对，否则那句承诺迟早变成假的。
 */
async function checkUsageBranch(): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), 'maafwbench-usage-'))
  const good = join(dir, 'good.json')
  const bad = join(dir, 'bad.json')
  writeFileSync(
    good,
    JSON.stringify({
      source: 'verify@1',
      billing: { mode: 'metered' },
      by_model: [{ provider: 'p', model: 'm', role: 'main', input_tokens: 7, output_tokens: 3 }],
      timing: { agent_wall_ms: 1000, llm_ms: 600, tool_ms: 300 },
    }),
  )
  writeFileSync(bad, JSON.stringify({ by_model: [] }))

  let bad_ = 0
  const report = (ok: boolean, name: string, detail: string): void => {
    if (!ok) bad_ += 1
    console.log((ok ? 'OK  ' : 'FAIL') + ' | ' + name + '\n       ' + detail)
  }

  // 好账：落进 run.json，原始文件归档，指纹对得上
  rmSync(resolve(REPO_ROOT, 'runs', 't001-enter-inventory.verify.s1.r8'), { recursive: true, force: true })
  const r1 = await runTask('t001-enter-inventory', {
    system: 'verify',
    seed: 1,
    repeat: 8,
    pipelineFrom: resolve(REPO_ROOT, 'systems/ref/main.json'),
    usageFrom: good,
  })
  const run1 = JSON.parse(readFileSync(resolve(r1.runDir, 'run.json'), 'utf8')) as Record<string, unknown>
  const archive1 = resolve(r1.runDir, 'usage.json')
  const sha1 = existsSync(archive1) ? createHash('sha256').update(readFileSync(archive1)).digest('hex') : ''
  const recorded = (run1.usage_file as { sha256?: string } | undefined)?.sha256
  report(
    run1.usage !== undefined && run1.usage_error === undefined && recorded === sha1 && sha1 !== '',
    '好账：记入 run.json + 原始文件归档 + 指纹对得上',
    '归档 sha=' + sha1.slice(0, 12) + '，run.json 记的=' + String(recorded).slice(0, 12),
  )

  // 坏账：run 照样成功、照样判分，只留 usage_error
  rmSync(resolve(REPO_ROOT, 'runs', 't001-enter-inventory.verify.s1.r9'), { recursive: true, force: true })
  const r2 = await runTask('t001-enter-inventory', {
    system: 'verify',
    seed: 1,
    repeat: 9,
    pipelineFrom: resolve(REPO_ROOT, 'systems/ref/main.json'),
    usageFrom: bad,
  })
  const run2 = JSON.parse(readFileSync(resolve(r2.runDir, 'run.json'), 'utf8')) as Record<string, unknown>
  const scored2 = await score(r2.runDir)
  report(
    r2.status === 'succeeded' && scored2.passed && run2.usage === undefined && typeof run2.usage_error === 'string',
    '坏账：run 仍成功并判分，只记 usage_error',
    'status=' +
      r2.status +
      ' passed=' +
      scored2.passed +
      ' usage_error=' +
      JSON.stringify(String(run2.usage_error).slice(0, 40)),
  )
  report(
    r2.usageError === undefined ? false : true,
    '坏账：usageError 也回到了调用方（批量脚本能看见）',
    JSON.stringify(r2.usageError),
  )

  rmSync(dir, { recursive: true, force: true })
  return bad_
}

let failures = 0
failures += await checkUsageBranch()
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
  const runText = readFileSync(resolve(result.runDir, 'run.json'), 'utf8')
  const errorOk = c.expectErrorIncludes === undefined ? true : runText.includes(c.expectErrorIncludes)
  const ok = scored.passed === c.expectPass && failing.join(',') === want.join(',') && errorOk
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
