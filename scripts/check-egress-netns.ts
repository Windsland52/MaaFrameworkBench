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
 * 三轮验收（每轮独立 run-id 与所有权 token；清理凭 /run 下的标记 + token，不凭 ID）：
 *   main     —— 成功路径：会话完成、上游只收预期请求、直连/未授权路由拒绝、
 *               降权生效、key 注入生命周期、无残留
 *   fault    —— 故障路径：ns 里放一个脱离会话的挂起进程（就绪握手后收尾），
 *               销毁必须终止持有命名空间的进程
 *   conflict —— 预置同名资源与进程：create 必须拒绝（exit 3），且拒绝后的清理
 *               （会话 trap 与驱动 finally）都不得动它们 —— 事后原资源原进程仍在
 *   race     —— 并发同 ID 双 create（不同 token）：恰一个成功；失败方不覆盖标记、
 *               不破坏成功方资源；错 token 的 destroy 被拒（exit 4）
 *   faildel  —— 受控删除失败（注入跳过 netns 删除）：destroy 返回 6 且保留所有权
 *               标记；携同一 token 重试可完成清理
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

async function runOnce(mode: 'main' | 'fault' | 'conflict' | 'race' | 'faildel'): Promise<void> {
  const label =
    mode === 'fault'
      ? '[故障] '
      : mode === 'conflict'
        ? '[冲突] '
        : mode === 'race'
          ? '[并发] '
          : mode === 'faildel'
            ? '[失败保标记] '
            : ''
  const ID = randomBytes(3).toString('hex')
  const TOKEN = randomBytes(16).toString('hex')
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

    // race / faildel 直达生命周期脚本（被测单元是所有权生命周期本身，无需起会话）
    if (mode === 'race' || mode === 'faildel') {
      const TOKEN_B = randomBytes(16).toString('hex')
      if (mode === 'race') {
        const r = await wsl([
          '-u',
          'root',
          '--exec',
          'sh',
          '-c',
          `bash ${RUN}/stage/egress-netns.sh ${ID} create 10.212.61.1 10.212.61.2 8787 ${TOKEN} & p1=$!; ` +
            `bash ${RUN}/stage/egress-netns.sh ${ID} create 10.212.61.1 10.212.61.2 8787 ${TOKEN_B} & p2=$!; ` +
            `wait $p1; r1=$?; wait $p2; r2=$?; echo "r1=$r1 r2=$r2"; cat /run/bench-egress/${ID}.token`,
        ])
        const m = r.stdout.match(/r1=(\d+) r2=(\d+)\s*\n([0-9a-f]+)/)
        const r1 = m?.[1] ?? '?'
        const r2 = m?.[2] ?? '?'
        const marker = m?.[3] ?? ''
        check(
          (r1 === '0' && r2 === '3') || (r1 === '3' && r2 === '0'),
          '[并发] 同 ID 双 create 恰有一个成功',
          'r1=' + r1 + ' r2=' + r2,
        )
        const winner = r1 === '0' ? TOKEN : r2 === '0' ? TOKEN_B : ''
        check(marker === winner, '[并发] 所有权标记归成功方（失败方未覆盖）', marker.slice(0, 8) + '…')
        const wrong = await wsl([
          '-u',
          'root',
          '--exec',
          'bash',
          RUN + '/stage/egress-netns.sh',
          ID,
          'destroy',
          'deadbeef',
        ])
        check(wrong.code === 4, '[并发] 错 token 的 destroy 被拒（exit 4）', 'code=' + String(wrong.code))
        const win = await wsl(['-u', 'root', '--exec', 'bash', RUN + '/stage/egress-netns.sh', ID, 'destroy', winner])
        check(win.code === 0, '[并发] 胜者 token 清理成功', 'code=' + String(win.code))
      } else {
        const created = await wsl([
          '-u',
          'root',
          '--exec',
          'bash',
          RUN + '/stage/egress-netns.sh',
          ID,
          'create',
          '10.212.61.1',
          '10.212.61.2',
          '8787',
          TOKEN,
        ])
        check(created.code === 0, '[失败保标记] 环境已创建', 'code=' + String(created.code))
        const failed = await wsl([
          '-u',
          'root',
          '--exec',
          'env',
          'BENCH_NETNS_FAULT=keep-ns',
          'bash',
          RUN + '/stage/egress-netns.sh',
          ID,
          'destroy',
          TOKEN,
        ])
        check(failed.code === 6, '[失败保标记] 清理失败返回 6', 'code=' + String(failed.code))
        const kept = await wsl([
          '-u',
          'root',
          '--exec',
          'sh',
          '-c',
          `ip netns list | grep -c bench-${ID}; [ -f /run/bench-egress/${ID}.token ] && echo marker || echo nomarker`,
        ])
        const [nsLeft, markerLeft] = kept.stdout.split('\n').map((s) => s.trim())
        check(
          nsLeft === '1' && markerLeft === 'marker',
          '[失败保标记] 标记与资源都保留（可重试）',
          'ns=' + String(nsLeft) + ' marker=' + String(markerLeft),
        )
        const retry = await wsl(['-u', 'root', '--exec', 'bash', RUN + '/stage/egress-netns.sh', ID, 'destroy', TOKEN])
        check(retry.code === 0, '[失败保标记] 同一 token 重试清理成功', 'code=' + String(retry.code))
        const gone = await wsl([
          '-u',
          'root',
          '--exec',
          'sh',
          '-c',
          `ip netns list | grep -c bench-${ID}; [ -f /run/bench-egress/${ID}.token ] && echo marker || echo nomarker`,
        ])
        const [nsGone, markerGone] = gone.stdout.split('\n').map((s) => s.trim())
        check(
          nsGone === '0' && markerGone === 'nomarker',
          '[失败保标记] 重试后资源与标记均清除',
          'ns=' + String(nsGone) + ' marker=' + String(markerGone),
        )
      }
      return
    }

    if (mode === 'conflict') {
      // 预置同名资源：netns + 其中的一个进程（setsid 脱离 wsl 会话、bash 的 exec -a）——
      // 外部所有者，无所有权标记。就绪以“命名空间内进程 argv0”核验，不凭 pgrep 子串
      //（外层 sh 的命令行含同样文字，会自匹配出假阳性）
      const plant = await wsl([
        '-u',
        'root',
        '--exec',
        'sh',
        '-c',
        `ip netns add bench-${ID} && ip netns exec bench-${ID} setsid bash -c 'exec -a benchpre-${ID} sleep 300' </dev/null >/dev/null 2>&1 & for i in 1 2 3 4 5 6 7 8 9 10; do for p in $(ip netns pids bench-${ID} 2>/dev/null); do tr '\\0' '\\n' </proc/$p/cmdline 2>/dev/null | head -1 | grep -Fxq benchpre-${ID} && echo planted && exit 0; done; sleep 0.2; done; echo notplanted`,
      ])
      check(
        plant.stdout.trim().endsWith('planted'),
        label + '同名资源与进程已预置（ns 内 argv0 就绪）',
        plant.stdout.trim(),
      )
    }

    // 机制脚本：退出码本身就是断言对象（conflict 期望拒绝码 3，其余期望 0）
    const session = await wsl(
      [
        '-u',
        'root',
        '--exec',
        'bash',
        RUN + '/stage/netns-session.sh',
        RUN,
        ID,
        mode === 'main' ? 'main' : mode,
        TOKEN,
      ],
      420_000,
    )
    const wantCode = mode === 'conflict' ? 3 : 0
    check(session.code === wantCode, label + '机制脚本退出码 ' + wantCode, 'code=' + String(session.code))
    if (session.code !== wantCode && session.stderr.trim() !== '') {
      console.log('       stderr 尾部: ' + session.stderr.trim().slice(-160))
    }

    const kv = new Map<string, string>()
    for (const line of session.stdout.split('\n')) {
      if (line.startsWith('KV|')) {
        const rest = line.slice(3)
        kv.set(rest.slice(0, rest.indexOf('=')), rest.slice(rest.indexOf('=') + 1))
      }
    }

    if (mode === 'conflict') {
      // 拒绝之后：原资源与原进程必须原样保留（会话 trap 与本驱动 finally 都不得动它们）
      const after = await wsl([
        '-u',
        'root',
        '--exec',
        'sh',
        '-c',
        `ip netns list | grep -c bench-${ID}; pgrep -fc "benchpre-[${ID}]" || true`,
      ])
      const [nsCount, prePids] = after.stdout.split('\n').map((s) => s.trim())
      check(nsCount === '1', label + '拒绝后原 netns 仍在（未被清理碰掉）', '数量=' + String(nsCount))
      check(prePids === '1', label + '拒绝后原进程仍存活', '数量=' + String(prePids))
      // 预置资源由本驱动有意收走（不是按 ID 误伤，是它自己种下的）
      await wsl(['-u', 'root', '--exec', 'sh', '-c', `pkill -f "benchpre-[${ID}]"; ip netns del bench-${ID}`])
      const gone = await wsl(['-u', 'root', '--exec', 'sh', '-c', `ip netns list | grep -c bench-${ID} || true`])
      check(gone.stdout.trim() === '0', label + '预置资源已由驱动有意回收', '')
      return
    }

    const upstreamLines: string[] = []
    for (const line of session.stdout.split('\n')) {
      if (line.startsWith('UP|')) upstreamLines.push(line.slice(3))
    }

    // 销毁后的复原断言（main 与 fault 都查；conflict 上面单独查）
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
      check(kv.get('fault_ready') === 'yes', label + '挂起进程已确认进入命名空间并存活（就绪握手）', '')
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

    // IPv6：两端查询均有效且零地址 —— 链路本地面不存在，绕过面从源头消除
    //（宿主端 veth 同样禁用 v6；对照探针的需求因地址不存在而消失）
    check(
      kv.get('ns_ipv6_query') === 'ok' && kv.get('ns_ipv6_addrs') === '0',
      'ns 内网卡无 IPv6 地址（查询有效，计数为零）',
      'query=' + String(kv.get('ns_ipv6_query')) + ' inet6=' + String(kv.get('ns_ipv6_addrs')),
    )
    check(
      kv.get('host_v6_query') === 'ok' && kv.get('host_v6_addrs') === '0',
      '宿主端 veth 无 IPv6 地址（链路本地面不存在）',
      'query=' + String(kv.get('host_v6_query')) + ' inet6=' + String(kv.get('host_v6_addrs')),
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
    // 所有权 token 在手：正常/超时恢复都只清理本次创建的资源；标记不在则脚本自跳过
    await wsl([
      '-u',
      'root',
      '--exec',
      'sh',
      '-c',
      `[ -f ${RUN}/stage/egress-netns.sh ] && bash ${RUN}/stage/egress-netns.sh ${ID} destroy ${TOKEN} || true`,
    ]).catch(() => {})
    await wsl(['-u', 'root', '--exec', 'rm', '-rf', RUN]).catch(() => {})
    rmSync(stage, { recursive: true, force: true })
  }
}

await runOnce('main')
await runOnce('fault')
await runOnce('conflict')
await runOnce('race')
await runOnce('faildel')

console.log(
  failures.length === 0
    ? 'netns 内 DSH 整体验收通过（成功/故障/冲突/并发/失败保标记五路径）'
    : 'netns 内 DSH 整体验收失败：' + failures.join('；'),
)
process.exitCode = failures.length === 0 ? 0 : 1
