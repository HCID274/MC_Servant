# Prerequisite Resolver
# 符号层前置任务解析器 - Neuro-Symbolic 架构的 Symbolic 组件

import json
import logging
import math
from pathlib import Path
from typing import Dict, Any, Optional, List, Union

from .interfaces import StackTask, TaskStatus, IPrerequisiteResolver


logger = logging.getLogger(__name__)


class PrerequisiteResolver(IPrerequisiteResolver):
    """
    符号层前置任务解析器
    
    职责：
    - 根据错误码推断需要的前置任务
    - 使用静态规则库进行确定性推理
    - 这是 Fast Path，不调用 LLM
    
    处理的错误码：
    - INSUFFICIENT_MATERIALS: 材料不足 → 尝试合成/采集
    - NO_TOOL: 没有合适工具 → 尝试合成工具
    
    设计原则：
    - 确定性问题用符号规则
    - 返回 None 表示交给 LLM (Slow Path)
    """
    
    def __init__(self, rules_path: Optional[str] = None):
        """
        初始化解析器
        
        Args:
            rules_path: 规则库路径，默认 data/prerequisite_rules.json
        """
        if rules_path is None:
            rules_path = Path(__file__).parent.parent / "data" / "prerequisite_rules.json"
        
        self._rules = self._load_rules(rules_path)
        self._tag_index = self._build_tag_index()
        logger.info(f"PrerequisiteResolver initialized with {len(self._rules.get('craftable_items', {}))} crafting rules")
    
    def _load_rules(self, path: Union[str, Path]) -> Dict[str, Any]:
        """加载规则库"""
        try:
            with open(path, 'r', encoding='utf-8') as f:
                return json.load(f)
        except FileNotFoundError:
            logger.warning(f"Rules file not found: {path}, using empty rules")
            return {}
        except json.JSONDecodeError as e:
            logger.error(f"Failed to parse rules file: {e}")
            return {}
    
    def _build_tag_index(self) -> Dict[str, str]:
        """
        构建反向索引: item_name -> tag_name
        
        例如: {"oak_planks": "planks", "birch_planks": "planks", ...}
        """
        index = {}
        for tag_name, items in self._rules.get("tag_equivalents", {}).items():
            if tag_name.startswith("_"):
                continue
            for item in items:
                index[item] = tag_name
        return index
    
    def resolve(
        self,
        error_code: str,
        context: Dict[str, Any],
        inventory: Dict[str, int]
    ) -> Optional[StackTask]:
        """
        解析前置任务
        
        Args:
            error_code: 错误码
            context: 错误上下文 (如 {"missing": {"oak_planks": 2}, "item": "stick"})
            inventory: 当前背包内容
            
        Returns:
            StackTask: 需要先完成的前置任务
            None: 符号层无法解决
        """
        logger.debug(f"Resolving prerequisite for error: {error_code}, context: {context}")
        
        if error_code == "INSUFFICIENT_MATERIALS":
            return self._resolve_missing_materials(context, inventory)
        
        if error_code == "NO_TOOL":
            return self._resolve_missing_tool(context, inventory)
        
        # 其他错误码交给 LLM
        logger.debug(f"Cannot resolve error code '{error_code}' symbolically")
        return None
    
    def _resolve_missing_materials(
        self, 
        context: Dict[str, Any],
        inventory: Dict[str, int]
    ) -> Optional[StackTask]:
        """
        解析材料不足的前置任务
        
        优先级：
        1. 如果材料可以合成 → 返回合成任务
        2. 如果材料可以采集 → 返回采集任务
        3. 否则返回 None (交给 LLM)
        """
        missing = context.get("missing", {})
        if not missing:
            return None
        
        # 取第一个缺失的材料
        item_name, required_count = next(iter(missing.items()))
        
        # 检查是否为 Tag (如 "planks")，尝试解析为具体物品
        concrete_item = self._resolve_tag_to_concrete(item_name, inventory)
        if concrete_item != item_name:
            logger.debug(f"Resolved tag '{item_name}' to concrete item '{concrete_item}'")
            item_name = concrete_item

        # 泛化兜底（高优先级）：对常见命名规律直接推导前置任务，降低规则库维护成本
        inferred = self._infer_generic_prerequisite(item_name=item_name, need=required_count, inventory=inventory)
        if inferred:
            return inferred
        
        # 尝试合成
        craft_task = self._try_craft_prerequisite(item_name, required_count)
        if craft_task:
            return craft_task
        
        # 尝试采集
        mine_task = self._try_mine_prerequisite(item_name, required_count)
        if mine_task:
            return mine_task
        
        logger.debug(f"Cannot resolve missing material '{item_name}' symbolically")
        return None
    
    def _resolve_tag_to_concrete(self, tag_or_item: str, inventory: Dict[str, int]) -> str:
        """
        将 Tag 解析为具体物品
        
        优先使用背包中已有的等价物品，否则返回列表中第一个
        """
        tag_items = self._rules.get("tag_equivalents", {}).get(tag_or_item, [])
        if not tag_items:
            return tag_or_item
        
        # 优先使用背包中已有的
        for item in tag_items:
            if inventory.get(item, 0) > 0:
                return item
        
        # 否则返回第一个
        return tag_items[0]
    
    def _try_craft_prerequisite(self, item_name: str, count: int) -> Optional[StackTask]:
        """尝试创建合成任务"""
        craftable = self._rules.get("craftable_items", {})
        
        if item_name in craftable:
            recipe = craftable[item_name]
            # 计算需要合成的次数
            output_count = recipe.get("output_count", 1)
            craft_count = (count + output_count - 1) // output_count
            
            return StackTask(
                name=f"合成 {item_name} x{craft_count * output_count}",
                goal=f"craft {item_name} {craft_count}",
                context={"source": "prerequisite", "original_need": count},
                status=TaskStatus.PENDING
            )

        # ----------------------------
        # 泛化兜底：无需手写每个版本的木头/木板规则
        # 例：cherry_planks -> craft cherry_planks（默认 4/次），其材料可由 cherry_log/cherry_stem 推导
        # ----------------------------
        inferred = self._infer_generic_craft(item_name=item_name, need=count)
        if inferred:
            return inferred
        
        return None
    
    def _try_mine_prerequisite(self, item_name: str, count: int) -> Optional[StackTask]:
        """尝试创建采集任务"""
        mineable = self._rules.get("mineable_blocks", {})
        
        # 直接匹配
        if item_name in mineable:
            return StackTask(
                name=f"采集 {item_name} x{count}",
                goal=f"mine {item_name} {count}",
                context={"source": "prerequisite"},
                status=TaskStatus.PENDING
            )
        
        # 反向匹配 (drops -> block)
        for block_name, info in mineable.items():
            if info.get("drops") == item_name:
                return StackTask(
                    name=f"采集 {block_name} x{count}",
                    goal=f"mine {block_name} {count}",
                    context={"source": "prerequisite", "target_drop": item_name},
                    status=TaskStatus.PENDING
                )

        # 泛化兜底：log/stem 缺失时，直接尝试采集（即使规则库未收录）
        if item_name.endswith("_log") or item_name.endswith("_stem"):
            return StackTask(
                name=f"采集 {item_name} x{count}",
                goal=f"mine {item_name} {count}",
                context={"source": "prerequisite", "inferred": True},
                status=TaskStatus.PENDING
            )
        
        return None

    # ======================================================================
    # Generic inference (fuzzy rules)
    # ======================================================================

    def _infer_generic_craft(self, item_name: str, need: int) -> Optional[StackTask]:
        """
        当规则库缺少明确 craftable_items 时，尝试用稳定的命名规律推导。

        当前覆盖：
        - *_planks: 4/次
        - *_slab: 6/次
        - *_stairs: 4/次
        - *_fence: 3/次
        - *_fence_gate: 1/次
        - *_door: 3/次
        - *_trapdoor: 2/次
        - *_button: 1/次
        - *_pressure_plate: 1/次

        注意：此处只生成“合成缺失物品”的任务，材料不足会在下一轮错误中继续被推导。
        """
        if need <= 0:
            return None

        # 输出数量启发式（只影响 craft 次数，不影响材料计算）
        output_map = {
            "_planks": 4,
            "_slab": 6,
            "_stairs": 4,
            "_fence": 3,
            "_fence_gate": 1,
            "_door": 3,
            "_trapdoor": 2,
            "_button": 1,
            "_pressure_plate": 1,
        }

        for suffix, output_count in output_map.items():
            if item_name.endswith(suffix):
                craft_count = int(math.ceil(need / output_count))
                return StackTask(
                    name=f"合成 {item_name} x{craft_count * output_count}",
                    goal=f"craft {item_name} {craft_count}",
                    context={"source": "prerequisite", "original_need": need, "inferred": True},
                    status=TaskStatus.PENDING,
                )

        return None

    def _infer_generic_prerequisite(self, item_name: str, need: int, inventory: Dict[str, int]) -> Optional[StackTask]:
        """
        更高层的泛化推导：根据缺失物品与背包现状，直接给出“最可能正确”的前置任务。

        目标：减少“先 craft 再失败一轮”的震荡。
        """
        if need <= 0:
            return None

        # 1) 木板缺失：优先判断是否有同源 log/stem；没有就直接去采集 log/stem
        if item_name.endswith("_planks"):
            base = item_name[: -len("_planks")]

            # 特殊：下界木头用 stem；其余默认 log
            prefer_stem = base in ("crimson", "warped")
            source_ids = ([f"{base}_stem", f"{base}_log"] if prefer_stem else [f"{base}_log", f"{base}_stem"])

            # 如果背包已有任一来源（log/stem），直接合成木板（4/次）
            if any(inventory.get(src, 0) > 0 for src in source_ids):
                return self._infer_generic_craft(item_name=item_name, need=need)

            # 否则直接采集对应来源：按 4/次反推需要的 log/stem 数量
            src = source_ids[0]
            mine_count = int(math.ceil(need / 4))
            return StackTask(
                name=f"采集 {src} x{mine_count}",
                goal=f"mine {src} {mine_count}",
                context={"source": "prerequisite", "target": item_name, "original_need": need, "inferred": True},
                status=TaskStatus.PENDING,
            )

        # 2) 其他木制衍生物：优先返回 craft（Mineflayer 会给出具体配方变体）
        if any(item_name.endswith(s) for s in (
            "_slab", "_stairs", "_fence", "_fence_gate", "_door", "_trapdoor", "_button", "_pressure_plate"
        )):
            return self._infer_generic_craft(item_name=item_name, need=need)

        return None
    
    def _resolve_missing_tool(
        self,
        context: Dict[str, Any],
        inventory: Dict[str, int]
    ) -> Optional[StackTask]:
        """
        解析工具缺失的前置任务
        
        根据需要的工具类型，尝试合成一个够用的工具
        """
        tool_type = context.get("tool_type")  # 如 "pickaxe"
        min_tier = context.get("min_tier", "wooden")  # 如 "stone"
        
        if not tool_type:
            return None
        
        # 获取工具列表
        tool_list = self._rules.get("tag_equivalents", {}).get(tool_type, [])
        if not tool_list:
            return None
        
        # 找到满足最低等级的工具
        tier_order = self._rules.get("tool_tiers", {}).get("order", [])
        min_tier_idx = tier_order.index(min_tier) if min_tier in tier_order else 0
        
        for tool in tool_list:
            # 检查工具等级
            tool_tier = None
            for tier in tier_order:
                if tool.startswith(tier):
                    tool_tier = tier
                    break
            
            if tool_tier and tier_order.index(tool_tier) >= min_tier_idx:
                # 检查是否可以合成
                if tool in self._rules.get("craftable_items", {}):
                    return StackTask(
                        name=f"合成 {tool}",
                        goal=f"craft {tool} 1",
                        context={"source": "prerequisite", "for_mining": True},
                        status=TaskStatus.PENDING
                    )
        
        return None
    
    def get_craftable_items(self) -> List[str]:
        """获取所有可合成物品列表"""
        return [k for k in self._rules.get("craftable_items", {}).keys() 
                if not k.startswith("_")]
    
    def get_mineable_blocks(self) -> List[str]:
        """获取所有可采集方块列表"""
        return [k for k in self._rules.get("mineable_blocks", {}).keys()
                if not k.startswith("_")]
    
    def is_craftable(self, item_name: str) -> bool:
        """检查物品是否可合成"""
        return item_name in self._rules.get("craftable_items", {})
    
    def is_mineable(self, block_name: str) -> bool:
        """检查方块是否可采集"""
        return block_name in self._rules.get("mineable_blocks", {})
