import { spawn } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * netns 内 DSH 整体验收的驱动侧：把验收件打进发行版（automount 关闭，走 stdin tar）、
 * 执行机制脚本、对 stdout 标记行做断言。机制与断言分离 —— 脚本只报事实，这里只判。
 *
 * 用法: node scripts/check-egress-netns.ts <WSL 发行版名>
 * 前提：发行版内有 node ≥24（node --version 可用）与全局 dsh；runner 用户 uid 1000。
 * 断言面：会话完成、上游只收到预期请求（合成 key、无代理 token）、直连与未授权
 * 路由拒绝、key 注入生命周期（基础包/归档不含、销毁清理）、netns 无残留。
 */

const DISTRO = process.argv[2] ?? ''
if (DISTRO === '') throw new Error('用法: node scripts/check-egress-netts.ts <WSL 发行版名>')

const failures: string[] = []
const check = (ok: boolean, name: string, detail = ''): void => {
  if (!ok) failures.push(name)
  console.log((ok ? 'OK  ' : 'FAIL') + ' | ' + name + (detail === '' ? '' : ' | ' + detail))
}

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ID = randomBytes(3).toString('hex')
const RUN = '/tmp/bench-netns-' + ID

function wsl(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const child = spawn('wsl.exe', ['-d', DISTRO, ...args], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()))
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()))
    child.on('error', (err) => done({ code: null, stdout, stderr: stderr + String(err) }))
    child.on('close', (code) => done({ code, stdout, stderr }))
  })
}

/* ---------- 组装分发包并打进发行版 ---------- */

const stage = mkdtempSync(join(tmpdir(), 'netns-stage-'))
try {
  mkdirSync(join(stage, 'egress'), { recursive: true })
  cpSync(join(REPO, 'src/egress/main.ts'), join(stage, 'egress/main.ts'))
  cpSync(join(REPO, 'scripts/lib/egress-netns.sh'), join(stage, 'egress-netns.sh'))
  cpSync(join(REPO, 'scripts/lib/netns-session.sh'), join(stage, 'netns-session.sh'))
  cpSync(join(REPO, 'scripts/lib/netns-mock-upstream.mjs'), join(stage, 'mock-upstream.mjs'))
  cpSync(join(REPO, 'scripts/lib/netns-proxy-run.mjs'), join(stage, 'proxy-run.mjs'))
  writeFileSync(join(stage, 'prompt.txt'), '只回复四个字：链路已通。不要使用任何工具。\n')

  await wsl(['-u', 'root', '--exec', 'rm', '-rf', RUN])
  await wsl(['-u', 'root', '--exec', 'mkdir', '-p', RUN + '/stage'])

  const transfer = await new Promise<{ code: number | null }>((done) => {
    const tar = spawn('tar', ['cf', '-', '-C', stage, '.'])
    const wslTar = spawn('wsl.exe', ['-d', DISTRO, '-u', 'root', '--exec', 'tar', 'xf', '-', '-C', RUN + '/stage'], {
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    tar.stdout.on('data', (c) => wslTar.stdin.write(c))
    tar.on('close', () => wslTar.stdin.end())
    wslTar.on('close', (code) => done({ code }))
    tar.on('error', () => done({ code: null }))
  })
  check(transfer.code === 0, '验收件已打入发行版（stdin tar）', 'tar 退出码=' + String(transfer.code))
  // 工作区若是 CRLF 检出，bash 会嚼不动 —— 统一转 LF
  await wsl(['-u', 'root', '--exec', 'sh', '-c', `sed -i 's/\\r$//' ${RUN}/stage/*.sh ${RUN}/stage/*.mjs`])

  /* ---------- 执行机制脚本 ---------- */

  const session = await wsl(['-u', 'root', '--exec', 'bash', RUN + '/stage/netns-session.sh', RUN, ID])
  const kv = new Map<string, string>()
  const upstreamLines: string[] = []
  for (const line of session.stdout.split('\n')) {
    if (line.startsWith('KV|')) {
      const rest = line.slice(3)
      kv.set(rest.slice(0, rest.indexOf('=')), rest.slice(rest.indexOf('=') + 1))
    } else if (line.startsWith('UP|')) upstreamLines.push(line.slice(3))
  }

  /* ---------- 断言 ---------- */

  check(
    kv.get('dsh_exit') === '0',
    'DSH 会话正常结束（ns 内、非特权、全新 DSH_HOME）',
    'exit=' + String(kv.get('dsh_exit')),
  )
  check(
    kv.get('final_present') === 'yes' && kv.get('turn_completed') === 'yes',
    '会话完成（final + turn_end completed）',
    '',
  )
  const requests = upstreamLines.flatMap((l) => {
    try {
      return [JSON.parse(l) as { url: unknown; auth: unknown; tok: unknown }]
    } catch {
      return []
    }
  })
  const key = kv.get('key') ?? ''
  const allMatch =
    requests.length > 0 &&
    requests.every(
      (r) =>
        (r.url === '/v1/chat/completions' || r.url === '/chat/completions') &&
        r.auth === 'Bearer ' + key &&
        r.tok === null,
    )
  check(allMatch, '上游只收到预期请求（路径固定、合成 key、无代理 token）', requests.length + ' 个请求')
  check(kv.get('upstream_token_leak') === 'no', '上游原文无代理 token（未结构化行兜底）', '')
  check(kv.get('proxy_port_reachable') === 'yes', 'ns 内非特权进程可到代理端口', '')
  check(
    kv.get('upstream_port_direct') === 'no' && kv.get('external_direct') === 'no',
    '直连上游端口与外网均被拒',
    'upstream=' + String(kv.get('upstream_port_direct')) + ' external=' + String(kv.get('external_direct')),
  )
  check(
    kv.get('route_wrong_token') === '401' && kv.get('route_unknown_path') === '403',
    '错 token 401、未知路由 403',
    kv.get('route_wrong_token') + '/' + kv.get('route_unknown_path'),
  )

  /* ---------- key 注入生命周期 ---------- */

  check(kv.get('key_in_base') === 'no', 'key 注入前基础包不含它', '')
  check(kv.get('key_in_artifacts') === 'no', '归档产物（patch/事件/stderr）不含它', '')

  /* ---------- 销毁清理 ---------- */

  const residue = await wsl([
    '-u',
    'root',
    '--exec',
    'sh',
    '-c',
    `ip netns list | grep -c bench-${ID}; [ -e ${RUN}/creds.env ] && echo creds || echo nocreds; iptables -S | grep -c BENCH-${ID} || true`,
  ])
  const [nsCount, credsFlag, chainCount] = residue.stdout.split('\n').map((s) => s.trim())
  check(nsCount === '0', 'netns 已销毁', '残留=' + String(nsCount))
  check(credsFlag === 'nocreds', '销毁后临时凭据文件已清理', String(credsFlag))
  check(chainCount === '0', 'iptables 链已拆（共享防火墙无本 run 残留）', '链残留=' + String(chainCount))
} finally {
  await wsl(['-u', 'root', '--exec', 'bash', RUN + '/stage/egress-netns.sh', ID, 'destroy']).catch(() => {})
  await wsl(['-u', 'root', '--exec', 'rm', '-rf', RUN]).catch(() => {})
  rmSync(stage, { recursive: true, force: true })
}

console.log(failures.length === 0 ? 'netns 内 DSH 整体验收通过' : 'netns 内 DSH 整体验收失败：' + failures.join('；'))
process.exitCode = failures.length === 0 ? 0 : 1
