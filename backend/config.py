# MC_Servant Backend Configuration

from pydantic_settings import BaseSettings, SettingsConfigDict
from typing import Optional


class Settings(BaseSettings):
    """
    配置管理 - 简单接口，深度功能
    
    使用 pydantic-settings 自动从环境变量加载配置
    """
    
    # WebSocket 服务器配置
    ws_host: str = "0.0.0.0"
    ws_port: int = 8765
    
    # Minecraft 服务器配置 (通过 Velocity 代理连接)
    mc_host: str = "mc.hcid274.xyz"
    mc_port: int = 25565
    mc_jar_path: str = ""  # Paper/Spigot 服务端 jar 路径，用于读取中文名
    
    # Bot 配置
    bot_username: str = "MCServant_Bot"
    bot_password: Optional[str] = None  # AuthMe 密码，必须通过环境变量配置
    
    # 日志级别
    log_level: str = "DEBUG"
    
    # LLM 配置 (OpenAI Compatible API - 通义千问)
    openai_api_key: str = ""  # DashScope API Key (格式: sk-xxxxxxxx)
    openai_base_url: str = "https://dashscope.aliyuncs.com/compatible-mode/v1"
    openai_model: str = "qwen-flash"  # 默认使用 qwen-flash (速度快、成本低)
    
    # LLM 配置 (OpenRouter)
    openrouter_api_key: str = ""
    openrouter_base_url: str = "https://openrouter.ai/api/v1"
    openrouter_model: str = ""  # 单一模型 (为空时使用 openrouter_models)
    openrouter_models: str = ""  # 逗号分隔的模型列表
    openrouter_reasoning_enabled: bool = False
    
    # LLM Router 配置
    llm_provider: str = "auto"  # auto | qwen | openrouter | weighted
    llm_qwen_weight: int = 1
    llm_openrouter_weight: int = 1
    llm_call_log_path: str = "logs/llm_calls.log"
    llm_preflight_enabled: bool = False
    llm_preflight_fail_fast: bool = False
    llm_preflight_timeout_seconds: int = 15

    # WebSocket 安全配置
    ws_access_token: str = ""  # WebSocket 访问 Token（必填）
    # 心跳超时阈值（秒）
    # 说明：Java 侧通常 30s 一次心跳/WS ping，服务端也用 30s 容易被抖动/短暂卡顿误杀
    ws_heartbeat_timeout_seconds: int = 60
    ws_client_queue_size: int = 200  # 每个 WS 客户端的业务消息队列上限（心跳不入队）
    ws_thinking_hologram_min_interval_seconds: float = 1.5  # “思考中”全息提示的最小间隔，防刷屏

    # LLM 超时配置（秒）
    # - intent：必须快，超时就降级到规则匹配
    # - chat：闲聊可以更慢一点
    # - compression：记忆压缩后台跑，允许更久，但必须可超时/可降级
    llm_intent_timeout_seconds: float = 5.0
    llm_chat_timeout_seconds: float = 20.0
    llm_compression_timeout_seconds: float = 25.0
    llm_http_timeout_seconds: float = 30.0  # HTTP 层兜底（给 AsyncOpenAI/httpx）

    # UniversalRunner 实验性开关
    use_universal_runner: bool = True  # Phase 3+ 新架构 (UniversalRunner + LLM Recovery)
    
    # PostgreSQL 数据库配置
    db_host: str = "localhost"
    db_port: int = 5432
    db_user: str = "postgres"
    db_password: str = ""  # 从环境变量加载
    db_name: str = "mc_servant"
    db_echo: bool = False  # 是否打印 SQL 语句
    
    @property
    def database_url(self) -> str:
        """构建 asyncpg 连接 URL"""
        return f"postgresql+asyncpg://{self.db_user}:{self.db_password}@{self.db_host}:{self.db_port}/{self.db_name}"
    
    model_config = SettingsConfigDict(
        env_prefix="MC_SERVANT_",
        env_file=".env",
    )


# 全局配置实例
settings = Settings()
