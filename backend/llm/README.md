# LLM 模块文档

`backend/llm/` 目录负责与大语言模型 (Large Language Model) 进行交互，封装了 API 调用、上下文管理、提示词构建和意图识别等功能。

## 核心组件

### 1. `factory.py` - 工厂模式
-   根据环境变量 (`MC_SERVANT_LLM_PROVIDER`) 创建对应的 LLM 客户端实例（如 OpenRouter, Qwen 等）。
-   统一返回符合接口规范的客户端。

### 2. `interfaces.py` - 接口定义
-   定义了 LLM 客户端的统一接口，确保上层业务逻辑与具体模型提供商解耦。

### 3. `context_manager.py` - 上下文管理器 (核心)
-   **职责**: 管理对话历史，实施 Token 限制策略。
-   **机制**:
    -   维护对话窗口，当超出 Token 限制时，自动触发压缩逻辑。
    -   调用 `compression.py` 将旧对话总结为摘要 (L1 记忆)。
    -   负责构建包含 System Prompt、RAG 内容和对话历史的最终 Prompt。

### 4. `compression.py` - 记忆压缩
-   实现了将原始对话 (Raw Buffer) 压缩为摘要 (Episodic Memory) 的逻辑。
-   实现了将摘要进一步提炼为核心记忆 (Core Memory) 的逻辑。

### 5. `intent.py` - 意图识别
-   分析用户输入的文本，识别其意图（如 "闲聊", "指令", "查询"）。
-   提取指令中的关键参数（如 "帮我砍树" -> Action: Mine, Target: Log）。

### 6. `embedding.py` - 向量化
-   封装文本向量化 (Embedding) 接口，用于 RAG 系统的相似度检索。

## 客户端实现

-   `openrouter_client.py`: 适配 OpenRouter API (支持 Claude, GPT-4 等)。
-   `qwen_client.py`: 适配通义千问 (Qwen) API。

## 功能亮点

-   **流式输出**: 支持流式 (Streaming) 响应，提升用户体验（全息文字逐字显示）。
-   **JSON 模式**: 强制模型输出 JSON 格式，用于结构化任务规划。
-   **容错与重试**: 处理 API 超时和限流错误。
