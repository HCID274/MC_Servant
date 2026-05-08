# MEMORY_LAYERING_DEBT.md — 分层记忆/RAG 调度欠账备忘

> v0.1 | 2026-05 | 记录 F 方案("分层注入 + 确定性触发器 + Chat/Plan search 兜底") 与当前代码的距离;不立即实施,后续逐项回补或重新评估。

---

## 0. 目的

盘点"四层记忆 (A / A.5 / B / C) + 混合 RAG (pgvector + FTS + RRF)"的当前状态,圈定 **F 方案** 的目标形态,以及现状到目标的最小改动路径。本文档不是排期单,是"以后再修"的备忘。

---

## 1. F 方案目标形态

```
用户消息
    ↓
ConversationWorker:
  ① 常驻注入(零 LLM 判断,零 RAG)
     · A 层 10 轮对话
     · A.5 滚动摘要
     · C 层小条目:USER 偏好 / MEMORY 命名实体别名表 / SKILL 摘要列表(只名字+一句话)
  ② 确定性触发器(规则,不用 LLM)
     · 命中"上次 / 之前 / 还记得 / 按老办法 / 那个流程" → 触发 B 层 RAG 一次
     · 命中未知专有名词(不在 minecraft-data 词表 + 别名表里) → 触发 B 层 RAG 一次
     · query = 原 message + 抽取的实体(不让 LLM 改写)
  ③ 注入到 Plan/Chat 的 user message,带 source 和 score,标注"候选上下文"
    ↓
Triage(保持现状,不动 schema)
    ↓
Plan/Chat(保留 search() tool 作漏判 fallback,限制不变:单轮 ≤3 次)
```

为什么不选 ChatGPT 推的 E 方案,见 §4。

---

## 2. 当前已实装(代码定位)

| 项 | 状态 | 代码位置 |
|----|------|----------|
| C 层三类资产 USER/MEMORY/SKILL,复合主键 `(bot_id, kind)` | 已实装 | `data/schema.ts:376-391` |
| C 层字符上限 USER 1375 / MEMORY 2200 / SKILL 2200 | 已实装 | `data/contracts/bot-memory.ts:11-15` |
| C 层 + A.5 拼接渲染为一段 `brain_context` | 已实装 | `conversation/brain-context.ts:11-24` |
| Triage 输入带 `brain_context` | 已实装 | `conversation/llm/types.ts:143-144` |
| Plan 输入带 `brain_context` | 已实装 | `conversation/llm/types.ts:165-166` |
| Plan/Chat 的 search() tool,描述明确"仅在 A.5 / C.MEMORY 不够回答时使用" | 已实装 | `conversation/llm/stage.ts:562` |
| B 层 task_summaries(带 embedding 1024 维) | 已实装 | `data/schema.ts:445-466` |
| B 层混合检索(FTS + 向量 + RRF) | 已实装 | `db/brain-search.ts` |
| 候选→提拔机制(memory_candidates + confidence) | 已实装 | `data/schema.ts:393-417` |
| 记忆审计(memory_audit) | 已实装 | `data/schema.ts:419-438` |
| LLM 重压安全约束 | 部分实装,待审 | `workers/brain-memory-safety.ts` |

**结论**:F 方案的主干"分层注入 + Plan/Chat search 兜底"已经在跑。距离 F 的差距集中在 C 层内部结构、触发器层、Triage 视野这三块。

---

## 3. 与 F 的距离(待办)

### 3.1 痛点 ①:C.MEMORY 是单段 free-text,命名实体混在长文本里

**问题**
命名地点("日月川")、人名、物品别名都被 LLM 写进 C.MEMORY 那段 ≤2200 字符的长文本。容量到上限触发 LLM 重压时会丢条目、改坐标。漏判 fallback 的 search() 救不回来——它索引的是 B 层 task_summaries,不是 C 层。

**最小改动**
在 C.MEMORY 内部规范固定 section 结构:

```
## 命名实体表(受保护,LLM 重压不得改写,只允许 append/update by key)
- 日月川: (-128, 64, 256)
- 主基地: (0, 70, 0)

## 自由摘要(LLM 可重压)
...常规世界事实...
```

配合 `brain-memory-safety.ts` 增加约束:LLM 重压只能改"自由摘要"段;命名实体表段必须按 key 增量更新,禁止整段重写。

**优先级**:中(影响命名地点引用准确性,当前 demo 任务粒度还没碰到)。

### 3.2 痛点 ②:漏判 fallback 救不了 C 层

**问题**
search() 检索的是 B 层 task_summaries。如果 LLM 重压把"日月川"从 C.MEMORY 写丢了,Plan/Chat 怎么 search 都找不回来。

**最小改动**
3.1 解决后自然缓解(命名实体表受保护就不会被写丢)。如果还需要更强保险,可补一条 search() 的 `source: "memory"` 通道,允许从 C.MEMORY 命名实体表反查。

**优先级**:低(等 3.1)。

### 3.3 痛点 ③:Triage 看不到 SKILL 名字列表

**问题**
`brain-context.ts:20` 用 `includeSkill` 控制是否注入 SKILL。Triage 大概率 `includeSkill: false`(轻量分诊,字符预算紧)。Triage 判 chat/task 时不知道有哪些已沉淀 SKILL,可能把"按老办法砍木头"误判为普通 task,而不是触发 SKILL 召回。

**最小改动**
为 Triage 单独提供 C.SKILL 的"标题列表"(每条只 name + 一句话摘要,不带正文),控制在 200-300 字符以内。在 `brain-context.ts` 增加 `renderSkillIndex(input, charBudget)` 渲染方法,Triage 路径传入。

**优先级**:中(影响"按老办法 / 经验"类指令的命中)。

### 3.4 确定性触发器(F 方案核心机制,目前缺失)

**问题**
F 方案里"关键词触发 + 未知名词触发"目前完全没有实装。所有 RAG 都靠 Plan/Chat 在生成时主动 search()——这意味着 Plan 必须先发一次"试探性"的 LLM 调用,发现自己缺资料,再发 search,再发第二次 LLM。延迟链路偏长。

**最小改动**
在 ConversationWorker 入口(Triage 之前或并行)增加规则化触发器:

- 命中关键词 "上次 / 之前 / 还记得 / 按老办法 / 那个流程"
- 命中未知专有名词(不在 minecraft-data 词表 + C.MEMORY 命名实体表里)
- 触发后:`query = 原 message + 抽取实体`,调用一次 B 层 search,把结果作为"候选上下文"注入 Plan/Chat 的 user message

**前置依赖**:3.1(命名实体表能从 C.MEMORY 结构化抽出来,触发器才能用它做白名单判断)。

**优先级**:中(没有它系统也能跑,有它能减少 Plan/Chat 多轮 search 往返)。

### 3.5 候选→提拔的实体类型分流

**问题**
当前 `memory_candidates` 表只按 kind={USER, MEMORY, SKILL} 分类,没有"实体类型"维度。命名地点和长 MEMORY 摘要走同一条提拔策略,无法把命名实体单独追加到 3.1 的"命名实体表"section。

**最小改动**
在 `memory_candidates` 增加 `entity_type` 字段(枚举:`free_text | named_place | named_person | named_item`),提拔规则按 entity_type 写入 C.MEMORY 不同 section。

**优先级**:低(3.1 实装后再做才有意义)。

---

## 4. 不做的事(明确边界)

- **不引入 RagGate Agent**(ChatGPT 方案 C):并行多一次 LLM 调用,简单指令(挖石头 / 回来)也烧成本,价值不抵复杂度。
- **不让 Triage 输出 `rag.needed / query / reason`**(ChatGPT 方案 E):Triage 是关键路径强延迟环节,职责越纯越好;让轻量 LLM 写检索 query 引入 query 漂移和 prompt injection 攻击面。
- **不把 C 层全部丢进向量库按需召回**:小条目常驻(总预算 ≤2000 token)是更便宜、更稳、更经得起追问的选择。
- **不让 RAG 命中覆盖实时事实**:Minecraft 物品/方块/坐标/背包仍来自 minecraft-data + Mineflayer + 实时快照;RAG 只解释"主人说的那个 X 是什么"。

---

## 5. 实施顺序建议

1. **3.1**(命名实体表 section + brain-memory-safety 约束) —— 解锁 3.2 / 3.4 / 3.5
2. **3.3**(Triage SKILL 标题列表注入) —— 独立可单做
3. **3.4**(确定性触发器) —— 依赖 3.1
4. **3.5**(memory_candidates entity_type) —— 优化项,等前面跑稳

---

## 6. 相关代码清单

| 文件 | 作用 |
|------|------|
| `ts-core/src/data/schema.ts:376-466` | bot_memory / memory_candidates / memory_audit / task_summaries 表定义 |
| `ts-core/src/data/contracts/bot-memory.ts` | C 层契约与字符上限 |
| `ts-core/src/db/brain-memory.ts` | C 层读写实现 (loadBotMemory / upsert) |
| `ts-core/src/db/brain-search.ts` | B 层混合检索 (FTS + 向量 + RRF) |
| `ts-core/src/conversation/brain-context.ts` | A.5 + C 层渲染注入 |
| `ts-core/src/conversation/llm/types.ts` | Triage / Plan / Chat 输入契约 (brain_context 字段) |
| `ts-core/src/conversation/llm/stage.ts` | search() tool 定义与描述 |
| `ts-core/src/workers/brain-memory-safety.ts` | LLM 重压安全约束(3.1 改动落点) |
| `ts-core/src/workers/brain-worker.ts` | BrainWorker 入口 |

---

## 7. 待审事项

- `brain-memory-safety.ts` 当前对 LLM 重压做了什么约束,3.1 的"分 section 保护"能否在现有约束上增量加,未盘清。第一次实施 3.1 前需先扫这个文件。
