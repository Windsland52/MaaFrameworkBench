/**
 * 一次 run 的 token / 时间账。
 *
 * 这块**全部是被测系统自报的**：我们既看不到它的 API 调用，也验不了它的记账。
 * 三条纪律写进类型里：
 *   - `source` 必填：自报的数据必须标明谁报的，否则事后没人能追。
 *   - 计数缺失落成 `null`，**绝不落成 0**：0 是"确实没花"，null 是"没报"。
 *   - 坏输入一律**拒绝**，不替它圆：静默修好的账比没有账更危险。
 *
 * 厂商原始报文（raw）不在这里 —— 它整份原样归档成 run 目录下的 `usage.json`，
 * run.json 只留规范化结果和归档指纹。原始报文可达 MB 级，塞进 run.json 会让
 * 每个聚合器都要为它付解析成本。
 */

export interface ModelUsage {
  provider: string | null
  /** 臂里请求的模型名；计价按它 */
  model: string
  /** 厂商回执里服务的那只（快照）；拿不到就是 null，不猜 */
  model_reported: string | null
  /** main | subagent | summarize … */
  role: string | null
  input_tokens: number | null
  output_tokens: number | null
  cache_read_input_tokens: number | null
  cache_write_input_tokens: number | null
  reasoning_tokens: number | null
  turns: number | null
  tool_calls: number | null
}

export interface Usage {
  /** 谁报的，例：dsh-usage-hook@1 */
  source: string
  billing: { mode: 'metered' | 'subscription'; plan?: string } | null
  /** 一个模型一个桶；(provider, model, role) 唯一 —— 重复键直接拒 */
  by_model: ModelUsage[]
  timing: { agent_wall_ms: number | null; llm_ms: number | null; tool_ms: number | null } | null
}

/** 报错里说清"给的是什么东西"。不能 JSON.stringify —— 对 BigInt / 循环引用它会抛，
    对有 toJSON 的对象它会谎报（"实际 1"）。 */
function describe(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value)
  if (Array.isArray(value)) return '数组'
  return typeof value
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 可选字符串：缺省或 null 都算"没给"；给了就必须是非空字符串。 */
function optionalText(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || value.trim() === '')
    throw new Error(field + ' 必须是非空字符串，实际 ' + describe(value))
  return value
}

/** 计数：缺省 -> null；给了就必须是**安全**非负整数。
    越过 2^53 的整数加总会静默失真（1e21 + 1 === 1e21），所以不能只判 isInteger。 */
function counter(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(field + ' 必须是非负安全整数，实际 ' + describe(value))
  }
  return value
}

/**
 * 校验并归一化 usage.json。只判"能不能信"；算钱不在这里（定价表会变，账不会）。
 */
export function parseUsage(raw: unknown): Usage {
  if (!isPlainObject(raw)) throw new Error('usage 必须是对象，实际 ' + describe(raw))
  const o = raw

  const source = optionalText(o.source, 'usage.source')
  if (source === null) throw new Error('usage.source 必填（自报的数据要能追来源）')

  let billing: Usage['billing'] = null
  if (o.billing !== undefined && o.billing !== null) {
    if (!isPlainObject(o.billing)) throw new Error('usage.billing 必须是对象，实际 ' + describe(o.billing))
    const mode = o.billing.mode
    if (mode !== 'metered' && mode !== 'subscription') {
      throw new Error('usage.billing.mode 必填且只能是 metered 或 subscription，实际 ' + describe(mode))
    }
    // plan 是"订阅制批不和计量制混着报美元"唯一的归属线索，给了就必须是字符串 —— 不能悄悄丢
    const plan = optionalText(o.billing.plan, 'usage.billing.plan')
    billing = { mode, ...(plan === null ? {} : { plan }) }
  }

  if (!Array.isArray(o.by_model) || o.by_model.length === 0) {
    throw new Error(
      'usage.by_model 必须是非空数组（一个模型一个桶；只有一只也要写一个桶），实际 ' + describe(o.by_model),
    )
  }

  const seen = new Map<string, number>()
  const by_model = o.by_model.map((entry, i): ModelUsage => {
    const at = 'usage.by_model[' + i + ']'
    if (!isPlainObject(entry)) throw new Error(at + ' 必须是对象，实际 ' + describe(entry))
    const model = optionalText(entry.model, at + '.model')
    if (model === null) throw new Error(at + '.model 必填')
    const provider = optionalText(entry.provider, at + '.provider')
    const role = optionalText(entry.role, at + '.role')

    // 桶 = 唯一键。重复键不合并也不原样保留：合并是替它编账，保留则让"每模型一个桶"
    // 在数据里不成立（下游对总额和分布会有两种解释）。
    const key = [provider ?? '', model, role ?? ''].join('\u0000')
    const first = seen.get(key)
    if (first !== undefined)
      throw new Error(
        at +
          ' 与 usage.by_model[' +
          first +
          '] 的 (provider, model, role) 完全相同；桶必须唯一（要合并请在写账那侧做）',
      )
    seen.set(key, i)

    return {
      provider,
      model,
      model_reported: optionalText(entry.model_reported, at + '.model_reported'),
      role,
      input_tokens: counter(entry.input_tokens, at + '.input_tokens'),
      output_tokens: counter(entry.output_tokens, at + '.output_tokens'),
      cache_read_input_tokens: counter(entry.cache_read_input_tokens, at + '.cache_read_input_tokens'),
      cache_write_input_tokens: counter(entry.cache_write_input_tokens, at + '.cache_write_input_tokens'),
      reasoning_tokens: counter(entry.reasoning_tokens, at + '.reasoning_tokens'),
      turns: counter(entry.turns, at + '.turns'),
      tool_calls: counter(entry.tool_calls, at + '.tool_calls'),
    }
  })

  // 桶键唯一 ⇒ 这个序就是全序，同输入必得同输出（报告对齐与哈希都靠它）
  by_model.sort((a, b) => {
    const key = (m: ModelUsage): string => [m.provider ?? '', m.model, m.role ?? ''].join('\u0000')
    return key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0
  })

  let timing: Usage['timing'] = null
  if (o.timing !== undefined && o.timing !== null) {
    if (!isPlainObject(o.timing)) throw new Error('usage.timing 必须是对象，实际 ' + describe(o.timing))
    timing = {
      agent_wall_ms: counter(o.timing.agent_wall_ms, 'usage.timing.agent_wall_ms'),
      llm_ms: counter(o.timing.llm_ms, 'usage.timing.llm_ms'),
      tool_ms: counter(o.timing.tool_ms, 'usage.timing.tool_ms'),
    }
  }

  return { source, billing, by_model, timing }
}
