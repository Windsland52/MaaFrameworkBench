#!/usr/bin/env bash
# netns 内 DSH 整体验收的机制侧：起环境、注入 key、跑会话、收证据、拆环境。
# 只产出事实（stdout 标记行），断言由调用方（check-egress-netns.ts）做 —— 包括本脚本的退出码。
#
# 第三参数 fault=hang：不跑 DSH，改在 ns 里放一个脱离会话的挂起进程后立即收尾，
# 验证销毁路径能终止持有命名空间的进程（删名字不会杀它们）。
#
# 输出标记：
#   KV|<key>=<value>          事实键值
#   UP|<ndjson>               模拟上游收到的每个请求（一行一个）
set -euo pipefail

RUN=$1 # /tmp 下的运行目录（root 建）
ID=$2
MODE=${3:-main}
HOST_IP=10.212.61.1
NS_IP=10.212.61.2
PROXY_PORT=8787
UP_PORT=8788
NS="bench-$ID"
SESSION_TIMEOUT=${BENCH_SESSION_TIMEOUT:-180}

kv() { echo "KV|$1=$2"; }

# 有界停一个本次启动的进程：TERM → 等 → KILL；销毁不能被挂住的子进程拖死
stop_pid() {
  local pid=${1:-}
  [ -n "$pid" ] || return 0
  kill "$pid" 2>/dev/null || return 0
  local i
  for i in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$pid" 2>/dev/null || return 0; sleep 0.2; done
  kill -9 "$pid" 2>/dev/null || true
}

teardown() {
  stop_pid "${PROXY_PID:-}"
  stop_pid "${UP_PID:-}"
  bash "$RUN/stage/egress-netns.sh" "$ID" destroy >/dev/null 2>&1 || true
  rm -rf "$RUN" # 含 creds.env：销毁即清临时凭据
}
trap teardown EXIT

# 隔离 ns 内的非特权执行：降权 + 禁再提权（非 root 不等于提不回 root）+ env -i 白名单。
# env -i 只证明不继承个人配置；文件是否可读仍由挂载与权限决定。
run_ns() {
  ip netns exec "$NS" setpriv --reuid=1000 --regid=1000 --clear-groups \
    --no-new-privs --bounding-set=-all \
    env -i PATH=/usr/local/bin:/usr/bin:/bin HOME="$RUN/home" DSH_HOME="$RUN/dsh-home" "$@"
}

# ---------- 1. 环境（同名冲突即拒） ----------
bash "$RUN/stage/egress-netns.sh" "$ID" create "$HOST_IP" "$NS_IP" "$PROXY_PORT"

# ---------- 2. key 注入前：基础包不含 key ----------
KEY="synthetic-netns-$(date +%s)-$RANDOM"
if grep -R -F "$KEY" "$RUN/stage" >/dev/null 2>&1; then kv key_in_base yes; else kv key_in_base no; fi

# ---------- 3. 降权与 IPv6 的事实 ----------
set +e
NNP=$(run_ns sh -c 'grep "^NoNewPrivs:" /proc/self/status' | awk '{print $2}')
BND=$(run_ns sh -c 'grep "^CapBnd:" /proc/self/status' | awk '{print $2}')
[ "$NNP" = "1" ] && kv no_new_privs yes || kv no_new_privs no
[ "$BND" = "0000000000000000" ] && kv capbnd_dropped yes || kv capbnd_dropped no
V6COUNT=$(ip -n "$NS" addr show "$VN" | grep -c inet6)
kv ns_ipv6_addrs "$V6COUNT"
HOST_LL=$(ip -6 addr show dev "vh-$ID" scope link 2>/dev/null | awk '/inet6/ {print $2}' | cut -d/ -f1 | head -1)
kv host_linklocal "${HOST_LL:-none}"
if [ "${HOST_LL:-}" != "" ]; then
  run_ns timeout 3 bash -c "exec 3<>/dev/tcp/$HOST_LL/$PROXY_PORT" >/dev/null 2>&1
  [ $? -eq 0 ] && kv v6_linklocal_direct yes || kv v6_linklocal_direct no
else
  kv v6_linklocal_direct untested
fi
set -e

if [ "$MODE" = "fault" ]; then
  # 故障路径：ns 里的挂起进程不是本会话的子进程 —— 销毁必须经 ip netns pids 终止它
  run_ns bash -c "exec -a benchfault-$ID sleep 300" &
  kv fault_spawned yes
  exit 0 # 走 EXIT trap 的 teardown
fi

# ---------- 4. 默认 ns：模拟上游 + 代理（挂 veth 宿主端 IP，固定端口） ----------
node "$RUN/stage/mock-upstream.mjs" >"$RUN/upstream.ndjson" 2>&1 & UP_PID=$!
node "$RUN/stage/proxy-run.mjs" "$RUN/proxy.json" >/dev/null 2>&1 & PROXY_PID=$!
for _ in $(seq 1 50); do [ -s "$RUN/proxy.json" ] && break; sleep 0.2; done
[ -s "$RUN/proxy.json" ] || { echo "代理没起来" >&2; exit 1; }
TOKEN=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).token)' "$RUN/proxy.json")

# ---------- 5. 环境创建后注入 key（不进基础包，不进归档） ----------
mkdir -p "$RUN/home/ws" "$RUN/artifacts" "$RUN/dsh-home"
chown -R 1000:1000 "$RUN/home" "$RUN/artifacts" "$RUN/dsh-home"
umask 177
printf 'BENCH_MOCK_KEY=%s\n' "$KEY" >"$RUN/creds.env"
umask 22
chown 1000:1000 "$RUN/creds.env"

WS="$RUN/home/ws"
cat >"$RUN/artifacts/dsh-patch.yml" <<EOF
- id: llm-pi-ai
  config:
    providers:
      bench-mock:
        api: openai-completions
        baseURL: "http://$HOST_IP:$PROXY_PORT/v1"
        apiKeyEnv: BENCH_MOCK_KEY
        headers:
          x-egress-token: "$TOKEN"
        models:
          - id: mock-model
            contextWindow: 8192
- id: agent-default-model
  config:
    provider: "bench-mock"
    model: "mock-model"
- id: sandbox-policy
  config:
    mode: "workspace-write"
    workspaceRoot: "$WS"
EOF
chown 1000:1000 "$RUN/artifacts/dsh-patch.yml"

# ---------- 6. ns 内非特权 DSH（全新 DSH_HOME，环境变量白名单，会话本身有界） ----------
set +e
run_ns timeout -k 5 "$SESSION_TIMEOUT" bash -c '
  cd "$4" || exit 97
  set -a; . "$1"; set +a
  exec dsh --patch "$2" --profile headless --json - <"$3"
' _ "$RUN/creds.env" "$RUN/artifacts/dsh-patch.yml" "$RUN/stage/prompt.txt" "$WS" \
  >"$RUN/artifacts/dsh-events.jsonl" 2>"$RUN/artifacts/dsh-stderr.log"
DSH_EXIT=$?
set -e
kv dsh_exit "$DSH_EXIT"

# ---------- 7. 负向探测（ns 内、非特权；set -e 不吃失败） ----------
set +e
probe() { run_ns timeout 4 bash -c "exec 3<>/dev/tcp/$1/$2" >/dev/null 2>&1; }
probe "$HOST_IP" "$PROXY_PORT"; [ $? -eq 0 ] && kv proxy_port_reachable yes || kv proxy_port_reachable no
probe "$HOST_IP" "$UP_PORT"; [ $? -eq 0 ] && kv upstream_port_direct yes || kv upstream_port_direct no
probe 1.1.1.1 443; [ $? -eq 0 ] && kv external_direct yes || kv external_direct no
http_code() {
  run_ns bash -c 'curl -s -o /dev/null -w "%{http_code}" --max-time 6 -X POST -H "x-egress-token: $2" "$1"' \
    _ "http://$HOST_IP:$PROXY_PORT$1" "$2" 2>/dev/null || echo err
}
kv route_wrong_token "$(http_code /v1/chat/completions wrong-token)"
kv route_unknown_path "$(http_code /x "$TOKEN")"
set -e

# ---------- 8. 归档与证据 ----------
if grep -R -F "$KEY" "$RUN/artifacts" >/dev/null 2>&1; then kv key_in_artifacts yes; else kv key_in_artifacts no; fi
# 兜底：未结构化的日志行也可能藏 token —— 原文 grep 一遍
if grep -F "$TOKEN" "$RUN/upstream.ndjson" >/dev/null 2>&1; then kv upstream_token_leak yes; else kv upstream_token_leak no; fi
grep -q '"type":"final"' "$RUN/artifacts/dsh-events.jsonl" && kv final_present yes || kv final_present no
grep -q '"kind":"completed"' "$RUN/artifacts/dsh-events.jsonl" && kv turn_completed yes || kv turn_completed no
while IFS= read -r line; do echo "UP|$line"; done <"$RUN/upstream.ndjson"
kv key "$KEY"

# teardown（EXIT trap）：有界停代理与上游 → destroy（含 ns 内进程的有界终止）→ 删运行目录
