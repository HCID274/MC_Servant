from typing import Any, Dict


class EnvClient:
    """
    机器人的“眼睛”。
    它负责去游戏里看一圈，把周围有什么方块、有什么生物的信息抓取回来。
    大脑（LLM）需要通过它来了解外面的世界，才能做出“去挖那一块煤矿”这样的决定。
    """

    def get_snapshot(self, _: str) -> Dict[str, Any]:
        """
        获取环境快照（骨架占位）。
        """
        raise NotImplementedError("TODO: 在翻译层封装环境查询调用")

