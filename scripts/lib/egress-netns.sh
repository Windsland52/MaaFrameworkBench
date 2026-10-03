#!/usr/bin/env bash
# netns 生命周期：创建 / 销毁。只操作以 run-id 命名的资源；create 失败即回滚同套资源。
#
# 拓扑：隔离 ns 内只有一条 veth（ns 端），默认路由指向宿主端 —— 不开 IP 转发，
# 出网只有宿主端上的代理端口。两层限制：ns 侧 OUTPUT（fail fast，REJECT）与
# 宿主端 INPUT（DROP），规则都挂在以 run-id 命名的链上，销毁时按名精确拆除。
set -euo pipefail

usage() { echo "用法: $0 <run-id> <create|destroy> [host-ip ns-ip port]" >&2; exit 2; }
[ $# -ge 2 ] || usage
ID=$1
CMD=$2
NS="bench-$ID"
VH="vh-$ID" # Linux 网卡名上限 15 字符，run-id 保持短
VN="vn-$ID"
CHAIN="BENCH-$ID"

destroy() {
  ip netns del "$NS" 2>/dev/null || true
  ip link del "$VH" 2>/dev/null || true
  iptables -D INPUT -i "$VH" -j "$CHAIN" 2>/dev/null || true
  iptables -F "$CHAIN" 2>/dev/null || true
  iptables -X "$CHAIN" 2>/dev/null || true
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
  destroy # 同名残留只可能是本 run-id 的，先清再建
  trap destroy ERR
  ip netns add "$NS"
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
  # 宿主端：veth 上只收 ns 发往代理端口的包，其余 DROP
  iptables -N "$CHAIN"
  iptables -A "$CHAIN" -s "$NS_IP/32" -d "$HOST_IP/32" -p tcp --dport "$PORT" -j ACCEPT
  iptables -A "$CHAIN" -j DROP
  iptables -I INPUT -i "$VH" -j "$CHAIN"
  trap - ERR
  exit 0
  ;;
*)
  usage
  ;;
esac
