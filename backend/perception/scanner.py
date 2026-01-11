# Mineflayer Scanner Implementation - 世界感知扫描器
#
# 职责:
# - 封装 Mineflayer 的方块/实体扫描能力
# - 提供统一的异步接口
# - Block 坐标转换为中心点坐标

import asyncio
import logging
from typing import List, Dict, Any, Optional

from bot.drivers.interfaces import IDriverAdapter

from .interfaces import IScanner, ScanResult
from .knowledge_base import get_knowledge_base

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
    
    def __init__(self, driver: IDriverAdapter):
        """
        初始化扫描器
        
        Args:
            driver: IDriverAdapter instance.
        """
        self._driver = driver
    
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
        try:
            bot_pos = self._driver.get_position()
        except Exception:
            return []
        if not bot_pos:
            return []
        
        for block_id in block_ids:
            try:
                # 获取方块类型信息
                block_type_id = self._driver.get_block_id(block_id)
                if block_type_id is None:
                    logger.debug(f"[Scanner] Unknown block type: {block_id}")
                    continue
                
                # 使用 executor 执行同步的 findBlocks 调用
                blocks_proxy = await asyncio.get_event_loop().run_in_executor(
                    None,
                    lambda bid=block_type_id: self._driver.find_blocks({
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
        # 安全检查: position 可能会在初始化期间为 None
        try:
            bot_pos = self._driver.get_position()
        except Exception:
            return []
        if not bot_pos:
            return []

        bot_username = self._driver.username
        
        # 将 entity_types 转为小写集合，方便匹配
        target_types = {t.lower() for t in entity_types}
        scan_all_mobs = "mob" in target_types or "mobs" in target_types
        scan_players = "player" in target_types or "players" in target_types
        
        try:
            # 遍历所有实体
            # 容错处理: 确保 entities 是有效字典
            entities_dict = self._driver.get_entities()
            
            for entity_id, entity in entities_dict.items():
                try:
                    # 容错处理: 实体对象可能为 None
                    if not entity:
                        continue

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
                    # 容错处理: 实体位置可能为 None
                    if not entity_pos:
                        continue

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
                    logger.debug(f"[Scanner] Error processing entity {entity_id}: {e}")
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
            block = self._driver.block_at(block_pos)
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
    
    async def get_environment_summary(
        self,
        radius: int = 10,
        max_resources: int = 10
    ) -> Dict[str, Any]:
        """
        获取环境感知摘要 (Phase 2: LocalPerception)
        
        简单接口：一次调用获取附近资源摘要
        
        深度功能：
        - 扫描常用资源方块 (从知识库获取)
        - 计算最近距离
        - Top-N 截断避免 Token 溢出
        - 返回格式化的自然语言描述
        
        Args:
            radius: 扫描半径 (格)
            max_resources: 最多返回的资源种类数
            
        Returns:
            {
                "position": {"x": float, "y": float, "z": float},
                "nearby_resources": {
                    "cherry_log": {"count": 15, "distance": 3.2},
                    ...
                },
                "nearby_entities": ["player", "cow"],
                "scan_radius": 10,
                "summary_text": "Nearby: cherry_log x15 (3m), ..."
            }
        """
        # 从知识库加载资源列表
        kb = get_knowledge_base()
        resource_blocks = set()

        # 添加各类资源
        resource_blocks.update(kb.get_candidates("logs"))
        resource_blocks.update(kb.get_candidates("ores"))
        resource_blocks.update(kb.get_candidates("stone_variants"))
        resource_blocks.update(kb.get_candidates("sand_gravel"))
        # 工作站 (KB中可能不完整，暂时手动补充常用)
        resource_blocks.update(["crafting_table", "furnace", "chest", "barrel", "smoker", "blast_furnace"])

        # 移除不可见或无效的
        valid_resources = [b for b in resource_blocks if self._driver.get_block_id(b) is not None]
        
        try:
            bot_pos = self._driver.get_position()
        except Exception:
            bot_pos = None
        if not bot_pos:
            return {
                "position": {"x": 0.0, "y": 0.0, "z": 0.0},
                "nearby_resources": {},
                "nearby_entities": [],
                "scan_radius": radius,
                "summary_text": "Environment scan failed"
            }
        result = {
            "position": {
                "x": float(bot_pos.x),
                "y": float(bot_pos.y),
                "z": float(bot_pos.z)
            },
            "nearby_resources": {},
            "nearby_entities": [],
            "scan_radius": radius,
            "summary_text": ""
        }
        
        try:
            # 优化: 批量扫描
            # Mineflayer findBlocks 支持传入 ID 数组，但这里我们按类别分组扫描或保持循环
            # 为了准确统计每种方块的数量，分别扫描是较简单的实现
            # 如果性能成为瓶颈，可以按 ID 列表扫描然后本地分类
            
            # 筛选出要扫描的 ID 列表
            target_ids = []
            block_name_map = {} # id -> name

            for block_name in valid_resources:
                block_id = self._driver.get_block_id(block_name)
                if block_id is not None:
                    target_ids.append(block_id)
                    block_name_map[block_id] = block_name
        
            if target_ids and bot_pos:
                # 批量扫描所有关注的方块
                # 注意: count 限制可能会导致某些稀有资源被忽略，如果有大量常见资源
                # 这里为了性能，我们设置一个较大的 count
                blocks_proxy = await asyncio.get_event_loop().run_in_executor(
                    None,
                    lambda: self._driver.find_blocks({
                        "matching": target_ids,
                        "maxDistance": radius,
                        "count": 256
                    })
                )

                blocks = list(blocks_proxy) if blocks_proxy else []

                # 本地分类统计
                for block_pos in blocks:
                    try:
                        # findBlocks 返回的是 Vec3，需要获取 blockAt 才能知道具体 ID
                        # 但 findBlocks 本身不返回 ID。
                        # 这是一个性能权衡: findBlocks 很快，但我们需要再次 blockAt
                        # 或者我们可以假设 mineflayer 内部已经访问了 chunk

                        # 优化: blockAt 是同步且快速的 (内存查表)
                        block = self._driver.block_at(block_pos)
                        if block and block.type in block_name_map:
                            name = block_name_map[block.type]

                            if name not in result["nearby_resources"]:
                                result["nearby_resources"][name] = {
                                    "count": 0,
                                    "distance": float('inf')
                                }

                            res = result["nearby_resources"][name]
                            res["count"] += 1

                            dist = bot_pos.distanceTo(block_pos)
                            if dist < res["distance"]:
                                res["distance"] = round(dist, 1)

                    except Exception as e:
                        continue

            # 扫描附近实体
            try:
                entities_dict = self._driver.get_entities()
                bot_username = self._driver.username
                
                for entity_id, entity in entities_dict.items():
                    try:
                        if hasattr(entity, 'username') and entity.username == bot_username:
                            continue
                        
                        entity_pos = entity.position
                        distance = bot_pos.distanceTo(entity_pos)
                        
                        if distance <= radius:
                            entity_name = getattr(entity, 'name', None) or getattr(entity, 'type', 'unknown')
                            if entity_name not in result["nearby_entities"]:
                                result["nearby_entities"].append(entity_name)
                    except:
                        continue
            except Exception as e:
                logger.debug(f"[Scanner] Error scanning entities: {e}")
            
            # 生成自然语言摘要
            if result["nearby_resources"]:
                # 按数量排序，取 Top-N
                sorted_resources = sorted(
                    result["nearby_resources"].items(),
                    key=lambda x: x[1]["count"],
                    reverse=True
                )[:max_resources]
                
                summary_parts = []
                for name, info in sorted_resources:
                    summary_parts.append(f"{name}: {info['count']} ({info['distance']}m)")
                
                result["summary_text"] = f"Nearby ({radius}m): " + ", ".join(summary_parts)
            else:
                result["summary_text"] = f"Nearby ({radius}m): No resources found"
            
            logger.info(f"[Scanner] Environment summary: {result['summary_text'][:100]}...")
            
        except Exception as e:
            logger.error(f"[Scanner] get_environment_summary failed: {e}")
            result["summary_text"] = "Environment scan failed"
        
        return result


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

