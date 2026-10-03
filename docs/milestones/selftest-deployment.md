# 独立自测部署验证

## 分发包

```sh
node scripts/pack-selftest.ts <不存在的新目录>
```

脚本只复制三份入口源码和 `datasets.yaml` 声明的 OCR 文件，并写入固定到当前已安装 maa-node 版本的 `package.json`。
创建目标前逐文件校验 OCR SHA-256；缺失或哈希不符即拒绝，写入使用已校验的同一份字节，本地额外文件不入包。
目标已存在则拒绝；父目录须已存在。不复制仓库 `node_modules`、任务包、fixtures、用户配置或凭据。
这不是完整会话镜像：项目与设备连接参数由部署方另行提供，模型 key 在创建会话环境时配置，不能打进基础包。

在目标系统安装声明的 npm 依赖，再运行：

```sh
npm install
node selftest/entry.ts --project <项目目录> --entry <入口节点> --device <设备地址> --token <设备令牌> --ocr ./ocr
```

第一次安装生成的 lockfile 应随部署构建保留；当前打包脚本仅固定顶层依赖版本，不声称锁定完整传递依赖。

## 已验证组合（2026-10-03）

Windows 宿主设备服务 + WSL 2 中的 Ubuntu 24.04.5 x64，Node 24.18.0、maa-node 5.13.0。
Linux 环境使用独立 npm 安装，没有链接仓库的 node_modules。
干净 Ubuntu 首次加载失败，原因是缺少 `libatomic.so.1`；安装系统包 `libatomic1` 后可运行。
这不是其他 Linux 发行版、macOS 或所有原生库依赖均已验证的声明。

用 t001 正确夹具进行部署验收，真实 OCR 经 HTTP 读到 STOCK、INVENTORY、12，退出码 0、stderr 为空，
宿主侧核对设备到达 inventory。夹具仅是部署验收输入，不能放进正式 agent 会话包。

## WSL 文件隔离探针

仅在专用测试发行版的 `/etc/wsl.conf` 设置：

```ini
[boot]
systemd=true

[automount]
enabled=false
mountFsTab=false

[interop]
enabled=false
appendWindowsPath=false

[user]
default=runner
```

`runner` 是预先创建的非 root 用户。配置生效需要终止并重新启动该专用发行版，不能用全局 shutdown 干扰其他发行版。
关闭宿主挂载后，启动命令须显式指定 Linux 工作目录（`wsl --cd`），不能依赖继承的 Windows 仓库 cwd。

实测：默认 uid 为 1000，无 drvfs 宿主盘挂载，WSLInterop 未启用，原 `/mnt/c/.../tasks/.../task.yaml` 不可读；
同一环境仍可经 HTTP 完成上述真实自测。验收时，宿主将夹具 JSON 经 stdin 交给发行版中的 Python 写入测试项目，不依赖重新挂载宿主盘。
下面是同一传输机制的最小复现（宿主使用 Bash，发行版需有 Python 3；只用于部署验收，不用于正式模型会话）：

```sh
# 在仓库根目录运行；DISTRO 替换为专用发行版名。
DISTRO=your-test-distro
MSYS_NO_PATHCONV=1 wsl.exe -d "$DISTRO" -u runner --cd /home/runner --exec python3 -c '
import pathlib, sys
p = pathlib.Path("/home/runner/transport-probe.json")
with p.open("xb") as f:
    f.write(sys.stdin.buffer.read())
' < tasks/t001-enter-inventory/fixtures/correct.json
```

目标用独占创建模式，已存在则拒绝覆盖。模型 key 不通过这条文件传输示例写入。

**文件探针不是完整隔离证明。** 尚未验证所有提权、共享挂载与网络访问路径。

## 网络隔离联调（2026-10-03，探针未固化）

关键发现：**两个 WSL 发行版共享同一网络命名空间**，在专用发行版里改全局 OUTPUT 策略
会波及别的发行版 —— 因此改用独立 netns + veth（未启用共享 IP 转发），策略落在
拓扑上而不是可被 root 改写的规则上。

分两层验证，均用临时探针（尚未固化为仓库部署入口；测试后 netns/veth 已删、
共享防火墙与转发设置与测试前一致）：

- **netns 层**：非特权进程在 netns 内经代理可达唯一放行的测试端口；直连其他端口、
  Windows 网关、外部 IPv4/IPv6 全部失败；无权修改防火墙规则。
- **代理层**（`src/egress/main.ts`，`pnpm check:egress`）：固定路由、认证、
  4 MiB 体积上限、拒绝 CONNECT 与重定向。HTTPS 上游两模式验收
  （`scripts/check-egress-tls.ts`）：未信任自签证书 → 502 且上游零 HTTP 请求；
  显式信任（`NODE_EXTRA_CA_CERTS` 进程级注入，代理代码零改动）→ 200 且 SSE 完整。
  复现注意事项：证书 SAN 必须含 IP 条目（Node 对 IP 主机不走 CN 回退）；
  Git Bash 下 `openssl -subj` 需 `MSYS_NO_PATHCONV=1`。

**DSH 兼容性（本机，模拟上游 + 合成 key）**：DSH 的 provider 配置原生支持
`baseURL` + `headers` + `apiKeyEnv`（`llm-pi-ai` 条目的 `providers` patch），
代理形态零改动。实测一轮 headless：路径精确命中 `/v1/chat/completions`，
上游收到 `authorization: Bearer <合成 key>` 而 `x-egress-token` 为 null
（代理 token 只到代理），SSE 流式完整往返，`turn_end: completed`。
会话共发 2 个请求，其一为**辅助请求，来源未确认**。

## netns 内整体验收（2026-10-03，已固化）

`pnpm` 外独立命令：`node scripts/check-egress-netns.ts <发行版名>`（驱动断言侧）+
`scripts/lib/`（`egress-netns.sh` 生命周期、`netns-session.sh` 机制编排、模拟上游
与代理启动件）。生命周期：创建（ns + veth + 双侧规则，失败即回滚同套资源）、
非特权执行（setpriv 降权 + `env -i` 白名单）、销毁（按 run-id 精确拆除，netns /
iptables 链 / 运行目录含临时凭据一并清理）。代理新增 `port` 绑定选项 —— netns
防火墙按已知端口放行，动态端口不可用。

实测断言全过（main 成功 + fault 故障 + conflict 冲突 + race 并发 + faildel
失败保标记五轮）：ns 内非特权 DSH（全新
`DSH_HOME`、环境变量白名单、会话有界）完成会话（exit 0、final、`turn_end:
completed`）；模拟上游只收到 2 个预期请求（固定路径、`Bearer <合成 key>`、无代理
token，原文兜底 grep 亦无；其一为辅助请求，来源未确认）；ns 内可到代理端口、
直连上游端口与外网均被拒；错 token 401、未知路由 403；key 注入前基础包不含、
归档产物不含、销毁后凭据文件清理；netns / v4+v6 链 / 目录无残留。

隔离与清理的硬化（前两版固化脚本漏掉、复审后补上）：

- **IPv6**：ns 内禁用（`disable_ipv6` all+default）、**宿主端 veth 同样禁用**（仅本
  接口，共享策略不碰）—— 两端零 inet6 地址由断言锁定，链路本地面不存在，绕过面
  从源头消除；宿主端 veth 另挂 v6 全丢链兜底。实测注意：主流客户端（curl 的
  URL zone、node 裸 host 带 zone、ping 的 `%iface`）对链路本地 scope 的支持均不可
  靠，"探测被过滤"路线走不通，故选消除而非过滤。
- **禁再提权**：降权为 `--reuid/--regid/--clear-groups --no-new-privs
--bounding-set=-all`，并断言实际生效（`NoNewPrivs=1`、`CapBnd` 全零）——
  非 root 不等于提不回 root。
- **所有权**：create 以调用方 token 在 `/run/bench-egress/<id>.token` 落标记
  （`/run` 与 netns 同寿命，停机同消）；destroy 只在标记存在且 token 相符时动手，
  缺标记一律跳过 —— **清理凭所有权记录，不凭 ID**（会话 trap 与驱动超时恢复都
  持同一 token）。同名 netns/veth/链/标记已存在即拒绝（exit 3），ERR 回滚只碰
  已落标记的名字。并发同 ID 的 create/destroy 全程持 `flock`（锁内查冲突、落
  标记、动资源；锁文件不删 —— flock 按 inode，unlink 会破坏互斥）；**清理后
  核验**资源与进程确已消失，有残留则保留标记并返回 6，携同一 token 可重试。
  三类负例实测：冲突（预置同名资源与进程，create 拒绝后两层清理均未碰它们）、
  并发（双 create 恰一个成功，失败方不覆盖标记；错 token 的 destroy 被拒
  exit 4）、受控删除失败（注入跳过 netns 删除 → exit 6 且标记保留 → 同 token
  重试清理成功）。
- **有界清理**：销毁先经 `ip netns pids` 有界终止（TERM→等→KILL）持有命名空间的
  进程 —— 删名字不会杀它们；故障路径实测：ns 里脱离会话的挂起进程（**就绪握手
  确认其已在命名空间内并存活**后才收尾）被销毁终止。DSH 会话与驱动的每次 `wsl`
  调用都有总超时；机制脚本的**退出码本身是断言对象**（conflict 轮期望 3）。
- 证据边界：全新 `DSH_HOME` 与 `env -i` 只证明**不继承**个人配置，不证明个人配置
  "结构上不可达"——文件是否可读仍由挂载与权限决定。

复现注意事项（实测踩过）：发行版 `/tmp` 随 WSL 停机清空，验收件传输与执行须在
同一命令窗口内连续完成；`wsl.exe` 对 `bash -c` 参数会做**二次 shell 解析**（`$变量`
被外层提前展开），跨边界脚本一律走 `--exec` 直通 + 事先落盘的脚本文件；
`pgrep -f` 的模式串会匹配 `sh -c` 包装进程自身，查进程用字符类（`[i]d` 形）避开，
"进程存在"的判定以**命名空间内 argv0** 为准；Ubuntu 的 `sh` 是 dash、没有
`exec -a`；后台进程要跨 `wsl` 会话存活须 `setsid` 脱离；veth 只 up 一端时
NO-CARRIER，IPv6 链路本地不会分配。

发行版内 dsh 为 0.2.0-rc.2（宿主 rc.1）—— 会话由镜像内的 dsh 跑，身份以它为准。
尚未完成：真实 provider 的短请求（另行授权后做）、正式会话生命周期。
当前环境仍不运行正式评测。

边界（截至本节）：netns 隔离与 key 注入机制均以合成 key 验收通过，但**正式会话
环境的完整装配（题面 + 种子 + 真实 key + 会话生命周期）尚未建**，发行版常驻环境
仍无出站限制；真实 provider 的短请求须另行授权后再做。此前不运行正式评测。
