# 仓库指南（给 AI Agent）

MaaFrameworkBench —— 面向 MaaFramework 应用开发的 Agent 评测套件。

## 动手前先读契约

**`docs/interfaces.md` 是这个仓库的规范**，它的总原则与各节约束都管着你。

**不要在本文或别处重复它的内容。** 包括这几类 —— 它们都会被清掉：

- 契约里已有的规矩（改了要改两处，早晚漂移）
- 代码注释里已经解释过的（读代码就知道）
- 会过期的状态描述（「已实现 / 未实现」这类，看目录就知道）
- 读者拿不到的东西（本机路径、会话笔记）

## 命令

```bash
pnpm typecheck      # tsc --noEmit
pnpm datasets       # 按 datasets.yaml 拉数据集；可跟 id，不带即全部
pnpm format         # prettier --write .
pnpm format:check   # 只检查不改
```
