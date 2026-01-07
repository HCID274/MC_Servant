# Perception 模块文档

`backend/perception/` 目录构建了 Bot 的感知系统，负责收集和处理游戏世界的环境数据。

## 核心组件

### 1. `interfaces.py` - 接口定义
-   `IScanner`: 定义了扫描方块和实体的标准异步接口。
-   `ScanResult`: 定义了统一的扫描结果数据结构 (位置、距离、元数据)。

### 2. `scanner.py` - 扫描器实现
-   `MineflayerScanner`: 封装 Mineflayer API (`findBlocks`, `entities`)。
    -   **功能**:
        -   扫描指定类型的方块（按距离排序）。
        -   扫描指定类型的实体（支持 `player`, `mob` 等类别）。
        -   **LocalPerception**: 提供 `get_environment_summary` 方法，生成周围环境的自然语言摘要（Top-N 资源），用于 LLM 的 Context 构建。
-   `MockScanner`: 用于单元测试的模拟实现。

### 3. `knowledge_base.py` - 知识库访问
-   `JsonKnowledgeBase`: 封装对 `backend/data/mc_knowledge_base.json` 的读取。
    -   提供根据 Tag（如 `logs`, `ores`）查询方块 ID 的能力。
    -   提供获取物品属性（如工具等级）的接口。

### 4. `resolver.py` - 实体解析 (EntityResolver)
-   **职责**: 将模糊的自然语言描述（如 "nearby tree"）解析为具体的游戏内实体或坐标。
-   **策略**: 使用渐进式扫描 (Progressive Scanning)，先小范围 (32格) 扫描，若无结果再扩大范围 (64格)，平衡性能与覆盖面。

### 5. `inventory.py` - 背包管理
-   封装 Bot 的背包操作与查询。

### 6. `local_perception.py`
-   (该文件可能与 `scanner.py` 中的功能有重叠或作为更高层的封装，具体视代码内容而定，目前看来 `scanner.py` 承担了主要职责)。

## 设计理念

感知层旨在将底层的 Minecraft 数据（方块 ID、坐标数值）转换为对 LLM 友好的语义信息（"附近有 15 个橡木原木，距离 3 米"）。
