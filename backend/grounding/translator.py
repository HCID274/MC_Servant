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


def translate_chat_step(step: Dict[str, Any]) -> Dict[str, Any]:
    """
    语义翻译官。
    将大模型给出的“模糊目标”（如：主人前面），翻译成执行端能理解的“精确指令”。
    这样设计是为了应对网络延迟，让执行端在最后一刻才计算具体的物理位置。
    """
    action = step.get("action")
    target = step.get("target")

    if action == "move_to":
        if target == "master_front":
            return {
                "command": "navigate_relative",
                "entity": "master",
                "offset_type": "front",
                "distance": 2.0  # 离主人 2 格停下
            }
        elif target == "master_side":
            return {
                "command": "navigate_relative",
                "entity": "master",
                "offset_type": "side",
                "distance": 1.5
            }

    elif action == "look_at":
        if target == "master_eyes":
            return {
                "command": "look_at_entity",
                "entity": "master",
                "height_offset": 1.6  # 玩家眼睛的大致高度 (Y轴偏移)
            }

    # 如果是无法翻译的动作（比如 speak），原样返回让上层处理
    return step
