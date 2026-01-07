# Data 目录文档

`backend/data/` 目录存储了 Bot 运行所需的静态配置文件、规则定义和知识库数据。这些文件定义了 Bot 的行为准则、合成配方和基础知识。

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

### 4. `mc_knowledge_base.json`
-   **用途**: Minecraft 基础知识库。
-   **内容**: 包含方块、物品、实体及其属性（如是否可挖掘、所需工具等级、掉落物等）。
-   **生成方式**: 由 `scripts/build_knowledge_base.py` 脚本根据 `minecraft-data` 数据和 LLM 增强生成。

### 5. `prerequisite_rules.json`
-   **用途**: 任务前置条件规则库。
-   **内容**: 定义了执行某类任务前必须满足的条件。例如，"挖掘铁矿" 需要 "石镐或更高级的镐"。

### 6. `tag_recipes.json`
-   **用途**: 基于标签的通用合成配方。
-   **内容**: 补充标准配方，允许使用通用材料（如 `planks` 而非特定木板）进行合成规划。

## 作用机制

这些数据文件在系统启动时被加载：
-   `JsonKnowledgeBase` 读取 `mc_knowledge_base.json`。
-   `TaskPlanner` 和 `PrerequisiteResolver` 使用 `prerequisite_rules.json` 进行任务分解。
-   LLM 的 System Prompt 会注入 `behavior_hints.txt` 的内容。

## 维护说明

-   修改 JSON 文件时请确保格式正确。
-   `mc_knowledge_base.json` 建议通过脚本更新，而非手动大量编辑。
