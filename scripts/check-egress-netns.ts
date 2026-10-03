import { spawn } from 'node:child_process'
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * netns 内 DSH 整体验收的驱动侧：把验收件打进发行版（automount 关闭，走 stdin tar）、
 * 执行机制脚本、对 stdout 标记行与**脚本退出码**做断言。机制与断言分离 —— 脚本只报
 * 事实，这里只判。
 *
 * 用法: node scripts/check-egress-netns.ts <WSL 发行版名>
 * 前提：发行版内有 node ≥24 与全局 dsh；runner 用户 uid 1000。
 *
 * 两轮验收：
 *   main  —— 成功路径：会话完成、上游只收预期请求、直连/链路本地/未授权路由拒绝、
 *            降权生效（NoNewPrivs、CapBnd 清零）、key 注入生命周期、无残留
 *   fault —— 故障路径：ns 里放一个脱离会话的挂起进程，销毁必须终止它
 *            （删 netns 名字不会杀持有它的进程）
 */

const DISTRO = process.argv[2] ?? ''
if (DISTRO === '') throw new Error('用法: node scripts/check-egress-netns.ts <WSL 发行版名>')

const failures: string[] = []
const check = (ok: boolean, name: string, detail = ''): void => {
  if (!ok) failures.push(name)
  console.log((ok ? 'OK  ' : 'FAIL') + ' | ' + name + (detail === '' ? '' : ' | ' + detail))
}

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function wsl(args: string[], timeoutMs = 120_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const child = spawn('wsl.exe', ['-d', DISTRO, ...args], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()))
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()))
    // 总超时：挂住的调用不能挡住 finally 里的销毁；本地杀 wsl.exe，发行版侧交给 destroy
    const timer = setTimeout(() => {
      if (child.pid !== undefined) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      done({ code: null, stdout, stderr: stderr + '\n[wsl 调用超时 ' + timeoutMs + 'ms]' })
    }, timeoutMs)
    child.on('error', (err) => {
      clearTimeout(timer)
      done({ code: null, stdout, stderr: stderr + String(err) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      done({ code, stdout, stderr })
    })
  })
}

async function runOnce(mode: 'main' | 'fault'): Promise<void> {
  const label = mode === 'fault' ? '[故障] ' : ''
  const ID = randomBytes(3).toString('hex')
  const RUN = '/tmp/bench-netns-' + ID

  const stage = mkdtempSync(join(tmpdir(), 'netns-stage-'))
  try {
    // 分发包组装：入口源码 + 生命周期/编排脚本 + 模拟件
    cpSync(join(REPO, 'scripts/lib/egress-netns.sh'), join(stage, 'egress-netns.sh'))
    cpSync(join(REPO, 'scripts/lib/netns-session.sh'), join(stage, 'netns-session.sh'))
    cpSync(join(REPO, 'scripts/lib/netns-mock-upstream.mjs'), join(stage, 'mock-upstream.mjs'))
    cpSync(join(REPO, 'scripts/lib/netns-proxy-run.mjs'), join(stage, 'proxy-run.mjs'))
    writeFileSync(join(stage, 'prompt.txt'), '只回复四个字：链路已通。不要使用任何工具。\n')
    const egressDir = join(stage, 'egress')
    cpSync(join(REPO, 'src/egress/main.ts'), join(egressDir, 'main.ts'))

    await wsl(['-u', 'root', '--exec', 'rm', '-rf', RUN])
    await wsl(['-u', 'root', '--exec', 'mkdir', '-p', RUN + '/stage/egress'])
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
    check(transfer.code === 0, label + '验收件已打入发行版（stdin tar）', 'tar 退出码=' + String(transfer.code))
    // 工作区若是 CRLF 检出，bash 会嚼不动 —— 统一转 LF
    await wsl(['-u', 'root', '--exec', 'sh', '-c', `sed -i 's/\\r$//' ${RUN}/stage/*.sh`])

    // 机制脚本：退出码本身就是断言对象，不能只看中途标记
    const session = await wsl(['-u', 'root', '--exec', 'bash', RUN + '/stage/netns-session.sh', RUN, ID, mode], 420_000)
    check(session.code === 0, label + '机制脚本退出码 0', 'code=' + String(session.code))
    if (session.code !== 0 && session.stderr.trim() !== '') {
      console.log('       stderr 尾部: ' + session.stderr.trim().slice(-200))
    }

    const kv = new Map<string, string>()
    const upstreamLines: string[] = []
    for (const line of session.stdout.split('\n')) {
      if (line.startsWith('KV|')) {
        const rest = line.slice(3)
        kv.set(rest.slice(0, rest.indexOf('=')), rest.slice(rest.indexOf('=') + 1))
      } else if (line.startsWith('UP|')) upstreamLines.push(line.slice(3))
    }

    // 销毁后的复原断言（两种模式都查）
    const residue = await wsl([
      '-u',
      'root',
      '--exec',
      'sh',
      '-c',
      `ip netns list | grep -c bench-${ID}; [ -e ${RUN}/creds.env ] && echo creds || echo nocreds; iptables -S | grep -c BENCH-${ID}; ip6tables -S | grep -c BENCH-${ID}; pgrep -fc "benchfault-[${ID}]" || true`,
    ])
    const [nsCount, credsFlag, v4chain, v6chain, faultPids] = residue.stdout.split('\n').map((s) => s.trim())
    check(nsCount === '0', label + 'netns 已销毁', '残留=' + String(nsCount))
    check(credsFlag === 'nocreds', label + '销毁后临时凭据文件已清理', String(credsFlag))
    check(
      v4chain === '0' && v6chain === '0',
      label + 'v4/v6 iptables 链均已拆除',
      'v4=' + String(v4chain) + ' v6=' + String(v6chain),
    )

    if (mode === 'fault') {
      check(kv.get('fault_spawned') === 'yes', label + '挂起进程已在 ns 内放出（脱离会话）', '')
      check(faultPids === '0', label + '持有命名空间的挂起进程已被销毁终止', '残留进程=' + String(faultPids))
      return
    }

    /* ---------- main：成功路径断言 ---------- */

    check(
      kv.get('dsh_exit') === '0',
      'DSH 会话正常结束（ns 内、非特权、全新 DSH_HOME、有界）',
      'exit=' + String(kv.get('dsh_exit')),
    )
    check(
      kv.get('final_present') === 'yes' && kv.get('turn_completed') === 'yes',
      '会话完成（final + turn_end completed）',
      '',
    )

    // 降权与禁再提权实际生效，不只是设了参数
    check(
      kv.get('no_new_privs') === 'yes' && kv.get('capbnd_dropped') === 'yes',
      '降权生效（NoNewPrivs=1、能力集清零）',
      'nnp=' + String(kv.get('no_new_privs')) + ' bnd=' + String(kv.get('capbnd_dropped')),
    )

    // IPv6：ns 内无 v6 地址，宿主端链路本地也到不了
    check(
      kv.get('ns_ipv6_addrs') === '0',
      'ns 内网卡无 IPv6 地址（v6 已禁用）',
      'inet6 数=' + String(kv.get('ns_ipv6_addrs')),
    )
    check(
      kv.get('v6_linklocal_direct') === 'no',
      '经宿主端链路本地地址直连被拒',
      'LL=' + String(kv.get('host_linklocal')),
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
    check(kv.get('key_in_base') === 'no', 'key 注入前基础包不含它', '')
    check(kv.get('key_in_artifacts') === 'no', '归档产物（patch/事件/stderr）不含它', '')
  } finally {
    await wsl(['-u', 'root', '--exec', 'bash', RUN + '/stage/egress-netns.sh', ID, 'destroy']).catch(() => {})
    await wsl(['-u', 'root', '--exec', 'rm', '-rf', RUN]).catch(() => {})
    rmSync(stage, { recursive: true, force: true })
  }
}

await runOnce('main')
await runOnce('fault')

console.log(
  failures.length === 0
    ? 'netns 内 DSH 整体验收通过（含故障路径）'
    : 'netns 内 DSH 整体验收失败：' + failures.join('；'),
)
process.exitCode = failures.length === 0 ? 0 : 1
