# LLM Infrastructure (大模型设施)

`backend/llm/` 模块负责与大语言模型 (LLM) 的交互。它是 Agent 的"大脑"核心。

## 🌟 核心组件

### 1. LLM Factory (工厂模式)
位于 `factory.py`。
根据环境变量 `MC_SERVANT_LLM_PROVIDER` 动态实例化不同的 LLM 客户端。
支持的 Provider:
-   `openai`: OpenAI (GPT-3.5/4)。
-   `azure`: Azure OpenAI。
-   `anthropic`: Claude 系列。
-   `custom`: 兼容 OpenAI 接口的自定义模型（如 DeepSeek, Qwen）。

### 2. Context Manager (上下文管理)
位于 `context_manager.py`。
为了防止 LLM 上下文溢出 (Context Window Exceeded)，该模块负责：
-   **Token Counting**: 计算当前对话的 Token 数量。
-   **Trimming**: 当超过 `llm_max_context_tokens` 限制时，智能修剪最旧的消息，保留 System Prompt 和最新的几轮对话。

### 3. Prompt Management
位于 `prompts/` (通常在 `backend/task/prompts/` 或 `backend/data/`)。
管理所有的 System Prompt 和 Task Prompt。

## ⚙️ 配置

在 `.env` 中配置：

```ini
MC_SERVANT_LLM_PROVIDER=openai
OPENAI_API_KEY=sk-xxxx
OPENAI_MODEL_NAME=gpt-4o
LLM_MAX_CONTEXT_TOKENS=8000
```
