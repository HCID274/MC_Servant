from typing import Any, Dict


class EnvClient:
    """感知组件：负责从游戏环境中抓取方块与实体快照，为 LLM 提供决策依据。"""

    def get_snapshot(self, _: str) -> Dict[str, Any]:
        """
        获取环境快照（骨架占位）。
        """
        raise NotImplementedError("TODO: 在翻译层封装环境查询调用")


def translate_chat_step(step: Dict[str, Any]) -> Dict[str, Any]:
    """语义对齐：将 LLM 的相对语义目标（如：主人前方）映射为执行端的物理动作。"""
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
                "command": "look_at_eyes",
                "entity": "master",
                "height_offset": 1.6  # 玩家眼睛的大致高度 (Y轴偏移)
            }

    # 如果是无法翻译的动作（比如 speak），原样返回让上层处理
    return step
