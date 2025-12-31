# MC_Servant Backend Configuration

from pydantic_settings import BaseSettings
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
    
    # Bot 配置
    bot_username: str = "MCServant_Bot"
    bot_password: Optional[str] = "VillagerBot@2025"  # AuthMe 密码
    
    # 日志级别
    log_level: str = "INFO"
    
    # LLM 配置 (OpenAI Compatible API - 通义千问)
    openai_api_key: str = ""  # DashScope API Key (格式: sk-xxxxxxxx)
    openai_base_url: str = "https://dashscope.aliyuncs.com/compatible-mode/v1"
    openai_model: str = "qwen-flash"  # 默认使用 qwen-flash (速度快、成本低)
    
    class Config:
        env_prefix = "MC_SERVANT_"
        env_file = ".env"


# 全局配置实例
settings = Settings()
