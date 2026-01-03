# Mineflayer Scanner Implementation - 世界感知扫描器
#
# 职责:
# - 封装 Mineflayer 的方块/实体扫描能力
# - 提供统一的异步接口
# - Block 坐标转换为中心点坐标

import asyncio
import logging
from typing import List, Dict, Any, Optional

from .interfaces import IScanner, ScanResult

logger = logging.getLogger(__name__)


class MineflayerScanner(IScanner):
    """
    Mineflayer 世界扫描器实现
    
    设计决策:
    - 所有方法都是异步的 (使用 executor 执行 JS 调用)
    - Block 坐标转为中心点 (x+0.5, y, z+0.5)
    - 结果按距离排序
    
    依赖:
    - Mineflayer bot 实例 (已加载 minecraft-data)
    """
    
    def __init__(self, bot):
        """
        初始化扫描器
        
        Args:
            bot: MineflayerBot 实例 (backend/bot/mineflayer_adapter.py)
                 需要有 _bot (原始 mineflayer bot) 和 _mcData 属性
        """
        self._mf_bot = bot           # MineflayerBot wrapper
        self._bot = bot._bot         # 原始 mineflayer bot 对象
        self._mcData = bot._mcData   # minecraft-data
    
    async def scan_blocks(
        self, 
        block_ids: List[str], 
        radius: int = 32
    ) -> List[ScanResult]:
        """
        扫描指定类型的方块
        
        Args:
            block_ids: 目标方块 ID 列表 (如 ["oak_log", "birch_log"])
            radius: 扫描半径 (格)
            
        Returns:
            扫描结果列表，按距离排序
        """
        if not block_ids:
            return []
        
        results: List[ScanResult] = []
        bot_pos = self._bot.entity.position
        
        for block_id in block_ids:
            try:
                # 获取方块类型信息
                block_info = getattr(self._mcData.blocksByName, block_id, None)
                if not block_info:
                    logger.debug(f"[Scanner] Unknown block type: {block_id}")
                    continue
                
                # 使用 executor 执行同步的 findBlocks 调用
                blocks_proxy = await asyncio.get_event_loop().run_in_executor(
                    None,
                    lambda bid=block_info.id: self._bot.findBlocks({
                        "matching": bid,
                        "maxDistance": radius,
                        "count": 64  # 限制返回数量
                    })
                )
                
                # 将 JS Proxy 转换为 Python list
                blocks = list(blocks_proxy) if blocks_proxy else []
                
                for block_pos in blocks:
                    try:
                        # 计算距离
                        distance = bot_pos.distanceTo(block_pos)
                        
                        # Block 坐标转为中心点 (x+0.5, y, z+0.5)
                        # y 不加 0.5，因为 Bot 通常站在方块上方
                        center_pos = (
                            float(block_pos.x) + 0.5,
                            float(block_pos.y),
                            float(block_pos.z) + 0.5
                        )
                        
                        # 获取方块状态 (可选元数据)
                        metadata = self._get_block_metadata(block_pos)
                        
                        results.append(ScanResult(
                            id=block_id,
                            position=center_pos,
                            distance=float(distance),
                            metadata=metadata
                        ))
                        
                    except Exception as e:
                        logger.debug(f"[Scanner] Error processing block: {e}")
                        continue
                        
            except Exception as e:
                logger.warning(f"[Scanner] Error scanning for {block_id}: {e}")
                continue
        
        # 按距离排序
        results.sort(key=lambda r: r.distance)
        
        logger.debug(f"[Scanner] Found {len(results)} blocks for {block_ids} in {radius} radius")
        return results
    
    async def scan_entities(
        self, 
        entity_types: List[str], 
        radius: int = 32
    ) -> List[ScanResult]:
        """
        扫描指定类型的实体
        
        Args:
            entity_types: 目标实体类型列表 (如 ["zombie", "skeleton", "pig"])
                          特殊值: "player" 扫描玩家, "mob" 扫描所有怪物
            radius: 扫描半径 (格)
            
        Returns:
            扫描结果列表，按距离排序
        """
        if not entity_types:
            return []
        
        results: List[ScanResult] = []
        bot_pos = self._bot.entity.position
        bot_username = self._bot.username
        
        # 将 entity_types 转为小写集合，方便匹配
        target_types = {t.lower() for t in entity_types}
        scan_all_mobs = "mob" in target_types or "mobs" in target_types
        scan_players = "player" in target_types or "players" in target_types
        
        try:
            # 遍历所有实体
            entities_dict = dict(self._bot.entities) if self._bot.entities else {}
            
            for entity_id, entity in entities_dict.items():
                try:
                    # 跳过自己
                    if hasattr(entity, 'username') and entity.username == bot_username:
                        continue
                    
                    entity_name = getattr(entity, 'name', None) or getattr(entity, 'type', 'unknown')
                    entity_type = getattr(entity, 'type', 'unknown')
                    entity_name_lower = entity_name.lower() if entity_name else ''
                    
                    # 检查是否匹配
                    should_include = False
                    
                    if entity_name_lower in target_types:
                        should_include = True
                    elif scan_all_mobs and entity_type in ('mob', 'hostile'):
                        should_include = True
                    elif scan_players and entity_type == 'player':
                        should_include = True
                    
                    if not should_include:
                        continue
                    
                    # 计算距离
                    entity_pos = entity.position
                    distance = bot_pos.distanceTo(entity_pos)
                    
                    if distance > radius:
                        continue
                    
                    # 获取实体元数据
                    metadata = self._get_entity_metadata(entity)
                    
                    results.append(ScanResult(
                        id=entity_name_lower,
                        position=(
                            float(entity_pos.x),
                            float(entity_pos.y),
                            float(entity_pos.z)
                        ),
                        distance=float(distance),
                        metadata=metadata
                    ))
                    
                except Exception as e:
                    logger.debug(f"[Scanner] Error processing entity: {e}")
                    continue
                    
        except Exception as e:
            logger.warning(f"[Scanner] Error scanning entities: {e}")
        
        # 按距离排序
        results.sort(key=lambda r: r.distance)
        
        logger.debug(f"[Scanner] Found {len(results)} entities for {entity_types} in {radius} radius")
        return results
    
    def _get_block_metadata(self, block_pos) -> Dict[str, Any]:
        """
        获取方块的元数据
        
        Args:
            block_pos: 方块位置 (Vec3)
            
        Returns:
            元数据字典
        """
        metadata = {}
        
        try:
            block = self._bot.blockAt(block_pos)
            if block:
                # 方块状态 (如 facing, powered 等)
                if hasattr(block, 'stateId'):
                    metadata['state_id'] = block.stateId
                
                # 方块名称
                if hasattr(block, 'name'):
                    metadata['name'] = block.name
                
                # 硬度 (用于判断需要什么工具)
                if hasattr(block, 'hardness'):
                    metadata['hardness'] = block.hardness
                    
        except Exception as e:
            logger.debug(f"[Scanner] Error getting block metadata: {e}")
        
        return metadata
    
    def _get_entity_metadata(self, entity) -> Dict[str, Any]:
        """
        获取实体的元数据
        
        Args:
            entity: Mineflayer 实体对象
            
        Returns:
            元数据字典
        """
        metadata = {}
        
        try:
            # 实体类型
            if hasattr(entity, 'type'):
                metadata['type'] = entity.type
            
            # 生命值 (如果有)
            if hasattr(entity, 'health'):
                metadata['health'] = entity.health
            
            # 玩家名 (如果是玩家)
            if hasattr(entity, 'username'):
                metadata['username'] = entity.username
            
            # 实体 ID
            if hasattr(entity, 'id'):
                metadata['entity_id'] = entity.id
                
        except Exception as e:
            logger.debug(f"[Scanner] Error getting entity metadata: {e}")
        
        return metadata


class MockScanner(IScanner):
    """
    模拟扫描器 - 用于单元测试
    
    可以预设扫描结果，方便测试 EntityResolver 的逻辑
    """
    
    def __init__(self):
        self._block_results: Dict[str, List[ScanResult]] = {}
        self._entity_results: Dict[str, List[ScanResult]] = {}
    
    def set_block_results(self, block_id: str, results: List[ScanResult]) -> None:
        """预设方块扫描结果"""
        self._block_results[block_id] = results
    
    def set_entity_results(self, entity_type: str, results: List[ScanResult]) -> None:
        """预设实体扫描结果"""
        self._entity_results[entity_type] = results
    
    async def scan_blocks(
        self, 
        block_ids: List[str], 
        radius: int = 32
    ) -> List[ScanResult]:
        """返回预设的方块扫描结果"""
        results = []
        for block_id in block_ids:
            if block_id in self._block_results:
                # 过滤半径
                for r in self._block_results[block_id]:
                    if r.distance <= radius:
                        results.append(r)
        results.sort(key=lambda r: r.distance)
        return results
    
    async def scan_entities(
        self, 
        entity_types: List[str], 
        radius: int = 32
    ) -> List[ScanResult]:
        """返回预设的实体扫描结果"""
        results = []
        for entity_type in entity_types:
            if entity_type in self._entity_results:
                for r in self._entity_results[entity_type]:
                    if r.distance <= radius:
                        results.append(r)
        results.sort(key=lambda r: r.distance)
        return results

