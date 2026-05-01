# 项目进度历史 (旧 Manager 系统)

> 旧三角色 (Manager / Coder / Consultant) 工作流下的批次压缩归档。
> 仅作为历史参考,新任务不再追加到此文件;新条目写入 `PROGRESS.md`。

---

## 批次 T-001 ~ T-010

- **阶段主题**: TS Core Phase 1 工程骨架、核心模块纯契约与本地装配闭环
- **覆盖模块**: domain / runtime / data / observation / world-model / skills / interfaces / sandbox / diagnostics / conversation / workers / db / app
- **要点**:
  - 完成 pnpm + TypeScript strict + NodeNext + Biome + Vitest 主线工程基座,建立 `pre_review.sh` 闭环
  - 以纯函数 / 强类型方式补齐 runtime 状态机、执行任务、事件枚举、中断协议与最小 BotActor 骨架,锁定聊天驱动与单写者约束
  - 建立 data / db 契约层,收口 PostgreSQL 业务表、迁移元信息、Redis 键目录、日志保留策略、环境变量与 Bot 级配置覆盖逻辑
  - 建立 observation / world-model 只读边界,修复快照副本语义与威胁评估强类型约束
  - 建立 skills Phase 1 目录、参数模型与注册表;`skill_call` 不再依赖弱类型输入
  - 建立 interfaces 的网页会话、消息提交、状态查询、健康检查与 replay 契约
  - 建立 sandbox / diagnostics 最小强类型契约,收口 Facade API、资源限制、错误分类、JSONL 通道
  - 建立 conversation / workers 三队列边界、分诊回退、回复 / 规划产物与中断桥接语义
  - 建立 app 组合根与无 MC 冒烟装配摘要
- **结果**: 形成"无真实外部适配器实例"的本地纯契约闭环。MC 认证按外部认证源建模,部署样例为 EasyAuth + SQLite,TS Core 不接管认证数据。

---

## 批次 T-011 ~ T-020

- **阶段主题**: 从纯契约骨架转向 MVP 关键路径,完成外部输入、任务生命周期、外部认证、本地启动、持久化边界与三块真实 I/O 资源接入
- **覆盖模块**: interfaces / conversation / workers / runtime / observation / app / db / data / diagnostics / domain
- **要点**:
  - T-011 统一 Web / game-chat / server-bridge 三类 ingress 标准消息包与事件包
  - T-012 打通 accepted / started / discarded / completed / failed / interrupted 任务生命周期
  - T-013 EasyAuth 建模为外部认证源,清除 authme schema 残留,修正 sandbox 日志与 REFLEXING 中断语义
  - T-014 补齐 main.ts、启动摘要、Dockerfile、.env.example
  - T-015 收口 event_log / task_history / JSONL / replay 持久化边界
  - T-016 外部认证推进为"状态脱敏 + 一次性执行动作载荷"纯模型
  - T-017 重复 invariant helper 收口到 domain/invariants.ts
  - T-018 接入 PostgreSQL / Redis 真实资源工厂与 Drizzle migration 入口
  - T-019 接入 BullMQ 三队列与 Fastify 四路由启动骨架
  - T-020 接入 Mineflayer 传输工厂、observation 事件驱动缓存与 BotActor INITIALIZING → IDLE 生命周期
- **结果**: 形成可注入运行时资源骨架。资源关闭顺序: HTTP / workers → runtime transport → Redis → PostgreSQL。主干切到"可运行链路阶段"。

---

## 批次 T-021 ~ T-030

- **阶段主题**: MC 真实上线闭环、OpenAI 兼容 LLM 接入、多技能执行、sandbox_code 执行与架构治理止血
- **覆盖模块**: app / runtime / workers / conversation / interfaces / skills / sandbox / observation / diagnostics / data / core-ports / domain
- **要点**:
  - T-021 打通最窄 MC 在线聊天闭环
  - T-022 打通 goTo 最小真实执行链
  - T-023 接入 OpenAI 兼容 chat.completions 闲聊最短闭环 + cancel 中断 + 模板回执
  - T-024 真实 LLM 扩到 triage + 单技能 plan,移除旧正则快路径
  - T-025 扩展真实技能面到 mine / collect / equip,全部走 BotActor 单写者
  - T-026 补齐手测观测出口:`/api/status` + `/api/replay`,统一脱敏
  - T-027 打通 sandbox_code 真实执行链:isolated-vm + esbuild + Facade API
  - T-028 新增 core-ports 下沉共享类型,打断 runtime 与 skills / observation / diagnostics / data 循环依赖,`pre_review.sh` 纳入 madge
  - T-029 拆分五个超大文件,保留兼容 barrel 入口
  - T-030 架构治理收口:executeStage 统一 LLM 三段调用,技能规划改表驱动,Prompt 模板独立组织
- **结果**: 主干具备真实 MC 上线、真实 LLM 闲聊 / 分诊 / 单技能规划、真实技能执行、观测查询、事件回放与 sandbox_code 执行能力。依赖图无循环。

---

## 批次 T-031 ~ T-040

- **阶段主题**: 对话智能增强、记忆与状态注入、MC 事实源、反射动作、Fabric 服务端桥接基线
- **覆盖模块**: conversation / workers / runtime / interfaces / world-model / diagnostics / data / app / plugin
- **要点**:
  - T-031 BotActor 当前状态只读投影注入 chat_reply LLM 输入
  - T-032 triage 升级为 composite output (cancel → reply → action 有序派发)
  - T-033 BrainWorker 最小任务摘要写入链路与 memory 检索端口
  - T-034 网页轻面板后端最小同步闭环
  - T-035 sandbox_code 经验沉淀钩子与诊断脱敏
  - T-036 memory 上下文注入 chat / plan LLM 路径,失败降级为无记忆
  - T-037 接入 minecraft-data 作为 MC 事实查询真源
  - T-038 BotActor 单写者边界内落地有限脊髓反射动作
  - T-039 plugin 从 Paper / Maven 重写为 Fabric Loom 工程
  - T-040 Fabric mod OkHttp 真实 WebSocket 连接 + hello / heartbeat
- **结果**: 对话层具备状态感知、复合分诊、记忆注入、真实 LLM 验收口径与 replay 出口。世界事实查询回到 minecraft-data。Fabric 桥接已可构建并具备本地联调能力。

---

## 批次 T-041 ~ T-047A (未压缩,逐任务记录)

旧 Manager 工作流下逐任务记录,曾归档于 `WF_开发进度记录.md` / `WF_当前任务握手.md`。新工作流启动后这些动态文件被删除。

主要进展:
- T-041 ~ T-043: TS Core 端 server-bridge 接收骨架与 Fabric 命令链路联调
- T-044: Server Bridge 重连与错误处理,对话主线接入
- T-045: (任务切分规则更新)
- T-046: collect 捡拾技能单技能独立验收与接入
- T-047A: ResourceIndex 前置能力 (queryClusters / refreshAroundBot / 半径阶梯 16→32→64 / planner 短资源摘要)

T-047B (cutTree 单技能验收 + 接入) 在新工作流启动时仍处于"待开发"状态。详见 `PROGRESS.md` "进行中"段。
