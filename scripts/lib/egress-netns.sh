#!/usr/bin/env bash
# netns 生命周期：创建 / 销毁。
#
# 拓扑：隔离 ns 内只有一条 veth（ns 端），默认路由指向宿主端 —— 不开 IP 转发，
# 出网只有宿主端上的代理端口。限制三层：ns 侧 IPv4 OUTPUT（REJECT，fail fast）、
# 宿主端 IPv4 INPUT（DROP）、双侧 IPv6（ns 内禁用 IPv6；宿主端 veth 上 v6 全丢），
# 链路本地地址也绕不过“只到代理”。
#
# 创建规则：同名资源已存在即**拒绝**（同名不证明归本次所有）；ERR 回滚只碰
# 开工前确认不存在的名字 —— 途中挂在这些名字下的资源必属本次。
# 销毁规则：先有界终止仍持有该命名空间的进程（删名字不会杀它们），再拆链路。
set -euo pipefail

usage() { echo "用法: $0 <run-id> <create|destroy> [host-ip ns-ip port]" >&2; exit 2; }
[ $# -ge 2 ] || usage
ID=$1
CMD=$2
NS="bench-$ID"
VH="vh-$ID" # Linux 网卡名上限 15 字符，run-id 保持短
VN="vn-$ID"
CHAIN="BENCH-$ID"

has_ns() { ip netns list | awk '{print $1}' | grep -Fxq "$NS"; }
has_veth() { ip link show "$VH" >/dev/null 2>&1; }
has_chain() { iptables -S "$CHAIN" >/dev/null 2>&1 || ip6tables -S "$CHAIN" >/dev/null 2>&1; }

conflict() { has_ns || has_veth || has_chain; }

destroy() {
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
  ip netns del "$NS" 2>/dev/null || true
  ip link del "$VH" 2>/dev/null || true
  for ipt in iptables ip6tables; do
    $ipt -D INPUT -i "$VH" -j "$CHAIN" 2>/dev/null || true
    $ipt -F "$CHAIN" 2>/dev/null || true
    $ipt -X "$CHAIN" 2>/dev/null || true
  done
}

case $CMD in
destroy)
  destroy
  exit 0
  ;;
create)
  [ $# -eq 5 ] || usage
  HOST_IP=$3
  NS_IP=$4
  PORT=$5
  if conflict; then
    echo "冲突：$NS / $VH / $CHAIN 已存在 —— 同名不证明归本次所有，拒绝复用或覆盖" >&2
    exit 3
  fi
  trap destroy ERR
  ip netns add "$NS"
  # ns 内禁用 IPv6（all 管已有接口，default 管之后移入的 veth）：链路本地无从谈起；
  # 只动本命名空间，共享 IPv6 策略不碰
  ip netns exec "$NS" sysctl -q -w net.ipv6.conf.all.disable_ipv6=1
  ip netns exec "$NS" sysctl -q -w net.ipv6.conf.default.disable_ipv6=1
  ip link add "$VH" type veth peer name "$VN"
  ip link set "$VN" netns "$NS"
  ip addr add "$HOST_IP/24" dev "$VH"
  ip link set "$VH" up
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
  exit 0
  ;;
*)
  usage
  ;;
esac
