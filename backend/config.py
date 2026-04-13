# MC_Servant Backend Configuration (Minimal)

from typing import Optional

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """全局配置中心：定义从环境变量或 .env 加载的系统运行参数。"""
    # WebSocket server
    ws_host: str = "0.0.0.0"
    ws_port: int = 8765
    ws_access_token: str = ""
    ws_heartbeat_timeout_seconds: int = 60
    ws_inbound_queue_maxsize: int = 128

    # Minecraft server
    mc_host: str = "127.0.0.1"
    mc_port: int = 25565
    mc_version: str = "1.20.6"

    # Bot
    bot_username: str = "MCServant_Bot"
    bot_password: Optional[str] = None

    # Logging
    log_level: str = "INFO"
    trace_enabled: bool = True
    trace_db_path: str = "runtime/agent_trace.sqlite"
    trace_llm_text_log_enabled: bool = True
    trace_llm_text_log_path: str = "runtime/llm_transcripts.log"
    checkpoint_db_path: str = "runtime/langgraph_checkpoints.sqlite"
    workflow_version: str = "main_workflow_v1"
    graph_invoke_timeout_seconds: float = 60.0
    trace_interrupt_after: str = ""

    # LLM
    llm_provider: str = "openai"
    llm_model: str = "qwen3.5-2b"
    llm_base_url: str = "http://127.0.0.1:8000/v1"
    llm_api_key: str = "EMPTY"
    gemini_model: str = "gemini-3-flash-preview"
    gemini_api_key: str = ""
    llm_max_retries: int = 1
    llm_temperature_router: float = 0.4
    llm_temperature_planner: float = 0.3
    llm_temperature_summary: float = 0.2

    model_config = SettingsConfigDict(
        env_prefix="MC_SERVANT_",
        env_file=".env",
    )


settings = Settings()
