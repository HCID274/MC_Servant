# Scripts & Tools (工具脚本)

`scripts/` 目录包含用于辅助开发、数据处理和维护的实用脚本。

## 🛠️ 脚本列表

### `build_knowledge_base.py`
**用途**: 构建和更新语义知识库 (`backend/data/mc_knowledge_base.json`)。

**工作原理**:
这是一个混合策略脚本，旨在将 Minecraft 的原始数据转化为 LLM 可理解的语义数据。
1.  **数据源**: 从 `minecraft-data` 获取所有物品和方块的列表。
2.  **Regex 匹配**: 使用正则表达式进行初步分类（如所有含 "log" 的归为 "wood"）。
3.  **LLM 增强**: 对于无法通过正则归类的物品，调用 LLM API 生成语义标签。
4.  **输出**: 生成 JSON 格式的知识库，供 `backend/perception/knowledge_base.py` 使用。

**用法**:
```bash
python scripts/build_knowledge_base.py
```

---

## 📂 00Docs/

`00Docs/` 目录存放项目的详细设计文档和历史记录：
-   `00基础架构.md`: 早期架构设计草稿。
-   `01开发进度安排.md`: 开发里程碑记录。
-   `02项目的掉转船头方向.md`: 关于项目从商业化转向 MVP 展示的决策记录。
