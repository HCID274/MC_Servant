# Entity Resolver - 神经符号语义解析系统核心
#
# 职责:
# - 将 LLM 输出的语义概念映射到具体的 Minecraft ID
# - 与 Bot 的环境感知取交集
# - 返回实际可操作的目标
#
# 设计原则:
# - 简单的接口，深度的功能
# - 依赖抽象，而非具体
# - 被动反馈 (Pure Calculation)，决策权上移

import logging
from typing import List, Optional, Tuple

from bot.drivers.interfaces import IDriverAdapter
from dataclasses import dataclass

from .interfaces import (
    IKnowledgeBase,
    IScanner,
    IInventoryProvider,
    ResolveStatus,
    ResolveResult,
    ScanResult,
)

logger = logging.getLogger(__name__)


@dataclass
class SearchConfig:
    """
    渐进式搜索配置
    
    设计决策:
    - 默认搜索半径序列: [32, 64]
    - 可配置，适应不同场景
    """
    radii: Tuple[int, ...] = (32, 64)
    """搜索半径序列，按顺序尝试"""
    
    max_results_per_radius: int = 64
    """每个半径返回的最大结果数"""


class EntityResolver:
    """
    实体解析器 - 神经符号架构的符号层
    
    核心流程:
    1. resolve_alias(concept) -> 标准化概念名
    2. get_candidates(concept) -> 候选 ID 列表 (KB 优先)
    3. if empty: validate_ids(llm_candidates) -> LLM 补位
    4. if still empty: return UNKNOWN_CONCEPT
    5. if check_inventory: 检查背包 -> 找到则返回
    6. if search_world: 渐进式扫描 (32 -> 64)
    7. 返回 ResolveResult
    
    设计决策:
    - KB 绝对优先，LLM 仅补位 (确定性 > 概率性)
    - 被动反馈，不主动发消息
    - 默认优先检查背包 (省力原则)
    """
    
    def __init__(
        self,
        knowledge_base: IKnowledgeBase,
        scanner: IScanner,
        inventory: IInventoryProvider,
        search_config: Optional[SearchConfig] = None
    ):
        """
        初始化解析器
        
        Args:
            knowledge_base: 知识库接口
            scanner: 世界扫描器接口
            inventory: 背包查询接口
            search_config: 搜索配置 (可选)
        """
        self._kb = knowledge_base
        self._scanner = scanner
        self._inventory = inventory
        self._config = search_config or SearchConfig()
    
    async def resolve(
        self,
        concept: str,
        llm_candidates: Optional[List[str]] = None,
        check_inventory: bool = True,
        search_world: bool = True,
        target_type: str = "block"
    ) -> ResolveResult:
        """
        核心解析方法 - 将语义概念映射到可操作的目标
        
        Args:
            concept: 语义概念 (如 "木头", "wood", "logs", "oak_log")
            llm_candidates: LLM 提供的候选 ID 列表 (fallback)
            check_inventory: 是否检查背包 (默认 True)
            search_world: 是否搜索世界 (默认 True)
            target_type: 目标类型 "block" | "entity" (默认 "block")
            
        Returns:
            ResolveResult 包含解析状态和结果
        """
        candidates_tried: List[str] = []
        source = ""
        
        # ================================================================
        # Step 1: 解析别名
        # ================================================================
        resolved_concept = self._kb.resolve_alias(concept)
        logger.debug(f"[Resolver] Alias resolved: '{concept}' -> '{resolved_concept}'")
        
        # ================================================================
        # Step 2: 从知识库获取候选 (KB 优先)
        # ================================================================
        candidates = self._kb.get_candidates(resolved_concept)
        
        if candidates:
            source = "knowledge_base"
            logger.debug(f"[Resolver] KB candidates: {candidates[:5]}...")
        else:
            # ============================================================
            # Step 3: KB 为空，使用 LLM 补位
            # ============================================================
            if llm_candidates:
                candidates = self._kb.validate_ids(llm_candidates)
                if candidates:
                    source = "llm_fallback"
                    logger.debug(f"[Resolver] LLM fallback candidates: {candidates}")
                else:
                    # LLM 给的全部不合法
                    return ResolveResult(
                        success=False,
                        status=ResolveStatus.INVALID_CANDIDATES,
                        candidates_tried=llm_candidates,
                        message=f"LLM 提供的候选 ID 都不合法: {llm_candidates}"
                    )
        
        # ================================================================
        # Step 4: 候选集仍为空 -> UNKNOWN_CONCEPT
        # ================================================================
        if not candidates:
            return ResolveResult(
                success=False,
                status=ResolveStatus.UNKNOWN_CONCEPT,
                candidates_tried=[concept],
                message=f"无法识别的概念: '{concept}'，知识库和 LLM 都无法解析"
            )
        
        candidates_tried = candidates.copy()
        
        # ================================================================
        # Step 5: 检查背包 (默认优先，可跳过)
        # ================================================================
        if check_inventory:
            inventory_result = self._check_inventory(candidates)
            if inventory_result:
                return ResolveResult(
                    success=True,
                    status=ResolveStatus.SUCCESS,
                    target_id=inventory_result,
                    source="inventory",
                    candidates_tried=candidates_tried,
                    message=f"在背包中找到 {inventory_result}"
                )
        
        # ================================================================
        # Step 6: 渐进式世界扫描 (32 -> 64)
        # ================================================================
        if search_world:
            scan_result, final_radius = await self._progressive_scan(
                candidates, 
                target_type
            )
            
            if scan_result:
                return ResolveResult(
                    success=True,
                    status=ResolveStatus.SUCCESS,
                    target_id=scan_result.id,
                    source="world",
                    position=scan_result.position,
                    candidates_tried=candidates_tried,
                    search_radius=final_radius,
                    message=f"在 {final_radius} 格内找到 {scan_result.id}，距离 {scan_result.distance:.1f} 格"
                )
            
            # 世界里没找到
            if check_inventory:
                # 背包和世界都没有
                return ResolveResult(
                    success=False,
                    status=ResolveStatus.NOT_FOUND_ANYWHERE,
                    candidates_tried=candidates_tried,
                    search_radius=self._config.radii[-1],
                    message=f"在 {self._config.radii[-1]} 格内没有找到 {resolved_concept}，背包中也没有"
                )
            else:
                return ResolveResult(
                    success=False,
                    status=ResolveStatus.NOT_FOUND_IN_WORLD,
                    candidates_tried=candidates_tried,
                    search_radius=self._config.radii[-1],
                    message=f"在 {self._config.radii[-1]} 格内没有找到 {resolved_concept}"
                )
        
        # ================================================================
        # Step 7: 不搜索世界，只检查背包，但背包没有
        # ================================================================
        if check_inventory:
            return ResolveResult(
                success=False,
                status=ResolveStatus.NOT_FOUND_IN_INVENTORY,
                candidates_tried=candidates_tried,
                message=f"背包中没有 {resolved_concept}"
            )
        
        # 既不检查背包也不搜索世界，只返回候选列表
        return ResolveResult(
            success=True,
            status=ResolveStatus.SUCCESS,
            target_id=candidates[0],  # 返回第一个候选
            source=source,
            candidates_tried=candidates_tried,
            message=f"已解析概念 '{concept}' -> 候选: {candidates[:3]}"
        )
    
    def _check_inventory(self, candidates: List[str]) -> Optional[str]:
        """
        检查背包中是否有候选物品
        
        Args:
            candidates: 候选 ID 列表
            
        Returns:
            找到的物品 ID，没有则返回 None
        """
        inventory = self._inventory.get_items()
        
        for candidate in candidates:
            if candidate in inventory and inventory[candidate] > 0:
                logger.debug(f"[Resolver] Found in inventory: {candidate} x{inventory[candidate]}")
                return candidate
        
        return None
    
    async def _progressive_scan(
        self,
        candidates: List[str],
        target_type: str
    ) -> Tuple[Optional[ScanResult], int]:
        """
        渐进式扫描 - 按半径序列依次搜索
        
        Args:
            candidates: 候选 ID 列表
            target_type: "block" | "entity"
            
        Returns:
            (最近的扫描结果, 使用的半径)
        """
        for radius in self._config.radii:
            logger.debug(f"[Resolver] Scanning {target_type}s in {radius} radius...")
            
            if target_type == "entity":
                results = await self._scanner.scan_entities(candidates, radius)
            else:
                results = await self._scanner.scan_blocks(candidates, radius)
            
            if results:
                closest = self._scanner.get_closest(results)
                if closest:
                    logger.info(
                        f"[Resolver] Found {closest.id} at {closest.position}, "
                        f"distance={closest.distance:.1f}, radius={radius}"
                    )
                    return closest, radius
        
        logger.debug(f"[Resolver] Nothing found in any radius: {self._config.radii}")
        return None, self._config.radii[-1]
    
    # ========================================================================
    # 便捷方法
    # ========================================================================
    
    async def resolve_for_mining(
        self,
        concept: str,
        llm_candidates: Optional[List[str]] = None
    ) -> ResolveResult:
        """
        为采集任务解析目标 - 只搜索世界，忽略背包
        
        Args:
            concept: 语义概念
            llm_candidates: LLM 候选
            
        Returns:
            ResolveResult
        """
        return await self.resolve(
            concept=concept,
            llm_candidates=llm_candidates,
            check_inventory=False,
            search_world=True,
            target_type="block"
        )
    
    async def resolve_for_crafting(
        self,
        concept: str,
        llm_candidates: Optional[List[str]] = None
    ) -> ResolveResult:
        """
        为合成任务解析材料 - 优先检查背包
        
        Args:
            concept: 语义概念
            llm_candidates: LLM 候选
            
        Returns:
            ResolveResult
        """
        return await self.resolve(
            concept=concept,
            llm_candidates=llm_candidates,
            check_inventory=True,
            search_world=True,
            target_type="block"
        )
    
    async def resolve_entity(
        self,
        concept: str,
        llm_candidates: Optional[List[str]] = None
    ) -> ResolveResult:
        """
        解析实体目标 (怪物、动物、玩家)
        
        Args:
            concept: 语义概念 (如 "zombie", "pig", "player")
            llm_candidates: LLM 候选
            
        Returns:
            ResolveResult
        """
        return await self.resolve(
            concept=concept,
            llm_candidates=llm_candidates,
            check_inventory=False,
            search_world=True,
            target_type="entity"
        )
    
    def get_candidates_only(self, concept: str) -> List[str]:
        """
        仅获取候选列表，不进行扫描 (同步方法)
        
        用于快速查询知识库
        
        Args:
            concept: 语义概念
            
        Returns:
            候选 ID 列表
        """
        resolved = self._kb.resolve_alias(concept)
        return self._kb.get_candidates(resolved)


# ============================================================================
# 工厂函数
# ============================================================================

def create_entity_resolver(
    driver: IDriverAdapter,
    kb_path: Optional[str] = None,
    search_radii: Tuple[int, ...] = (32, 64)
) -> EntityResolver:
    """
    创建 EntityResolver 实例的工厂函数
    
    Args:
        driver: IDriverAdapter 实例
        kb_path: 知识库路径 (可选)
        search_radii: 搜索半径序列
        
    Returns:
        配置好的 EntityResolver 实例
    """
    from .knowledge_base import JsonKnowledgeBase
    from .scanner import MineflayerScanner
    from .inventory import BotInventoryProvider
    
    kb = JsonKnowledgeBase(kb_path)
    scanner = MineflayerScanner(driver)
    inventory = BotInventoryProvider(driver)
    config = SearchConfig(radii=search_radii)
    
    return EntityResolver(
        knowledge_base=kb,
        scanner=scanner,
        inventory=inventory,
        search_config=config
    )

