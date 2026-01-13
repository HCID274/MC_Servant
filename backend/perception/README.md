# Perception System (感知系统)

`backend/perception/` 模块赋予 Bot "看" 和 "理解" 环境的能力。

## 🌟 核心组件

### 1. KnowledgeBase (知识库)
位于 `knowledge_base.py`。
这是一个语义化的 Minecraft 数据库。它不仅包含物品 ID，还包含物品的语义标签。
-   **数据来源**: `minecraft-data` 库 + 预处理脚本。
-   **功能**: 支持通过自然语言标签查找物品（例如 "燃料" -> coal, log, plank）。
-   **容错**: 加载数据时具备容错机制，文件丢失或损坏时会记录错误并返回空结构，避免崩溃。

### 2. MineflayerScanner (扫描器)
位于 `scanner.py`。
基于 Mineflayer 的 `findBlocks` API，但增加了语义增强。
-   **动态标签解析**: 它不扫描硬编码的 ID，而是先查询 `KnowledgeBase` 获取标签对应的所有 Block ID，然后进行扫描。
-   **范围控制**: 默认扫描半径，支持动态扩展。

### 3. EntityResolver (实体解析器)
用于查找和识别附近的实体（玩家、生物、掉落物）。
-   **渐进式扫描**: 采用由近及远（如 32 -> 64 格）的策略，优先关注近处目标。

## 🧠 语义感知流程

当用户说 "去砍点树"：
1.  LLM 解析意图为 `Gather(target="log")`。
2.  `KnowledgeBase` 解析 "log" -> `[oak_log, birch_log, spruce_log, ...]`.
3.  `MineflayerScanner` 在周围寻找上述任意 ID 的方块。
4.  返回最近的一个坐标给 Bot。
