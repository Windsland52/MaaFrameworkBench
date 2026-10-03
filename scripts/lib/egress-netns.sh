#!/usr/bin/env bash
# netns 生命周期：创建 / 销毁。
#
# 拓扑：隔离 ns 内只有一条 veth（ns 端），默认路由指向宿主端 —— 不开 IP 转发，
# 出网只有宿主端上的代理端口。限制三层：ns 侧 IPv4 OUTPUT（REJECT，fail fast）、
# 宿主端 IPv4 INPUT（DROP）、双侧 IPv6（ns 内与宿主端 veth 均禁用 IPv6，另挂
# v6 全丢链兜底）—— 链路本地面不存在，绕过面从源头消除。
#
# 所有权与并发：
#   - 同 ID 的 create/destroy 全程持有 /run/bench-egress/<id>.lock（flock）。
#     锁内查冲突、落 token 标记、操作资源 —— 并发同 ID 只有一个 create 成功，
#     失败方既不覆盖标记也动不了资源。锁文件不删（flock 按 inode，unlink 会破坏
#     互斥；/run 停机自清）。
#   - destroy 验证标记+token 后才动手；清理后**核验**资源与进程确已消失 —— 有残留
#     则保留标记并返回 6，调用方携同一 token 可重试；标记不在（他人资源/未创建）
#     一律跳过。清理凭所有权记录，不凭 ID。
set -euo pipefail

MARKDIR=/run/bench-egress

usage() { echo "用法: $0 <run-id> <create|destroy> <host-ip> <ns-ip> <port> <token>" >&2; exit 2; }
[ $# -ge 2 ] || usage
ID=$1
CMD=$2
NS="bench-$ID"
VH="vh-$ID" # Linux 网卡名上限 15 字符，run-id 保持短
VN="vn-$ID"
CHAIN="BENCH-$ID"
MARKER="$MARKDIR/$ID.token"
LOCK="$MARKDIR/$ID.lock"

has_ns() { ip netns list | awk '{print $1}' | grep -Fxq "$NS"; }
has_veth() { ip link show "$VH" >/dev/null 2>&1; }
has_chain() { iptables -S "$CHAIN" >/dev/null 2>&1 || ip6tables -S "$CHAIN" >/dev/null 2>&1; }
has_marker() { [ -f "$MARKER" ]; }

conflict() { has_ns || has_veth || has_chain || has_marker; }

acquire_lock() {
  mkdir -p "$MARKDIR" # 锁文件也要落在这里；destroy 路径不会经过 create 的建目录
  exec 9>"$LOCK"
  if ! flock -x -w 60 9; then
    echo "同 ID 锁等待超时：$LOCK" >&2
    exit 7
  fi
}
release_lock() {
  flock -u 9 2>/dev/null || true
  exec 9>&- 2>/dev/null || true
}

# 标记在且 token 相符才动；缺标记（他人资源/未创建）跳过，token 不符拒绝。
# 进程退出即释放 flock（fd 关闭），exit 路径不需要显式放锁。
owned() {
  if ! has_marker; then
    echo "未持有 $ID（无所有权标记）：跳过清理" >&2
    return 1
  fi
  if [ "$(cat "$MARKER")" != "$TOKEN" ]; then
    echo "所有权凭据不符：拒绝清理 $ID" >&2
    exit 4
  fi
}

# 销毁主体：调用方持锁。清理后核验，有残留保留标记并返回 6（携同 token 可重试）。
destroy_body() {
  owned || return 0
  # 持有该命名空间的进程：TERM → 有界等待 → KILL；“列表无残留”必须意味着进程也没了
  if has_ns; then
    local pids
    pids=$(ip netns pids "$NS" 2>/dev/null || true)
    if [ -n "$pids" ]; then
      kill $pids 2>/dev/null || true
      local i
      for i in 1 2 3 4 5 6 7 8 9 10; do
        pids=$(ip netns pids "$NS" 2>/dev/null || true)
        [ -z "$pids" ] && break
        sleep 0.3
      done
      pids=$(ip netns pids "$NS" 2>/dev/null || true)
      [ -n "$pids" ] && kill -9 $pids 2>/dev/null || true
      sleep 0.2
    fi
  fi
  # 受控故障注入（测试钩子）：模拟“netns 删除失败”，验证失败留标记、重试可清理
  if [ "${BENCH_NETNS_FAULT:-}" != "keep-ns" ]; then
    ip netns del "$NS" 2>/dev/null || true
  fi
  ip link del "$VH" 2>/dev/null || true
  for ipt in iptables ip6tables; do
    $ipt -D INPUT -i "$VH" -j "$CHAIN" 2>/dev/null || true
    $ipt -F "$CHAIN" 2>/dev/null || true
    $ipt -X "$CHAIN" 2>/dev/null || true
  done
  # 核验：资源或进程仍在 → 保留标记，非零返回
  local residue=0
  if has_ns; then
    residue=1
    local more
    more=$(ip netns pids "$NS" 2>/dev/null || true)
    [ -n "$more" ] && residue=1
  fi
  has_veth && residue=1
  has_chain && residue=1
  if [ "$residue" = 1 ]; then
    echo "清理后仍有残留：保留所有权标记（$MARKER），携同一 token 可重试" >&2
    return 6
  fi
  rm -f "$MARKER"
  return 0
}

case $CMD in
destroy)
  [ $# -eq 3 ] || usage
  TOKEN=$3
  acquire_lock
  destroy_body
  rc=$?
  release_lock
  exit "$rc"
  ;;
create)
  [ $# -eq 6 ] || usage
  HOST_IP=$3
  NS_IP=$4
  PORT=$5
  TOKEN=$6
  acquire_lock
  if conflict; then
    echo "冲突：$NS / $VH / $CHAIN / 所有权标记 已存在 —— 同名不证明归本次所有，拒绝复用或覆盖" >&2
    release_lock
    exit 3
  fi
  mkdir -p "$MARKDIR"
  (umask 077 && printf '%s\n' "$TOKEN" >"$MARKER")
  # 回滚（仍在锁内）只清理已落标记的名字 —— 开工前已确认无冲突，途中这些名字下的资源必属本次
  trap 'destroy_body; release_lock' ERR
  ip netns add "$NS"
  # ns 内禁用 IPv6（all 管已有接口，default 管之后移入的 veth）：链路本地无从谈起；
  # 只动本命名空间，共享 IPv6 策略不碰
  ip netns exec "$NS" sysctl -q -w net.ipv6.conf.all.disable_ipv6=1
  ip netns exec "$NS" sysctl -q -w net.ipv6.conf.default.disable_ipv6=1
  ip link add "$VH" type veth peer name "$VN"
  ip link set "$VN" netns "$NS"
  ip addr add "$HOST_IP/24" dev "$VH"
  ip link set "$VH" up
  # 宿主端 veth 也禁用 IPv6（仅本接口，共享策略不碰）：链路本地地址在两端都不存在
  sysctl -q -w "net.ipv6.conf.$VH.disable_ipv6=1"
  ip -n "$NS" addr add "$NS_IP/24" dev "$VN"
  ip -n "$NS" link set "$VN" up
  ip -n "$NS" link set lo up
  ip -n "$NS" route add default via "$HOST_IP"
  # ns 侧：只放行 lo、到代理的连接与已建立连接的回包，其余 REJECT（不超时、立刻失败）
  ip netns exec "$NS" iptables -N "$CHAIN"
  ip netns exec "$NS" iptables -A "$CHAIN" -o lo -j ACCEPT
  ip netns exec "$NS" iptables -A "$CHAIN" -d "$HOST_IP" -p tcp --dport "$PORT" -j ACCEPT
  ip netns exec "$NS" iptables -A "$CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  ip netns exec "$NS" iptables -A "$CHAIN" -j REJECT
  ip netns exec "$NS" iptables -I OUTPUT -j "$CHAIN"
  # 宿主端：veth 上只收 ns 发往代理端口的包；IPv6 全丢（兜 ns 禁用之外的带外路径）
  iptables -N "$CHAIN"
  iptables -A "$CHAIN" -s "$NS_IP/32" -d "$HOST_IP/32" -p tcp --dport "$PORT" -j ACCEPT
  iptables -A "$CHAIN" -j DROP
  iptables -I INPUT -i "$VH" -j "$CHAIN"
  ip6tables -N "$CHAIN"
  ip6tables -A "$CHAIN" -j DROP
  ip6tables -I INPUT -i "$VH" -j "$CHAIN"
  trap - ERR
  release_lock
  exit 0
  ;;
*)
  usage
  ;;
esac
