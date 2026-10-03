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

**探针不是完整隔离证明。** 尚未验证所有提权、共享挂载与网络访问路径；出站网络未限制，公开仓库中的答案仍可能通过网络取得。
本轮没有注入模型 key 或启动模型会话，也没有导出可复用会话镜像。
模型 key 的创建时注入、网络策略与正式会话生命周期仍须独立实现和验收。
