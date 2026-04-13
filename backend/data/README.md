# Data 目录文档

`backend/data/` 目录存储了 Bot 运行所需的静态配置与最小运行时规则数据。任务规划层当前的主事实真源直接来自 `minecraft-data`，这里只保留不能直接从运行时库推导出来的补充数据，以及用户中文输入到标准目标 id 的最小词汇映射。

## 文件列表

### 1. `behavior_hints.txt`
-   **用途**: 提供给 LLM 的行为提示和安全守则。
-   **内容**: 包含防止 Bot 卡死、错误操作（如脚下垫方块）和鼓励请求澄清的指令。
-   **示例**: "If stuck underground... use 'goto' to a nearby safe location."

### 2. `behavior_rules.json`
-   **用途**: 定义 Bot 的高层行为规则 (Behavior Rules)。
-   **内容**: JSON 格式的规则集，用于指导 Bot 在特定情境下的决策，例如优先使用现有工具而非重新制造。

### 3. `bot_config.json`
-   **用途**: Bot 的基础配置。
-   **内容**: 包含 Bot 名称、主人名称、人格设定、自动生成设置等。
-   **注意**: 此文件可能会在运行时被更新（如保存新的 owner 信息）。

### 4. `runtime_rules.json`
-   **用途**: 运行时规则表。
-   **内容**: 保存不适合写死在 Python 里的基础运行时列表，例如空气方块名、脚手架候选方块名。

### 5. `target_mappings.json`
-   **用途**: 中文目标映射表。
-   **内容**: 保存常用中文物品/方块/资源/位置目标到标准英文目标 id 的词汇映射，例如 `工作台 -> crafting_table`、`铁矿 -> iron_ore`、`原木 -> any_log`。
-   **边界**: 它只负责“中文词汇 -> 标准目标 id”的翻译，不负责维护配方、掉落、工具等级等游戏事实；这些事实仍然以 `minecraft-data` 为准。

## 作用机制

这些数据文件在系统启动或查询时被加载：
-   `domain_catalog.py` 会直接查询 `minecraft-data` 生成结构化 `tool_context`。
-   `domain_catalog.py` 会先读取 `target_mappings.json`，把中文任务目标翻译成标准目标 id，再继续查询 `minecraft-data`。
-   `mineflayer_adapter.py` 会读取 `runtime_rules.json`，避免把空气方块名、脚手架列表等运行时数据写死在 Python 中。
-   LLM 的 System Prompt 会注入 `behavior_hints.txt` 的内容。

## 维护说明

-   修改 JSON 文件时请确保格式正确。
-   任务事实优先以 `minecraft-data` 为准；`target_mappings.json` 只承担中文词汇适配，不得演变成第二事实源。
-   已废弃且不再使用的历史知识库文件不要重新加回主规划链。
