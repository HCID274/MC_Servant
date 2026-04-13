import json
from functools import lru_cache
from pathlib import Path
from typing import Any, Optional


BASE_DIR = Path(__file__).resolve().parent
TARGET_MAPPINGS_PATH = BASE_DIR / "data" / "target_mappings.json"
RESOURCE_PROFILES_PATH = BASE_DIR / "data" / "resource_profiles.json"


def _normalize_name(value: Any) -> str:
    """语义归一化：统一所有外部输入的目标名称为小写、去空格格式，确保映射一致性。"""
    return str(value or "").strip().lower()


class DomainRegistry:
    """领域注册中心：集中维护 MC 世界中静态物体（目标、资源、采集策略）的语义对齐与配置解析。"""

    def target_alias_map(self) -> dict[str, str]:
        """别名映射：将模糊或多义的外部输入（如“木头”）解析为确定的游戏内部 ID。"""
        payload = self._read_json(TARGET_MAPPINGS_PATH)
        aliases = payload.get("aliases") if isinstance(payload, dict) else {}
        if not isinstance(aliases, dict):
            return {}

        normalized: dict[str, str] = {}
        for alias, target in aliases.items():
            alias_name = _normalize_name(alias)
            target_name = _normalize_name(target)
            if alias_name and target_name:
                normalized[alias_name] = target_name
        return normalized

    def resource_profiles(self) -> dict[str, dict[str, Any]]:
        """策略索引：检索特定资源的物理属性及其对应的采集/导航 Profile。"""
        payload = self._read_json(RESOURCE_PROFILES_PATH)
        raw_resource_keys = payload.get("resource_keys") if isinstance(payload, dict) else {}
        if not isinstance(raw_resource_keys, dict):
            return {}

        normalized: dict[str, dict[str, Any]] = {}
        for resource_key, config in raw_resource_keys.items():
            resource_name = _normalize_name(resource_key)
            if not resource_name or not isinstance(config, dict):
                continue
            normalized[resource_name] = dict(config)
        return normalized

    def resource_profile_name(self, target_name: str) -> Optional[str]:
        """语义映射：根据目标物体名称定位其应匹配的物理执行配置名。"""
        config = self.resource_profiles().get(_normalize_name(target_name)) or {}
        profile = _normalize_name(config.get("profile"))
        return profile or None

    @staticmethod
    def _read_json(path: Path) -> Any:
        """底层加载：实现线程安全的 JSON 静态资源读取。"""
        if not path.exists():
            return {}
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}


@lru_cache(maxsize=1)
def get_domain_registry() -> DomainRegistry:
    """单例访问：全系统共享唯一的领域配置实例，降低 IO 压力。"""
    return DomainRegistry()
