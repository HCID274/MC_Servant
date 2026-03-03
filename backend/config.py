# MC_Servant Backend Configuration (Minimal)

from typing import Optional

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # WebSocket server
    ws_host: str = "0.0.0.0"
    ws_port: int = 8765
    ws_access_token: str = ""
    ws_heartbeat_timeout_seconds: int = 60

    # Minecraft server
    mc_host: str = "127.0.0.1"
    mc_port: int = 25565

    # Bot
    bot_username: str = "MCServant_Bot"
    bot_password: Optional[str] = None

    # Logging
    log_level: str = "INFO"

    model_config = SettingsConfigDict(
        env_prefix="MC_SERVANT_",
        env_file=".env",
    )


settings = Settings()
