# Scripts 目录文档

`scripts/` 目录包含项目维护、数据生成和辅助任务的脚本。

## 文件列表

### 1. `build_knowledge_base.py`
-   **用途**: 构建 Minecraft 静态知识库 (`backend/data/mc_knowledge_base.json`)。
-   **原理**:
    -   从 `minecraft-data` (npm 包) 提取指定版本的原始物品和方块 ID。
    -   **Regex 分类**: 使用预定义的正则表达式规则对物品进行初步分类（覆盖 ~80%）。
    -   **LLM 分类** (可选): 调用 LLM (如 Qwen) 对剩余未分类物品进行语义补全。
    -   **聚合**: 生成反向索引 (ID -> Tags) 和高级聚合标签 (如 `weapons` 包含 `swords`, `bows`)。
    -   **别名映射**: 注入中文别名，支持 "砍树", "挖矿" 等自然语言指令的解析。
-   **输出**: 生成 `mc_knowledge_base.json` (供 Bot 使用) 和 `audit_report.md` (供人工审核)。
-   **运行方式**: `python scripts/build_knowledge_base.py --use-llm`

## 设计理念

使用脚本自动化生成知识库，保证了数据源（ID 列表）的准确性，避免了 LLM 幻觉生成不存在的物品 ID，同时利用 LLM 的语义理解能力完成繁琐的分类工作。
