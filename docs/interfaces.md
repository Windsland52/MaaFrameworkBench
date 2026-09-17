# 接口冻结 v1

> 日期：2026-09-15 · 状态：**冻结**（改动需显式记版本）
> v1.1（2026-09-16）：断言加 `reco_text`；`frames` 的屏序列、`ops.jsonl` 字段按实测补全
> 目的：让"重开会话"和"上团队"都成立 —— 后续所有工作只依赖本文 + `MaaFrameworkBench-设计定稿-2026-09-15.md`
> 已实测的实施事实见文末。

契约：**任务包 / run 产物 / 环境 / 判分器 / 数据集 / 子集**。

---

## 0. 总原则（四条，先于一切细节）

1. **判分只看 run 产物，不看过程对话。** 判分器是纯函数：`(run_dir, task.yaml) -> score.json`。
2. **只判首次提交。** 提交后立刻算 sha256，之后只针对那个 hash 判分。agent 提交后再改的一律不看。
3. **断言与环境状态不进 agent 工作区。** 任务包可以带，但 runner 只物化白名单里的部分。
4. **文档对「读者」成立，不对「写它的那次会话」成立。** 三种常见违反：

   | 违反                     | 表现                                               | 检查动作                                |
   | ------------------------ | -------------------------------------------------- | --------------------------------------- |
   | **写还不存在的东西**     | 描述未实现的接口、列未建的空目录                   | 问「仓库里有对应实现吗」→ 没有就挪进 §8 |
   | **引用读者拿不到的东西** | 指向本机路径、会话笔记、个人文件                   | 问「clone 下来能打开吗」                |
   | **把当下个例当通则**     | 那次的素材放法、那个 shell、那轮的临时约定写成规范 | 问「换个场景还成立吗」                  |

   > 这三条都在同一个仓库里被踩过，一共五次：把 `apps/<app>/` 写进 `frames/` 目录约定；
   > 用 `SimApp` / `LatencyModel` 冻结了还不存在的接口；集中一个「实施事实」附录当契约；
   > 把会话的 shell 写成仓库「环境」；引用只在写它那台机器上存在的 `notes/` 路径。
   > 共同点：**写的时候它们对「我」都成立，对「读的人」不成立** —— 而读的人包括以后重开会话的 AI。

---

## 1. 任务包

```
tasks/<task_id>/
  task.yaml            # 题面 + 覆盖声明 + 断言（held-out）
  seed/                # 种子项目：agent 要改的东西（CMP 形状）
    interface.json
    resource/base/pipeline/*.json
```

**画面是数据，声明不是副本。** `visible` 与 `env.screens` 只写帧的**名字**；
帧本身来自 `datasets.yaml` 的 images 包，落 `data/<id>/`。
所以任务包里没有图片文件 —— 主仓不放二进制（§5）。
`visible` 里的帧物化进工作区 `frames/`（相当于"你能看到的屏幕"），
其余帧（held-out 变体）只在环境进程里可达，绝不进工作区。

### task.yaml

```yaml
schema_version: 1
id: t001-enter-inventory
kind: fix                       # 任务形态：fix | extend | scratch（分组用）
covers: [2.1.4, 2.1.5, 4.2.1]   # 覆盖的最小可测项 —— 轴与维度由编号推出，不另设字段

env:
  type: frames                  # frames | web | replay
  dataset: maafw-demo-frames    # 引用 datasets.yaml 的 id
  dir: maafw-demo-frames        # 数据集目录名（相对 data_root）
  screens:                      # 画面序列；第一屏是初始画面
    - name: home                # 屏名，也是 env_state 断言能取的值
      path: home.png            # 数据集内的文件名
      transitions:              # 输入落进矩形就切屏；不声明则画面不变
        - area: [140, 300, 320, 140]
          target: inventory
    - name: inventory
      path: inventory.png
      transitions:
        - area: [1040, 480, 320, 140]
          target: home
    - name: inventory-zero      # held-out 变体：环境里可达，绝不物化进工作区
      path: inventory-zero.png
  # replay 用 recording 包；web 的配置字段等它落地再定

entry: Main.Start               # 跑哪个入口节点

prompt: |                       # 给 agent 看的题面
  从主页进入库存页，并确认库存数量。

budget:                         # 超限即 run 失败
  wall_ms: 120000
  max_screencaps: 200
  node_timeout_ms: 3000         # 每个节点的识别等待上限，起跑前注入成 Default.timeout

allow_actions: []               # 额外放行的动作；默认空 = 禁 Command（见 §7）

assert:                         # 判据（行为断言，held-out）
  - kind: env_state
    path: screen
    equals: inventory
  - kind: node_hit              # 只锚定题面写死的名字（见下）
    required: [Main.Start]
  - kind: reco_text             # 不写 node：任一节点读到过就算
    equals: "12"                # agent 答出的那个值
  - kind: op_count
    max_screencaps: 30          # 效率项（对应 4.2.1）

visible: [home.png]             # 物化进 agent 工作区 frames/ 的帧；其余帧只在环境里
```

**断言种类（v1.1 四种）**

| kind        | 判什么                                                                            |
| ----------- | --------------------------------------------------------------------------------- |
| `env_state` | 环境最终状态字段（**业务达成**，不是框架 succeeded）                              |
| `node_hit`  | 节点命中集合 / 顺序（轨迹）                                                       |
| `reco_text` | 指定节点识别到的文本 —— **v1.1 新增**：答案是画面内容时唯一能判「答对没有」的断言 |
| `op_count`  | 识别次数 / 点击次数（效率）                                                       |

> 命名说明：原叫 `sim_state`，但环境不再只有"模拟器"一种（见 §3），改名为环境中性的 `env_state`。

**判据只能锚定题面约定过的名字。** `node_hit` / `reco_text` 里写的节点名，
只有在 `prompt` 里明确要求过的时候才公平：否则同一份正确的产出，换个命名就会挂 —— 判的是
实现风格，不是业务达成（这正是 §0 第 3 条「把当下个例当通则」）。
所以 `reco_text` 的 `node` 是可选的：不写就是「这一跑里任何节点读到过这段文本」。

---

## 2. run 产物

```
runs/<run_id>/
  run.json        # 身份与元数据
  events.jsonl    # task / node 事件流
  ops.jsonl       # 控制器操作序列（环境侧记录）
  exec-summary.json # 执行子进程的回执：ops 原始记录、最终屏、终止原因
  artifact/       # agent 提交工件的快照
  score.json      # 判分结果（§4）
  logs/           # MaaFW 自己的日志（maafw.log，含 all_results_ / filtered_results_）
```

### run.json

```json
{
  "schema_version": 1,
  "run_id": "t001.sysA.seed1.r0",
  "task_id": "t001-enter-inventory",
  "system": {
    "harness": "claude-code@1.2.3",
    "model": "deepseek-v4.1-flash",
    "skill": { "id": "maafw-dev", "version": "0.3.0", "sha256": "..." },
    "tools": ["maa_pipeline_validate"]
  },
  "subset": { "id": "release", "sha256": "..." },
  "seed": 1,
  "repeat_index": 0,
  "started_at": "2026-09-15T12:00:00Z",
  "finished_at": "2026-09-15T12:00:42Z",
  "status": "succeeded",
  "submission": { "path": "artifact/", "sha256": "..." },
  "framework": { "maa_node": "5.13.0", "maafw_tag": "v5.13.0" },
  "harness_defaults": { "Default": { "timeout": 3000 } }
}
```

`status` 取 `succeeded | failed | timeout | error` —— **这只是"跑完了没有"，不是"做对了没有"**。做对没有看 `score.json`。

**提交在注入之前就冻结。** `harness_defaults` 是执行器写进资源包的默认值（目前只有
`Default.timeout`，来自 `budget.node_timeout_ms`）—— 框架在**加载时**把 Default 合并进每个节点，
所以它只能写进包里再加载，事后再 override 不生效。注入会改工作区，因此快照先拍、注入后做：
`artifact/` 永远只是"收到的那份东西"。要让一次 run 可复现，需要 `artifact/` + 这个字段两样。

### 账：`usage` / `timing`（被测系统自报）

```jsonc
"usage": {
  "source": "dsh-usage-hook@1",     // 必填：自报的数据必须能追来源
  "billing": { "mode": "metered", "plan": "team" }, // 可选；出现则 mode 必填
  "by_model": [                     // 必填、非空；桶 = 唯一键（provider, model, role）
    {
      "provider": "deepseek",       // 可选
      "model": "deepseek-v4.1-flash",              // 必填：臂里请求的，计价按它
      "model_reported": "deepseek-v4.1-flash-2026-08-01", // 可选：厂商回执的快照；拿不到 = null
      "role": "main",                    // 可选：main | subagent | …
      "input_tokens": 128400, "output_tokens": 8210,
      "cache_read_input_tokens": 96000, "cache_write_input_tokens": 12400,
      "reasoning_tokens": 1380, "turns": 41, "tool_calls": 133
    }
  ],
  "timing": { "agent_wall_ms": 486000, "llm_ms": 302000, "tool_ms": 151000 } // 可选
},
"usage_file": { "path": "usage.json", "sha256": "…", "bytes": 1234 }, // 原始文件归档的指纹
"usage_error": "…"   // 记账坏了写这条：`usage` 与 `usage_file` 都不出现，**但 run 照旧有效**
```

计数（`*_tokens` / `turns` / `tool_calls` / 计时）**缺省或 null 一律落成 `null`**，
给了就必须是非负**安全**整数 —— 越过 2^53 的加总会静默失真，所以 1e21 这类值直接拒。
坏输入（类型不对、越界、桶键重复、`source` 缺失）**一律拒绝**，不替它圆。

**厂商原始报文不进 `run.json`**：原始 usage 文件整份原样归档成 run 目录下的 `usage.json`，
`run.json` 只留规范化结果与它的大小和指纹。原始报文可达 MB 级，而 `run.json` 是每个聚合器都要解析的文件。

四条纪律：

1. **自报的必须标 `source`，且 `null ≠ 0`**：没报是 `null`，不是 0。静默变 0 能把整批成本结论翻过来，还看不出。
2. **只存明细不存总量**：`by_model` 是唯一真相，报告层自己加总；同时存两份数早晚打架。
3. **`model_reported` 拿不到就写 null**，不拿声明名充数 —— 快照未知是事实，不是缺陷。
4. **cost 不是测量值**：它是"定价表 × 测量值"的派生量，定价表单独版本化，报告里写清按哪版折算。
   订阅制的批**不和计量制混着报美元**。

我们测的账在别处，不在这里重复：`wall_ms`（这次跑了多久）、`ops.jsonl`（识别/点击明细）、`score.json.metrics`（判分时的派生）。

`run_id` 编码 `task.system.seed.repeat`，且必须能解析回来（聚合靠它分组）。

`subset` 记录本次跑的是哪个子集及其定义哈希。**没有它，聚合时分不清"这批是 10 个任务还是 100 个任务"**，见 §6。

---

## 3. 环境接口

环境（env）= 被测 pipeline 的"设备"。**三种，各自产出一个 MaaFW `Controller`**：

| type     | 是什么                                           | 用哪个 Controller                    | 支撑的任务形态           | 状态      |
| -------- | ------------------------------------------------ | ------------------------------------ | ------------------------ | --------- |
| `frames` | 静态图片包：喂固定帧，输入直接成功               | `CustomController`                   | 识别类（写个节点命中它） | ✅ 已实现 |
| `web`    | 网页标本应用：真实渲染 + 真实响应 + 真实延迟/DPI | `CustomController` ↔ headless 浏览器 | 自由实现 / 多步流程      | 待建      |
| `replay` | 真实录制回放（操作序列 + 逐帧图）                | `ReplayController`                   | 复现 / 修复              | 待建      |

**为什么是这三种**：多路径与全真在根上冲突——环境能响应任意动作，状态转移逻辑就必须由我们拥有（= 模拟）；用真实录制就只能复现录制到的那一条路径。所以两类任务配两类环境，报告里必须标明分数是在哪种环境上得的。

**刻意不先抽公共接口**：只有一个实现时抽出来的接口必然是错的。等 `web` 或 `replay` 落地、真正的共性显现之后再抽。

下面描述的是**已实现的 `frames` 环境**。

---

### 已实现的 `frames` 环境

`frames` 是一组帧 + 一个喂帧的控制器，**没有「应用」概念**：

```ts
bootFramesEnv({
  bundle: string,          // 资源包根目录（含 pipeline/），不是它的上一级
  screens: FramesScreen[], // 画面序列，第一屏是初始画面
  ocrModelDir: string,
  logDir: string,          // MaaFW 自己的日志落这里
})
// -> { res, ctrl, tasker, actor, ok, teardown() }

interface FramesScreen {
  name: string             // 屏名，也是 env_state 断言能取的 path
  path: string             // PNG 文件
  transitions?: Array<{ area: [x, y, w, h]; target: string }>
}
```

**画面可以依赖输入**：输入落在某屏的 `transitions` 矩形内就切屏，否则画面不变。
这样「点对了没有」看得见，但**单屏只有一条路径** —— 这正是它只够识别类任务的原因；
能容纳任意动作 = 状态转移逻辑由我们拥有，那是 `web` 环境的事。

**环境不回答「读了什么」**：识别结果是框架的产物，环境只记录画面与输入。
判「答对没有」用 `reco_text` 断言（比对节点识别到的文本），不看环境。

#### `ops.jsonl` 的一行

```json
{"op":"click","arg":{"x":262,"y":386},"screen":"home","ok":true,"moved":true,"at":1789520088381}
```

`screen` 是**动作出发时**的屏，`moved` 是这次输入有没有真的把画面带过去。
缺了 `moved`，一份 ops 只能看出「点过」，看不出「点对了没有」。

**运行期铁律**（适用于所有自研环境）

| 规则                                             | 理由                                                                      |
| ------------------------------------------------ | ------------------------------------------------------------------------- |
| `screencap` 返回 **PNG 编码字节**（ArrayBuffer） | 绑定层走 `MaaImageBufferSetEncoded`，不是原始像素                         |
| 每次回调**记录一条 ops.jsonl**                   | 效率项与轨迹证据的来源                                                    |
| `shell` 只接受白名单命令，其余返回 null          | Shell 动作在自研环境里完全由我们控制                                      |
| 环境状态**只在进程内**，不落可写文件             | 否则 agent 的 custom 代码能改状态给自己判满分                             |
| 跑框架的脚本末尾**必须** `process.exit()`        | MaaFW 的线程会让 node 进程不退出                                          |
| 但用 `fetch` 的脚本**不能** `process.exit()`     | Node 24 的 undici 退出收尾会和它抢跑（libuv 断言）→ 用 `process.exitCode` |

### `web` / `replay` 的接口：**等实现时再定**

交互式环境需要「应用（状态机）+ 时延模型 + 操作记录」这一层：`screencap` 由状态渲染、输入由状态机响应，**点了画面会变**。

**但这层接口现在不冻结** —— 只有一个实现时抽出来的接口必然是错的。相关约束先记在这：

- **时延由 `seed` 决定**：同 seed 完全可复现；换 seed = 另一种「当时机器状态」
- 时延参数**不能拍脑袋**：先在真机采样真实 `cost` 分布（设计定稿 §10）。在那之前用固定值，**且不得对外声称「模拟了真实时序」**
- **浏览器驱动必须让 agent 碰不到 debug 端口**（否则它能直接读 DOM 抄坐标）—— 这是**静默失败**型风险，没配好不会报错，只会让分数悄悄失真

---

## 4. 判分器

**纯函数**：`(run_dir, task.yaml) -> score.json`

```json
{
  "schema_version": 1,
  "run_id": "t001.sysA.seed1.r0",
  "task_id": "t001-enter-inventory",
  "submission_sha256": "...",
  "passed": true,
  "stages": {
    "load": true,
    "graph": true,
    "execute": true,
    "achieve": true
  },
  "asserts": [{ "kind": "env_state", "ok": true, "detail": "screen=inventory" }],
  "metrics": { "screencaps": 12, "clicks": 3, "wall_ms": 4210 },
  "score": 1.0
}
```

### 两条必须守住的纪律

1. **`passed` = 业务达成**，不是框架 `succeeded`。（m9a-692 的教训：框架报成功、业务没做成。）
2. **`stages` 是诊断列，不进通过率。** 它存在的唯一理由是：难任务上全员 0 分时能区分"加载失败 / 图坏了 / 跑崩了 / 没达成"。

### 实现时的已知坑（阶段 0 实测，别再踩）

| 事实                                                  | 后果                                                                              |
| ----------------------------------------------------- | --------------------------------------------------------------------------------- |
| `status 4000` = **任务失败**（识别未命中且无 `next`） | 不是解析失败，别误读成「节点没加载」                                              |
| `node_detail()` 对失败节点返回**空 `name`**           | **判分器不能靠它判断「节点是否存在」** → 要看下一行                               |
| MaaFW 自写 `runs/logs/maafw.log`                      | 含 `all_results_` / `filtered_results_` / `best_result_` → 识别层判分的现成证据源 |

> 这三条目前**没有对应实现**（判分器还没写）—— 属原则 4 允许的「约束」，不是接口。写判分器时回来对照。

### 聚合（最小项 → 能力 → 维度）

- 每个最小可测项：**通过数 / 有效案例数**
- **有效案例数 < 5 时不报通过率**（只能 0/50/100，无意义）→ 合并或标注"样本不足"
- 分母口径固定：`timeout` / `error` / 产物非法 **一律算失败**
- 一个任务可给多个最小项供分（靠 `task.yaml` 的 `covers`）
- 跨系统**禁止平均**（身份不同就不是同一个数）
- **跨 subset 禁止比较**：不同子集的难度构成不同，平均分不可比。报告必须标子集名，见 §6

---

## 5. 数据集与获取

**主仓不放二进制。** 数据集由 `datasets.yaml` 声明，`pnpm datasets <id>` 拉取（不带 id 即全部）。

```yaml
# datasets.yaml
defaults:
  data_root: data

datasets:
  ocr-ppocrv6-small:        # kind=dependency -> 落到 vendor/
    kind: dependency
    target: vendor/ocr
    license: MIT
    base_url: https://raw.githubusercontent.com/.../OCR/ppocr_v6/small
    files:
      - { name: det.onnx, sha256: 66c0f34c... }

  # 其余 kind 待实现：
  #   images     静态图片包（识别类任务）
  #   recording  真实录制包（操作序列 + 逐帧图 + 事件流）
  #   env        交互环境包（网页标本应用）
  #   log        日志包
```

**规则**

- 拉取**幂等**：哈希对得上就跳过；**哈希不符报错、绝不覆盖**
- 按 kind **分包**，一个包一份下载（不是「全部打一个大包」）
- **任务引用 dataset id，不塞文件**（见 §1 的 `env.dataset`）
- 数据集**必须能被第三方获取**，但**不必进主仓** —— 理由是 git 不适合装 GB 级二进制，且需要「可下架性」

**体积现实（实测）**

| 数据         | 单份                             | 可生成？    |
| ------------ | -------------------------------- | ----------- |
| 合成标本画面 | 12 KB（1280×720）                | ✅ 脚本生成 |
| 真实游戏帧   | **1.47 MB**（**同样 1280×720**） | ❌ 采集     |
| 真实日志     | 6–104 MB                         | ❌ 采集     |

→ 帧体积取决于**画面复杂度**，不是分辨率。
→ 真实录制**不能转视频**：压缩伪影会改变识别结果，必须逐帧图。视频只能当附件供人看。

**一条必须写进报告的边界**：逐帧图复现的是「录制到的那些时刻」，**不是**「那次真实运行」—— 两次截图之间发生了什么，我们永远不知道。

---

## 6. 子集与抽样

用户往往只想跑一部分。两种模式（按维度 / 跨维度抽样）都用**具名子集**表达，不用裸筛选器。

```yaml
# subsets.yaml
subsets:
  smoke:    { tasks: [t001, t002] }        # 2-3 个，验链路
  pipeline: { select: { axis: pipeline } } # 单轴全跑
  quick:    { tasks: [...] }               # 跨轴抽样：结果钉死在文件里
  release:  { select: { all: true } }      # 全量
```

**为什么必须具名**：子集定义要版本化 + 可复现。裸筛选器的隐患是 —— 今天跑一次、明天任务集变了再跑一次，**两个数看起来可比，实际不可比**。

**抽样用贪心覆盖**：在固定随机序下，逐个挑「覆盖未覆盖最小项最多」的任务，直到取满 N。抽出来的**任务列表存进文件**，不每次现算（任务集一变，抽样结果就变了）。

### 关键约束：子集的规模决定了它能报什么

| 子集     | 规模   | **能回答**         | **不能回答**     |
| -------- | ------ | ------------------ | ---------------- |
| `smoke`  | 2–3    | 链路通不通         | 任何分数         |
| 单轴     | 整条轴 | 这条轴有没有变化   | 整体水平         |
| 跨轴抽样 | 8–15   | **有没有大幅变化** | **哪条轴变好了** |
| 全量     | 全部   | 分层通过率         | —                |

配合「每个最小项 <5 例不报通过率」这条纪律：**抽样子集基本无法报分层结果**（10 个任务铺到 27 个最小项上，大部分项样本不足）。

→ **不写清楚，最可能的误用就是拿抽样结果当分层结论。**

### 具名子集 vs 临时筛选

|                                   | 用途                 | 能否进正式报告     |
| --------------------------------- | -------------------- | ------------------ |
| `--subset quick`                  | 正式、可引用、可复现 | ✅                 |
| `--axis pipeline --difficulty l2` | 探索、调试           | ❌ 必须标注 ad-hoc |

---

## 7. 目录约定

```
src/maa.ts                 maa-node 类型门面
src/env/                   环境层：每种环境产出一个 MaaFW Controller
  frames/                  图片包环境（已实现）：只是一组帧，没有「应用」概念
    actor.ts               喂固定帧的 CustomControllerActor
    boot.ts                起环境的调用顺序
  web/                     网页交互环境（待建）：标本应用（页面 + 驱动）在这里
  replay/                  真实录制回放（待建）
src/runner/                执行器（待建）
src/scorer/                判分器（待建）
tasks/<task_id>/           任务包（task.yaml + seed/；画面在数据集里，不在包内）
vendor/                    依赖（gitignore），由 datasets.yaml 拉取
data/<dataset-id>/         数据集落地（gitignore）
datasets.yaml              数据集清单
subsets.yaml               子集定义
scripts/                   工具脚本
systems/<name>/            一个被测系统的产出（提交物）；评测时它就是那份首次提交
runs/                      运行产物（gitignore，不入库）
```

**三条边界**（避免混淆）：

1. **依赖 vs 夹具**：`vendor/` 与 `data/` 是外部获取的；**夹具**指跑一次评测所需的固定输入，属于 `tasks/<id>/`
2. **画面归环境，不归 task**：画面由环境决定（`web/` 的页面、`replay/` 的录制、`frames/` 的图片包）。`frames/` 没有「应用」概念——它只是一组帧，帧本身是**数据**，来自 `datasets.yaml` 的 images 包，落 `data/`
3. **不提前建空目录**：`runner` / `scorer` / `web` / `replay` 都等实现时再建（之前空了三轮的教训）

资源包**不含** `model/ocr/`：OCR 模型用 `Resource.post_ocr_model(vendor/ocr)` 单独指定，与资源包解耦。

---

## 8. 刻意**没有**冻结的

- 断言 DSL 的具体语法（v1 三种 kind 够用）
- 时延模型的具体参数（等真机采样）
- held-out 变体的组织方式（等泛化项真正开测）
- 多能力轴的任务包命名规范（等有第二条轴）
- `subsets.yaml` 的具体语法（等第一个真子集落地）
- 数据集包（kind=images/recording/env/log）的打包格式（等第一个落地）
- 环境层公共接口（**等第二个环境实现** —— 一个实现时抽出来必然是错的）

---
