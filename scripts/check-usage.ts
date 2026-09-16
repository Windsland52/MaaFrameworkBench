import { parseUsage, type Usage } from '../src/runner/usage.ts'

/**
 * usage.json 校验器的自检。
 *
 * 它守的是"记账"这一层：坏输入必须**被拒绝**而不是被悄悄修好 —— 一个把 null 当 0、
 * 或者把重复桶合并掉的记账器，能让整批成本结论反过来，而且没人看得出。
 *
 * 输出全是人话：这块的正确性不需要读代码来确认，看这一页就够了。
 *
 * 注意（踩过一次）：曾经那条"桶顺序与输入顺序无关"的检查用的是两个 **model 名不同**
 * 的桶，键全不相同 ⇒ 永远进不了并列分支 ⇒ 恒真。凡是"检查"都要先问它怎么才能失败。
 */

interface Case {
  name: string
  input: unknown
  /** 期望拒绝；给了内容就要求错误信息里包含它 */
  rejectWith?: string
  check?: (u: Usage) => string
}

const bucket = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  provider: 'deepseek',
  model: 'deepseek-v4.1-flash',
  role: 'main',
  input_tokens: 120000,
  output_tokens: 8000,
  ...over,
})

const good = {
  source: 'dsh-usage-hook@1',
  billing: { mode: 'metered', plan: 'team' },
  timing: { agent_wall_ms: 480000, llm_ms: 300000, tool_ms: 150000 },
  by_model: [bucket(), bucket({ model: 'deepseek-v4.1-flash-mini', role: 'subagent', input_tokens: 30000 })],
}

const cases: Case[] = [
  {
    name: '正常输入',
    input: good,
    check: (u) => u.by_model.length + ' 个桶：' + u.by_model.map((m) => m.model + '/' + (m.role ?? '?')).join(' , '),
  },
  {
    name: '同一模型不同 role 分两桶（子 agent 的开销能拆出来）',
    input: {
      source: 'x',
      by_model: [bucket({ role: 'main', input_tokens: 1 }), bucket({ role: 'subagent', input_tokens: 2 })],
    },
    check: (u) => (u.by_model.map((m) => m.role).join(',') === 'main,subagent' ? '2 桶，按 role 分开' : '顺序不对'),
  },
  {
    name: '没报的计数落成 null，不是 0',
    input: { source: 'x', by_model: [{ model: 'm' }] },
    check: (u) => 'input_tokens=' + JSON.stringify(u.by_model[0]!.input_tokens) + '（不是 0）',
  },
  {
    name: '未知字段忽略（向前兼容，加字段不用改这边）',
    input: { source: 'x', by_model: [{ model: 'm', future_field: 1 }], future_block: true },
    check: () => '接受',
  },
  {
    name: 'raw 不被带进规范化结果（原始报文归 run 目录里的归档文件）',
    input: { source: 'x', by_model: [{ model: 'm', raw: { blob: 'x'.repeat(200000) } }] },
    check: (u) => '规范化结果 ' + JSON.stringify(u).length + ' 字节（输入含 20 万字符的 raw）',
  },

  // —— 坏输入：必须拒绝 ——
  { name: '缺 source', input: { by_model: [{ model: 'm' }] }, rejectWith: 'usage.source 必填' },
  { name: 'source 是空串', input: { source: '  ', by_model: [{ model: 'm' }] }, rejectWith: '非空字符串' },
  { name: '顶层是数组', input: [], rejectWith: '必须是对象' },
  { name: 'by_model 是空的', input: { source: 'x', by_model: [] }, rejectWith: '非空数组' },
  { name: '桶里没写 model', input: { source: 'x', by_model: [{}] }, rejectWith: '.model 必填' },
  {
    name: '计数是负数',
    input: { source: 'x', by_model: [{ model: 'm', input_tokens: -1 }] },
    rejectWith: '非负安全整数',
  },
  {
    name: '计数是小数',
    input: { source: 'x', by_model: [{ model: 'm', output_tokens: 1.5 }] },
    rejectWith: '非负安全整数',
  },
  { name: '计数是字符串', input: { source: 'x', by_model: [{ model: 'm', turns: '40' }] }, rejectWith: '非负安全整数' },
  {
    name: '计数越过 2^53（1e21）',
    input: { source: 'x', by_model: [{ model: 'm', input_tokens: 1e21 }] },
    rejectWith: '非负安全整数',
  },
  {
    name: '计数是 NaN',
    input: { source: 'x', by_model: [{ model: 'm', input_tokens: Number.NaN }] },
    rejectWith: '非负安全整数',
  },
  {
    name: '计数是布尔',
    input: { source: 'x', by_model: [{ model: 'm', tool_calls: true }] },
    rejectWith: '非负安全整数',
  },
  {
    name: '两个桶的 (provider, model, role) 完全相同',
    input: { source: 'x', by_model: [bucket({ input_tokens: 1 }), bucket({ input_tokens: 2 })] },
    rejectWith: '桶必须唯一',
  },
  {
    name: 'billing.mode 缺失',
    input: { source: 'x', by_model: [{ model: 'm' }], billing: { plan: 'team' } },
    rejectWith: 'metered 或 subscription',
  },
  {
    name: 'billing.mode 写错',
    input: { source: 'x', by_model: [{ model: 'm' }], billing: { mode: 'monthly' } },
    rejectWith: 'metered 或 subscription',
  },
  {
    name: 'billing.plan 是数字（不能静默丢）',
    input: { source: 'x', by_model: [{ model: 'm' }], billing: { mode: 'metered', plan: 123 } },
    rejectWith: 'billing.plan',
  },
  {
    name: 'timing 是字符串',
    input: { source: 'x', by_model: [{ model: 'm' }], timing: 'nope' },
    rejectWith: 'usage.timing 必须是对象',
  },
  {
    name: 'timing 是数组',
    input: { source: 'x', by_model: [{ model: 'm' }], timing: [1, 2] },
    rejectWith: 'usage.timing 必须是对象',
  },
  {
    name: 'timing 里的计时是字符串',
    input: { source: 'x', by_model: [{ model: 'm' }], timing: { tool_ms: '151000' } },
    rejectWith: 'tool_ms',
  },
]

let failures = 0
for (const c of cases) {
  let detail: string
  let ok: boolean
  if (c.rejectWith === undefined) {
    try {
      detail = c.check ? c.check(parseUsage(c.input)) : '接受'
      ok = true
    } catch (err) {
      detail = '本该接受却拒绝了：' + (err instanceof Error ? err.message : String(err))
      ok = false
    }
  } else {
    try {
      parseUsage(c.input)
      detail = '本该拒绝却接受了'
      ok = false
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      ok = message.includes(c.rejectWith)
      detail = '拒绝：' + message
    }
  }
  if (!ok) failures += 1
  console.log((ok ? 'OK  ' : 'FAIL') + ' | ' + c.name + '\n       ' + detail)
}

/** 桶顺序必须只由内容决定：键互不相同的输入，打乱顺序后输出要逐字节相同。 */
function checkOrderIsContentOnly(): { ok: boolean; detail: string } {
  const four = [
    bucket({ role: 'main' }),
    bucket({ role: 'subagent' }),
    bucket({ model: 'aaa-mini', role: 'main' }),
    bucket({ provider: 'openai', model: 'zzz', role: 'main' }),
  ]
  const a = JSON.stringify(parseUsage({ source: 'x', by_model: four }).by_model)
  const b = JSON.stringify(parseUsage({ source: 'x', by_model: [...four].reverse() }).by_model)
  return { ok: a === b, detail: a === b ? '4 桶打乱后逐字节相同' : '打乱后不同：\n' + a + '\n' + b }
}
const order = checkOrderIsContentOnly()
if (!order.ok) failures += 1
console.log((order.ok ? 'OK  ' : 'FAIL') + ' | 桶顺序只由内容决定\n       ' + order.detail)

console.log(
  failures === 0 ? '记账校验 ' + cases.length + ' 例 + 1 条顺序检查全部通过' : '记账校验失败 ' + failures + ' 例',
)
process.exitCode = failures === 0 ? 0 : 1
