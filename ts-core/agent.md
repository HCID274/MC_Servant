# TS Core — Agent 入口

> 三角色 Agent (Planner A / Coder B / Reviewer C) 的共同入口。
> 完整工作流见 `Docs/WORKFLOW.md`,工程规范见 `Docs/ENGINEERING_PRINCIPLES.md`。

---

## 项目定位

TS Core 是以 TypeScript 为唯一执行核心的 Minecraft Bot Agent 系统。

**Phase 1 边界**: 一主一 Bot,基础技能 (`goTo` / `mine` / `cutTree` / `collect` / `equip`),轻面板。

---

## 技术栈

| 层级 | 选型 |
|---|---|
| 运行时 | Node.js + TypeScript (strict) |
| API 网关 | Fastify + Zod |
| 实时推送 | Socket.io |
| 任务队列 | Redis + BullMQ |
| 执行核心 | BotActor + isolated-vm + Mineflayer |
| Server Bridge | 自定义 Fabric mod |
| 持久化 | PostgreSQL + Drizzle ORM + pgvector + JSONL |
| 工具链 | pnpm, Biome, Vitest |

---

## 文档索引

### 静态设计 (默认只读)

| 文件 | 内容 |
|---|---|
| `Docs/01_ARCHITECTURE.md` | 七层架构、三队列模型、五条不可破坏约束 |
| `Docs/02_RUNTIME_SPEC.md` | BotActor 状态机、AbortController 中断协议 |
| `Docs/03_SANDBOX_SPEC.md` | isolated-vm 集成、Facade API |
| `Docs/04_CONVERSATION_SPEC.md` | 意图分类、LLM prompt 设计、代码生成约束 |
| `Docs/05_DATA_SPEC.md` | Drizzle schema、JSONL、pgvector |

### 工作流与进度

| 文件 | 内容 |
|---|---|
| `Docs/WORKFLOW.md` | 三角色定义、信息流、Prompts |
| `Docs/ENGINEERING_PRINCIPLES.md` | 高内聚 / 低耦合 / DRY / SOLID(B 自检 + C 审查共同标准) |
| `Docs/PROGRESS.md` | 已完成任务索引(C 审查通过后追加) |
| `Docs/PROGRESS_LEGACY.md` | 旧 Manager 系统的批次摘要(只读,历史参考) |

### 预检脚本

| 文件 | 用途 |
|---|---|
| `scripts/pre_review.sh` | Coder B 自检最后一步:typecheck + lint + test + madge |

### 旧系统索引

需要参考旧实现时,从 `docs/legacy-migration-index.md` 入手,按专题下钻 `docs/legacy-*-index.md`,不直接扫描旧代码。

---

## 五条不可破坏约束 (速查)

1. **单写者** — 任意时刻只有 BotActor 拥有操作 Bot 的权力
2. **聊天驱动** — 消息是唯一的用户意图入口
3. **双端同步** — 网页 / 游戏消息全量同步广播
4. **本地执行闭环** — Bot 物理动作在本地完成,禁止同步阻塞绕路
5. **最小闭环优先** — Phase 1 范围严格受控

---

## 目录结构

```
ts-core/
  agent.md                  ← 本文件
  Docs/                     ← 设计文档 + 工作流 + 进度
  scripts/                  ← 工具脚本 (pre_review.sh, probes/)
  src/                      ← 源代码 (Coder B 工作区)
    runtime/   skills/      observation/  world-model/
    diagnostics/ domain/    data/         conversation/
    workers/   sandbox/     interfaces/   app/
```
