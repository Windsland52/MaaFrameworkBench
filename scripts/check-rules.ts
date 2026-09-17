import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseLooseJson, scanForbiddenActions } from '../src/runner/preflight.ts'
import { REPO_ROOT } from '../src/runner/root.ts'

/**
 * 提交前置检查的自检：**宽容解析**与**动作白名单**。
 *
 * 这两件事必须成对验证，因为它们的失败方向相反：
 *   - 解析不够宽容 → 误伤合法提交（框架接受注释和尾随逗号，实测过）
 *   - 扫描漏掉路径 → 放行一份能在评测机上执行任意程序的提交
 * 所以每一类都要有"该接受"和"该拒绝"两侧的例子。
 */

let failures = 0
const check = (name: string, ok: boolean, detail: string): void => {
  if (!ok) failures += 1
  console.log((ok ? 'OK  ' : 'FAIL') + ' | ' + name + '\n       ' + detail)
}
const rejects = (fn: () => unknown): string | null => {
  try {
    fn()
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

/* ---------- 宽容解析 ---------- */
const parseCases: Array<{ name: string; text: string; ok: boolean }> = [
  { name: '行注释', text: '{ // 注释\n "a": 1 }', ok: true },
  { name: '块注释', text: '{ /* 注释 */ "a": 1 }', ok: true },
  { name: '尾随逗号', text: '{ "a": [1, 2,], }', ok: true },
  { name: 'BOM', text: '\uFEFF{ "a": 1 }', ok: true },
  { name: '字符串里的 // 不能被当注释', text: '{ "url": "https://example.com//x" }', ok: true },
  { name: '字符串里的 /* 不能被当注释', text: '{ "glob": "a/*/b" }', ok: true },
  { name: '字符串里的逗号不能被当尾随逗号', text: '{ "s": "1,]", "t": "2,}" }', ok: true },
  { name: '转义引号后的注释符仍在字符串里', text: '{ "s": "a\\"//b" }', ok: true },
  { name: '真坏掉的 JSON 仍要报错', text: '{ "a": }', ok: false },
]
for (const c of parseCases) {
  const message = rejects(() => parseLooseJson(c.text))
  check('解析：' + c.name, c.ok ? message === null : message !== null, c.ok ? '接受' : '拒绝：' + String(message))
}

/* ---------- 动作白名单 ---------- */
const dir = mkdtempSync(join(tmpdir(), 'maafwbench-rules-'))
const write = (rel: string, text: string): void => {
  const path = join(dir, rel)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}
const freshBundle = (files: Record<string, string>): string => {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'pipeline'), { recursive: true })
  for (const [rel, text] of Object.entries(files)) write(rel, text)
  return dir
}

interface ScanCase {
  name: string
  files: Record<string, string>
  allowed?: string[]
  expectHit: boolean
  /** 期望命中的位置片段 */
  contains?: string
}
const scanCases: ScanCase[] = [
  {
    name: '字符串写法：action: "Command"',
    files: { 'pipeline/a.json': '{ "N": { "recognition": "OCR", "action": "Command", "exec": "cmd" } }' },
    expectHit: true,
    contains: '节点 N',
  },
  {
    name: '对象写法：action: { type: "Command" }',
    files: { 'pipeline/a.json': '{ "N": { "action": { "type": "Command", "param": { "exec": "cmd" } } } }' },
    expectHit: true,
    contains: '节点 N',
  },
  {
    name: '藏在 pipeline 的 Default 块里（所有节点都会继承）',
    files: { 'pipeline/a.json': '{ "Default": { "action": "Command", "exec": "cmd" } }' },
    expectHit: true,
    contains: 'Default 块',
  },
  {
    name: '藏在 default_pipeline.json 的 Default 块里',
    files: {
      'pipeline/a.json': '{ "N": { "recognition": "OCR" } }',
      'default_pipeline.json': '{ "Default": { "action": "Command" } }',
    },
    expectHit: true,
    contains: 'default_pipeline.json',
  },
  {
    name: '带注释的 .jsonc 里藏 Command（宽容解析不能变成漏检）',
    files: { 'pipeline/a.jsonc': '{ // 注释\n "N": { "action": "Command", }, }' },
    expectHit: true,
    contains: '节点 N',
  },
  {
    name: 'default_pipeline 里给 Command 预设参数 —— 不执行任何东西，不该误伤',
    files: {
      'pipeline/a.json': '{ "N": { "recognition": "OCR" } }',
      'default_pipeline.json': '{ "Command": { "exec": "cmd" } }',
    },
    expectHit: false,
  },
  {
    name: '正常提交（就是仓库里的参照实现）',
    files: { 'pipeline/main.json': readFileSync(join(REPO_ROOT, 'systems/ref/main.json'), 'utf8') },
    expectHit: false,
  },
  {
    name: '任务显式放行 Command 时不拦',
    files: { 'pipeline/a.json': '{ "N": { "action": "Command" } }' },
    allowed: ['Command'],
    expectHit: false,
  },
  {
    name: '解析不了就不放行（扫不到动作 ≠ 没动作）',
    files: { 'pipeline/a.json': '{ "N": { "action": }' },
    expectHit: true,
    contains: '扫不到动作所以不放行',
  },
]

for (const c of scanCases) {
  const bundle = freshBundle(c.files)
  const problems = scanForbiddenActions(bundle, c.allowed ?? [])
  const hit = problems.length > 0
  const matched = !c.expectHit || c.contains === undefined || problems.some((p) => p.includes(c.contains!))
  check('白名单：' + c.name, hit === c.expectHit && matched, hit ? '拦下：' + problems[0] : '放行')
}

rmSync(dir, { recursive: true, force: true })
console.log(
  failures === 0
    ? '提交前置检查自检通过（解析 ' + parseCases.length + ' 例 + 白名单 ' + scanCases.length + ' 例）'
    : '提交前置检查自检失败 ' + failures + ' 例',
)
process.exitCode = failures === 0 ? 0 : 1
