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

## T-NET-003 | 2026-05-01 | multiworld（多世界）方块事实可信修复

- 涉及模块: Mineflayer（Minecraft 协议客户端） transport（传输层）适配,block fact probe（方块事实探针）,collect（捡拾）实服回归辅助修复,运行时回归测试
- A 拆解依据: 用户要求修复 `multiworld:resource`（资源世界）下方块事实失真;边界允许 adapter（适配层）/observation（观测层）/transport（传输层）方块路径/server-bridge（服务端桥接）/JAR（Java 插件）,禁止触 LLM（大语言模型）/prompt（提示词）/BotActor（机器人执行代理）/skill（技能）规划层/Mineflayer（Minecraft 协议客户端）本体源码
- C 审查结论: 曾打回 1 次 (代码量与 10 bot（机器人）并发验收约束不满足);用户本轮明确放宽代码量与并发验收,按功能与架构边界改判通过
- 关键决策: 先用 probe（探针）按 H1（假设一）→ H3（假设三）→ H2（假设二）定位根因,确认 H3（假设三）为 Mineflayer（Minecraft 协议客户端） blocks plugin（方块插件）在 dimension switch（维度切换）后 worldName（世界名）恢复失败;修复选择 adapter（适配层）兼容补丁,不进入 JAR（Java 插件）权威 block change（方块变更）推送路径
- 架构冲突: 无

## T-CTX-RES-0 | 2026-05-02 | ResourceService（世界感知资源服务）接口落地与存量补丁收编

- 涉及模块: world-model（世界模型）接口契约与缓存结构,runtime/transport（运行时传输层）世界解析端口与 WorldReader（世界读取器）,app（应用装配）注入路径,conversation-worker（对话工作器）资源摘要消费,运行时与 world-model（世界模型）回归测试
- A 拆解依据: 用户要求把 ResourceIndex（资源索引）升格为 ResourceService（世界感知资源服务）,公共 API（接口）保持 `query(resource_key)` / `refresh(resource_key, radius)` 扁平形态,内部按 `(world_key, resource_key)`（世界键、资源键）二元组路由;边界限定不改 skill（技能）接口、LLM（大语言模型）协议、observation（观测）数据契约或 Mineflayer（Minecraft 协议客户端）本体源码
- C 审查结论: 曾打回 1 次 (缺少跨维度实服回归记录);用户补充确认已在 Nether（下界）与 multiworld（多世界）切换中实测有效,改判通过
- 关键决策: 世界解析唯一实现保留在 transport（传输层）并沿用 `bot.game.dimension`（机器人当前维度）语义;ResourceService（世界感知资源服务）内部持有 `(world_key, resource_key)`（世界键、资源键）缓存桶,业务层只消费扁平 API（接口）;单点方块读取另收敛到极薄 WorldReader（世界读取器）,不把 `blockAt`（方块读取）混入资源聚合服务。未来新功能不得自行处理 `world_key`（世界键）,必须通过 ResourceService（世界感知资源服务）或 transport（传输层）既有端口消费
- 架构冲突: 无

## T-CTX-001 | 2026-05-02 | Planner（规划器） prompt（提示词）注入真实 Bot（机器人）/世界/主人/背包快照

- 涉及模块: conversation/llm（对话大语言模型） prompt（提示词）模板与 planner snapshot context（规划器快照上下文）,app（应用装配）在线 planner（规划器）注入,observation（观测）快照字段,runtime/transport（运行时传输层）只读采样端口/WorldReader（世界读取器）/world-state-reset（世界状态重置）,回归测试
- A 拆解依据: 用户要求用真实 observation（观测）快照替换 `createOnlinePlannerSnapshotContext`（在线规划快照上下文）占位 stub（占位实现）,只落 §7.1 的 `[Bot]`/`[世界]`/`[主人]`/`[装备]`/`[背包]`/`[附近方块]`/`[附近生物]`/`[时间]` 八行,不含 `[背包变化]` 与 `[资源簇]`;边界限定不改 skill（技能）接口、sandbox（沙箱）、LLM（大语言模型）协议结构或 ConversationWorker（对话工作线程）路由,`world_key`（世界键）来源必须走 transport（传输层）端口
- C 审查结论: 曾打回 1 次 (实服切换 world（世界） 后 Mineflayer（Minecraft 协议客户端）实体/玩家/pathfinder（寻路器）状态未刷新);B（实现代理）补充 world-state-reset（世界状态重置）后通过
- 关键决策: planner（规划器）上下文在 app（应用装配）根实时采样,不改 worker（工作线程）路由;`bot.world_key`（机器人世界键）由 transport（传输层）统一读取,observation（观测）只消费字段;主人名取最近 server-bridge（服务端桥接）玩家消息,HTTP（超文本传输协议）直入或无玩家名时按 §7.3 降级为 `[主人] 离线`;世界切换残留通过 transport（传输层）清理 Mineflayer（Minecraft 协议客户端）内部 pathfinder（寻路器）目标、控制状态与旧实体索引,不改 prompt（提示词）或 skill（技能）
- 架构冲突: 无

## T-LLM-THINK-OFF | 2026-05-03 | LLM（大语言模型） thinking（思考）模式默认关闭

- 涉及模块: conversation/llm（对话大语言模型）配置与 HTTP（超文本传输协议）请求适配,app（应用装配）环境变量装配,`.env.example`（环境变量示例）,LLM（大语言模型）运行时与 app（应用）回归测试
- A 拆解依据: 用户要求关闭 MiMo（小米大模型） thinking（思考）模式,通过统一 LLM（大语言模型）配置表达默认关闭,业务层不直接散落供应商私有参数;边界限定在 LLM（大语言模型）配置/HTTP（超文本传输协议）适配与装配层,不改 prompt（提示词）、skill（技能）、runtime（运行时）或 worker（工作线程）
- C 审查结论: 曾打回 1 次 (非 MiMo（小米大模型） `force_thinking_models`（强制思考模型）命中且 `reasoning_effort=none`（推理强度为无）时会静默不发有效开启字段);B（实现代理）改为配置阶段显式拒绝坏组合并补齐非 MiMo（小米大模型）回归测试后通过
- 关键决策: 业务配置统一使用 `LLM_ENABLE_THINKING=false`（关闭思考）、`LLM_REASONING_EFFORT=none`（无推理强度）与 `LLM_FORCE_THINKING_MODELS`（强制思考模型清单）;HTTP（超文本传输协议）适配层只对 MiMo（小米大模型）下沉 `chat_template_kwargs.enable_thinking=false`（聊天模板参数关闭思考）,非 MiMo（小米大模型）仅在 force（强制）且 effort（强度）非 `none`（无）时发送 `reasoning_effort`（推理强度）,避免配置声称开启但请求体无效
- 架构冲突: 无
