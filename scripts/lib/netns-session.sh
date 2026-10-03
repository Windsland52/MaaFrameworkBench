#!/usr/bin/env bash
# netns 内 DSH 整体验收的机制侧：起环境、注入 key、跑会话、收证据、拆环境。
# 只产出事实（stdout 标记行），断言由调用方（check-egress-netns.ts）做。
#
# 输出标记：
#   KV|<key>=<value>          事实键值
#   UP|<ndjson>               模拟上游收到的每个请求（一行一个）
set -euo pipefail

RUN=$1 # /tmp 下的运行目录（root 建）
ID=$2
HOST_IP=10.212.61.1
NS_IP=10.212.61.2
PROXY_PORT=8787
UP_PORT=8788
NS="bench-$ID"

kv() { echo "KV|$1=$2"; }

teardown() {
  bash "$RUN/stage/egress-netns.sh" "$ID" destroy >/dev/null 2>&1 || true
  [ -n "${PROXY_PID:-}" ] && kill "$PROXY_PID" 2>/dev/null || true
  [ -n "${UP_PID:-}" ] && kill "$UP_PID" 2>/dev/null || true
  rm -rf "$RUN" # 含 creds.env：销毁即清临时凭据
}
trap teardown EXIT

# 隔离 ns 内的非特权执行：setpriv 降权 + env -i 白名单（只给 PATH/HOME/DSH_HOME）
run_ns() {
  ip netns exec "$NS" setpriv --reuid=1000 --regid=1000 --clear-groups \
    env -i PATH=/usr/local/bin:/usr/bin:/bin HOME="$RUN/home" DSH_HOME="$RUN/dsh-home" "$@"
}

# ---------- 1. 环境 ----------
bash "$RUN/stage/egress-netns.sh" "$ID" create "$HOST_IP" "$NS_IP" "$PROXY_PORT"

# ---------- 2. key 注入前：基础包不含 key ----------
KEY="synthetic-netns-$(date +%s)-$RANDOM"
if grep -R -F "$KEY" "$RUN/stage" >/dev/null 2>&1; then kv key_in_base yes; else kv key_in_base no; fi

# ---------- 3. 默认 ns：模拟上游 + 代理（挂 veth 宿主端 IP） ----------
node "$RUN/stage/mock-upstream.mjs" >"$RUN/upstream.ndjson" 2>&1 & UP_PID=$!
node "$RUN/stage/proxy-run.mjs" "$RUN/proxy.json" >/dev/null 2>&1 & PROXY_PID=$!
for _ in $(seq 1 50); do [ -s "$RUN/proxy.json" ] && break; sleep 0.2; done
[ -s "$RUN/proxy.json" ] || { echo "代理没起来" >&2; exit 1; }
TOKEN=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).token)' "$RUN/proxy.json")

# ---------- 4. 环境创建后注入 key（不进基础包，不进归档） ----------
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

# ---------- 5. ns 内非特权 DSH（全新 DSH_HOME，环境变量白名单） ----------
set +e
run_ns bash -c '
  cd "$4" || exit 97
  set -a; . "$1"; set +a
  exec dsh --patch "$2" --profile headless --json - <"$3"
' _ "$RUN/creds.env" "$RUN/artifacts/dsh-patch.yml" "$RUN/stage/prompt.txt" "$WS" \
  >"$RUN/artifacts/dsh-events.jsonl" 2>"$RUN/artifacts/dsh-stderr.log"
DSH_EXIT=$?
set -e
kv dsh_exit "$DSH_EXIT"

# ---------- 6. 负向探测（ns 内、非特权；set -e 不吃失败） ----------
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

# ---------- 7. 归档与证据 ----------
if grep -R -F "$KEY" "$RUN/artifacts" >/dev/null 2>&1; then kv key_in_artifacts yes; else kv key_in_artifacts no; fi
# 兜底：未结构化的日志行也可能藏 token —— 原文 grep 一遍
if grep -F "$TOKEN" "$RUN/upstream.ndjson" >/dev/null 2>&1; then kv upstream_token_leak yes; else kv upstream_token_leak no; fi
grep -q '"type":"final"' "$RUN/artifacts/dsh-events.jsonl" && kv final_present yes || kv final_present no
grep -q '"kind":"completed"' "$RUN/artifacts/dsh-events.jsonl" && kv turn_completed yes || kv turn_completed no
while IFS= read -r line; do echo "UP|$line"; done <"$RUN/upstream.ndjson"
kv key "$KEY"

# teardown（EXIT trap）销毁 netns、杀进程、删运行目录（含 creds.env）
