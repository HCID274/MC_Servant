# 开发进度记录（当前批次详细账本）

仅保留当前批次（每 10 个任务以内） 的逐任务明细，用于近期审查衔接与下一任务派发。

历史默认不在本文件中保留：
- 已完成批次的压缩摘要见 `WF_任务阶段压缩记录.md`（默认优先读取）
- 已完成批次的详细明细见 `WF_开发进度明细归档/`（按需展开）

---

## 当前批次

- 批次范围：`T-011` ~ `T-020`
- 当前已完成任务：`T-011`
- 当前批次摘要：已完成外部输入统一 ingress（入口） 契约，补齐 `game-chat`（游戏聊天） / `server-bridge`（服务端桥接） 子边界，并修正了游戏发送者标识与内部 `owner_id`（主人标识） 的语义混淆问题。

---

## 详细记录

### T-011（已完成）

- 任务目标：
  建立 `interfaces/game-chat`（接口层 / 游戏聊天） 与 `interfaces/server-bridge`（接口层 / 服务端桥接） 的最小 ingress（入口） 强类型契约，把网页端之外的两条外部输入通道统一收口为可测试的纯消息包 / 事件包边界。

- 审查结论：
  通过。首轮审查曾因 `game-chat`（游戏聊天） 把游戏发送者标识与内部 `owner_id`（主人标识） 混成同一标识空间而打回；本轮已改为显式接收 `owner_resolution`（主人绑定解析结果），并补上“发送者标识与内部 `owner_id` 不同但已匹配主人时仍可 accepted（接受）”的回归测试，逻辑问题已消除。

- 核心文件：
  `ts-core/src/interfaces/contracts.ts`
  `ts-core/src/interfaces/index.ts`
  `ts-core/src/interfaces/game-chat/contracts.ts`
  `ts-core/src/interfaces/server-bridge/contracts.ts`
  `ts-core/src/__tests__/interfaces-ingress-model.spec.ts`

- 变更快照：
  统一网页端、游戏聊天、服务端桥接三类入口的 `bot_id` / `owner_id` / `message_id` 或 `event_id` / `source` / `channel` / `timestamp` 字段语义，并把网页消息包切到统一消息包构造器。
  `game-chat`（游戏聊天） 新增 `owner_resolution`（主人绑定解析结果） 状态模型，accepted（接受） 路径只消费已解析出的内部 `owner_id`，不再通过 `sender_id === owner_id` 做跨标识空间比较。
  `server-bridge`（服务端桥接） 固定输出 `runtime_effect: "observe_only"`，并对嵌套 `payload`（载荷） 保持深只读克隆。

- 预检结果：
  以 Coder（编码代理） 回填结果为准：`bash ts-core/scripts/pre_review.sh` 通过；Vitest（测试） `11` 个测试文件、`56` 条测试全部通过。
