# 项目进度记录

> Reviewer C 在审查通过后追加。一条一个任务。
> 历史批次摘要 (T-001 ~ T-040) 见 `PROGRESS_LEGACY.md`。

## 字段格式

```
## T-XXX | YYYY-MM-DD | 一句话功能描述

- 涉及模块: X, Y
- A 拆解依据: 用户需求 + 引用的架构条目
- C 审查结论: 通过 / 曾打回 N 次 (原因)
- 关键决策: 为什么选 X 不选 Y (从 B 交互记录第四段提炼)
- 架构冲突: 无 / [简述]
```

---

## 进行中 (旧系统遗留)

### T-047B | cutTree (砍树) 单技能验收 + 接入

**状态**: 旧 Manager 工作流下规划,未完成。新工作流启用后,可由 Planner A 重新评估或接续。

**目标**: 在线允许的 skill 集合从 `goTo + collect` 扩到 `goTo + collect + cutTree`;`equip` 与 `mine` 仍保持未启用。

**核心约束**:
- probe 先行: `ts-core/scripts/probes/cut-tree-probe.ts`,实服验证后再并入主程序
- 主程序必须通过 ResourceIndex 查询 / 刷新 (16→32→64),不得绕过缓存或临时全图扫描
- 不得硬编码 MC 树木事实(树种 / 原木 / 树叶 / 工具等级);事实源不能识别 `tree` 时返回 `unsupported_resource_key`
- 单技能门禁: `mine` 与 `equip` 仍返回 `skill_not_enabled`
- 触碰 LLM 链路 → 必须真实 LLM 验收

**后续 (T-047B 之后)**:
- T-048: equip 单技能验收 + 接入
- T-049: mine 单技能验收 + 接入
- T-050: 基础 skill 端到端 demo 收口

---

## 已完成 (新工作流下)

(从这里开始,Reviewer C 通过任务后追加)

## T-OPS-001 | 2026-05-01 | Docker（容器引擎）一键启停与开发模式入口

- 涉及模块: 根目录 Compose（编排）与启停脚本,ts-core（TS 单核心） Dockerfile（镜像构建文件）/ README（说明文档）,旧 Python（旧后端）入口
- A 拆解依据: 用户要求保留三端全 Docker（容器）验收模式,新增 PostgreSQL（数据库）+ Redis（缓存）开发模式;边界限定不动 MC（我的世界）服务端、不触 LLM（大语言模型）链路
- C 审查结论: 通过
- 关键决策: 复用同一份 Compose（编排）与 ts-core/.env（环境变量文件）,用 dev-infra.sh 只拉起 infra（基础设施）并移除 Docker（容器）app（应用）,避免第二份配置漂移
- 架构冲突: 无

## T-NET-001 | 2026-05-01 | 受击 knockback（击退）物理反馈诊断与最小修复

- 涉及模块: Mineflayer（Minecraft 协议客户端） transport（传输层）适配,network probe（网络探针）脚本,运行时回归测试
- A 拆解依据: 用户要求诊断并修复 bot（机器人）受击后缺失原版等价 knockback（击退）位移;边界限定可动 Mineflayer（Minecraft 协议客户端）适配层/网络入口/物理桥接,不动 skill（技能）/LLM（大语言模型）/BotActor（机器人执行代理）推理/JAR 插件/server-bridge（服务端桥接）协议,且禁止 fork（分叉）或 monkey-patch（运行时改写） Mineflayer（Minecraft 协议客户端）本体
- C 审查结论: 通过
- 关键决策: 在 Mineflayer（Minecraft 协议客户端）适配层兼容 1.20.3+ `entity_velocity`（实体速度）包的 `velocity: {x,y,z}` 结构,按协议速度单位转换后写回目标实体 velocity（速度）,不修改 Mineflayer（Minecraft 协议客户端）本体也不扩大到服务端协议
- 架构冲突: 无
