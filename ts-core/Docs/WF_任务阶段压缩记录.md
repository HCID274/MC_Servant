# 任务阶段压缩记录

仅 Manager 在一个批次累计满 10 个已完成任务后追加。该文件用于阶段性压缩归档，不替代 `WF_开发进度记录.md`（详细进度记录） 的逐任务明细。

---

## 批次 T-001 ~ T-010

- **阶段主题**: TS Core（TypeScript 单核心） Phase 1（第一阶段） 工程骨架、核心模块纯契约与本地装配闭环
- **覆盖模块**:
  - `domain`（领域）
  - `runtime`（运行时）
  - `data`（数据）
  - `observation`（观测）
  - `world-model`（世界模型）
  - `skills`（技能）
  - `interfaces`（接口层）
  - `sandbox`（沙箱）
  - `diagnostics`（诊断）
  - `conversation`（对话）
  - `workers`（工作线程）
  - `db`（数据库）
  - `app`（应用装配）
- **阶段压缩摘要**:
  - 完成 `pnpm`（包管理器） + `TypeScript strict`（严格模式） + `NodeNext`（Node 模块解析） + `Biome`（格式化 / lint） + `Vitest`（测试） 的主线工程基座，并建立 `pre_review.sh`（预检脚本） 闭环。
  - 以纯函数 / 强类型方式补齐 `runtime`（运行时） 状态机、执行任务、事件枚举、中断协议与最小 `BotActor`（机器人执行代理） 骨架，锁定聊天驱动与单写者约束。
  - 建立 `data`（数据） / `db`（数据库） 契约层，收口 PostgreSQL（关系型数据库） 业务表、迁移元信息、Redis（缓存） 键目录、日志保留策略、环境变量与 Bot 级配置覆盖逻辑。
  - 建立 `observation`（观测） / `world-model`（世界模型） 只读边界，修复快照副本语义与威胁评估强类型约束，保证读取侧不会旁路污染内部状态。
  - 建立 `skills`（技能） Phase 1（第一阶段） 目录、参数模型与注册表；`skill_call`（技能调用） 不再依赖自由字符串 + 自由参数对象的弱类型输入。
  - 建立 `interfaces`（接口层） 的网页会话、消息提交、状态查询、健康检查与 replay（补拉） 契约，并保证会话与目标 Bot（机器人） 绑定一致，不允许跨 Bot 混包进入主线。
  - 建立 `sandbox`（沙箱） / `diagnostics`（诊断） 的最小强类型契约，收口 `Facade API`（门面接口）、资源限制、错误分类、JSONL（结构化日志） 通道、`log_ref` / `code_ref`（日志 / 代码引用） 规则。
  - 建立 `conversation`（对话） / `workers`（工作线程） 的三队列边界、分诊回退、回复 / 规划产物与中断桥接语义，避免工作线程直接耦合对话实现细节。
  - 建立 `app`（应用装配） 组合根与无 MC（Minecraft） 冒烟装配摘要，把 `interfaces`（接口层） / `workers`（工作线程） / `runtime`（运行时） / `db`（数据库） / `data`（数据） / `sandbox`（沙箱） / `diagnostics`（诊断） 的公开契约收口成可测试的单进程启停骨架。
- **阶段结果**:
  - 已形成“无真实外部适配器实例”的本地纯契约闭环，可继续向 `game-chat`（游戏聊天） / `server-bridge`（服务端桥接） ingress（入口） 统一、任务事件闭环、外部认证适配与部署骨架推进。
  - 已确认长期约束：MC（Minecraft） 认证真理源按外部认证源建模，当前部署样例为 EasyAuth（离线服认证模组） + SQLite（嵌入式数据库）；TS Core（TypeScript 单核心） 不接管、不迁移、不双写认证数据。
- **下一批次规划规则**:
  - `T-011` 到 `T-020` 继续按正常详细格式写入 `WF_当前任务握手.md`（当前任务握手） 与 `WF_开发进度记录.md`（详细进度记录）。
  - 当 `T-020` 审查通过后，再将 `T-011` 到 `T-020` 压缩追加到本文件。
