# TS Core — Agent 协作索引

> 三角色 Agent（Manager / Coder / Consultant）的共同入口。
> 详细工作流规范见 `Docs/09_AGENT_WORKFLOW.md`。

---

## 项目定位

TS Core 是以 TypeScript 为唯一执行核心的 Minecraft Bot Agent 系统，彻底替代旧系统的 Python + JS + Java 三核心架构。

**Phase 1 边界**：一主一 Bot，基础技能（goTo / mine / cutTree / collect / equip），轻面板。

---

## 技术栈速览

| 层级 | 选型 |
|---|---|
| 运行时 | Node.js + TypeScript (strict) |
| API 网关 | Fastify + Zod |
| 实时推送 | Socket.io |
| 任务队列 | Redis + BullMQ |
| 执行核心 | BotActor + isolated-vm + Mineflayer |
| Server Bridge | 自定义 JAR 插件 |
| 持久化 | PostgreSQL + Drizzle ORM + pgvector + JSONL |
| 工具链 | pnpm, Biome (lint/format), Vitest (test) |

---

## 文档索引

### 静态设计文档

| 序号 | 文件 | 内容 | 状态 |
|---|---|---|---|
| 01 | `Docs/01_ARCHITECTURE.md` | 七层架构、三队列模型、五条不可破坏约束 | v0.2 |
| 02 | `Docs/02_RUNTIME_SPEC.md` | BotActor 状态机、AbortController 中断协议 | v0.1 |
| 03 | `Docs/03_SANDBOX_SPEC.md` | isolated-vm 集成、Facade API 类型定义 | v0.1 |
| 04 | `Docs/04_CONVERSATION_SPEC.md` | 意图分类、LLM prompt 设计、代码生成约束 | v0.1 |
| 05 | `Docs/05_DATA_SPEC.md` | Drizzle schema、JSONL 日志、pgvector | v0.1 |
| 06 | `Docs/06_INTERFACE_SPEC.md` | Fastify 路由、Socket.io 事件协议 | 待编写 |
| 07 | `Docs/07_SKILL_CATALOG.md` | Phase 1 技能清单与 Facade API 签名 | 待编写 |
| 08 | `Docs/08_DEPLOYMENT.md` | Docker Compose 拓扑、环境变量 | 待编写 |
| 09 | `Docs/09_AGENT_WORKFLOW.md` | 三角色协作工作流规范 | v0.1 |

### 动态工作流文件

| 文件 | 用途 | 读写权限 |
|---|---|---|
| `Docs/WF_当前任务握手.md` | 当前活跃任务 + 队列预览 | Manager 写 / Coder 读+填反馈 |
| `Docs/WF_开发进度记录.md` | 已完成任务追加记录 | Manager 追加 |
| `Docs/WF_需求变更索引.md` | 需求变更摘要 | Consultant 追加 / Manager 读 |

### 预检脚本

| 文件 | 用途 |
|---|---|
| `scripts/pre_review.sh` | Coder 自检最后一步：typecheck + lint + test |

### 旧系统参考索引

需要参考旧实现时，从以下索引入手，不直接扫描旧代码：

- `docs/legacy-migration-index.md` — 迁移导航总入口
- `docs/legacy-runtime-index.md` — 运行时相关
- `docs/legacy-skills-index.md` — 技能相关
- `docs/legacy-observation-index.md` — 观察模块
- `docs/legacy-world-model-index.md` — 世界模型
- `docs/legacy-data-index.md` — 数据层

---

## 五条不可破坏的约束（速查）

1. **单写者** — 任意时刻只有 BotActor 拥有操作 Bot 的权力
2. **聊天驱动** — 消息是唯一的用户意图入口
3. **双端同步** — 网页/游戏消息全量同步广播
4. **本地执行闭环** — Bot 物理动作在本地完成，禁止同步阻塞绕路
5. **最小闭环优先** — Phase 1 范围严格受控

---

## 目录结构

```
ts-core/
  agent.md                  ← 本文件
  Docs/                     ← 设计文档 + 工作流文件
  scripts/                  ← 工具脚本（pre_review.sh 等）
  src/                      ← 源代码（Coder 工作区）
    runtime/                ← BotActor、状态机
    skills/                 ← 技能实现
    observation/            ← 观察模块
    world-model/            ← 世界模型
    diagnostics/            ← 诊断工具
    domain/                 ← 领域类型
    data/                   ← 数据层
```
