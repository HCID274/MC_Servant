# Mineflayer Actions Implementation

"""
Bot 动作实现层 (Layer 2: Python Actions)

设计原则：
- 简单接口，深度功能
- 依赖抽象，而非具体
- 所有高风险操作使用 asyncio.wait_for 包装

职责：
- 封装 Mineflayer JS API 调用
- 提供统一的 Python 异步接口
- 处理超时、错误、重试逻辑
"""

import asyncio
import logging
import time
from typing import Optional, List, Dict, Any, Callable

from javascript import require, On

from bot.interfaces import IBotActions, ActionResult, ActionStatus

logger = logging.getLogger(__name__)


# ============================================================================
# Progress-Aware Timeout Utility
# ============================================================================

class ProgressTimer:
    """
    进度感知超时计时器
    
    简单接口：
    - reset() - 报告进度，重置超时计时器
    - is_expired() - 检查是否超时
    
    深度功能：
    - 每次有进度时重置计时，而非使用固定总超时
    - 支持不同类型的进度事件
    """
    
    def __init__(self, timeout_seconds: float = 30.0):
        """
        Args:
            timeout_seconds: 无进度超时时间 (秒)
        """
        self._timeout = timeout_seconds
        self._last_progress_time = time.time()
        self._progress_count = 0
        self._progress_log: List[str] = []
    
    def reset(self, event_name: str = "progress") -> None:
        """报告进度，重置计时器"""
        self._last_progress_time = time.time()
        self._progress_count += 1
        self._progress_log.append(f"{event_name}@{time.time():.2f}")
        logger.debug(f"[ProgressTimer] Reset by {event_name}, count={self._progress_count}")
    
    def is_expired(self) -> bool:
        """检查是否超时 (距离上次进度超过 timeout)"""
        return (time.time() - self._last_progress_time) > self._timeout
    
    def elapsed_since_progress(self) -> float:
        """距离上次进度的时间 (秒)"""
        return time.time() - self._last_progress_time
    
    @property
    def progress_count(self) -> int:
        return self._progress_count


class MineflayerActions(IBotActions):
    """
    Mineflayer 动作实现
    
    封装 javascript 模块调用，提供统一的 Python 异步接口。
    接收已经初始化好插件的 MineflayerBot 实例。
    """
    
    def __init__(self, bot):
        """
        初始化动作层
        
        Args:
            bot: MineflayerBot 实例 (已加载 pathfinder/collectblock/tool 插件)
        """
        self._mf_bot = bot  # MineflayerBot wrapper
        self._bot = bot._bot  # 原始 mineflayer bot 对象
        self._mcData = bot._mcData  # minecraft-data
        self._pathfinder = bot._pathfinder  # pathfinder 模块引用
        self._Vec3 = require("vec3")
        
        # 进度感知超时支持
        self._progress_timer: Optional[ProgressTimer] = None
        self._setup_progress_events()
    
    def _setup_progress_events(self):
        """
        注册进度事件监听器
        
        注意：由于 JSPyBridge 的限制，复杂的事件监听可能导致线程崩溃。
        目前只依赖 inventory 轮询来检测进度，不使用 JS 事件。
        """
        # 暂时不注册事件，避免 JSPyBridge 崩溃
        # 使用 inventory 轮询来检测进度
        pass
    
    # ========================================================================
    # Core Actions
    # ========================================================================
    
    async def goto(self, target: str, timeout: float = 60.0) -> ActionResult:
        """导航到目标位置"""
        start_time = time.time()
        
        try:
            goal = self._parse_goal(target)
            if goal is None:
                return ActionResult(
                    success=False,
                    action="goto",
                    message=f"无法解析目标位置: {target}",
                    status=ActionStatus.FAILED,
                    error_code="TARGET_NOT_FOUND"
                )
            
            # 设置目标并等待到达
            self._bot.pathfinder.setGoal(goal)
            
            try:
                await asyncio.wait_for(
                    self._wait_for_goal_reached(),
                    timeout=timeout
                )
            except asyncio.TimeoutError:
                # 超时时停止寻路，防止 JS 后台继续执行
                self._bot.pathfinder.stop()
                return ActionResult(
                    success=False,
                    action="goto",
                    message=f"导航到 {target} 超时 ({timeout}s)",
                    status=ActionStatus.TIMEOUT,
                    error_code="TIMEOUT",
                    duration_ms=int((time.time() - start_time) * 1000)
                )
            
            # 获取到达位置
            pos = self._bot.entity.position
            return ActionResult(
                success=True,
                action="goto",
                message=f"已到达 {target}",
                status=ActionStatus.SUCCESS,
                data={"arrived_at": [int(pos.x), int(pos.y), int(pos.z)]},
                duration_ms=int((time.time() - start_time) * 1000)
            )
            
        except Exception as e:
            logger.error(f"goto failed: {e}")
            self._bot.pathfinder.stop()
            return ActionResult(
                success=False,
                action="goto",
                message=str(e),
                status=ActionStatus.FAILED,
                error_code="PATH_BLOCKED",
                duration_ms=int((time.time() - start_time) * 1000)
            )
    
    async def mine(self, block_type: str, count: int = 1, timeout: float = 120.0) -> ActionResult:
        """
        采集指定类型的方块
        
        使用进度感知超时：每次检测到进度（挖完、捡起）重置 30s 计时器。
        只有连续 30s 无进度才会超时。
        """
        start_time = time.time()
        collected = {}
        
        # 初始化进度计时器 (30秒无进度超时)
        self._progress_timer = ProgressTimer(timeout_seconds=30.0)
        
        try:
            # 获取方块类型信息
            block_info = self._mcData.blocksByName[block_type] if hasattr(self._mcData.blocksByName, block_type) else None
            if not block_info:
                return ActionResult(
                    success=False,
                    action="mine",
                    message=f"未知的方块类型: {block_type}",
                    status=ActionStatus.FAILED,
                    error_code="TARGET_NOT_FOUND"
                )
            
            block_id = block_info.id
            remaining = count
            last_location = None
            
            while remaining > 0:
                # 检查总超时 (硬限制)
                if time.time() - start_time > timeout:
                    return ActionResult(
                        success=False,
                        action="mine",
                        message=f"采集 {block_type} 超时 (硬限制)，已采集 {count - remaining}/{count}",
                        status=ActionStatus.TIMEOUT,
                        error_code="TIMEOUT",
                        data={"collected": collected},
                        duration_ms=int((time.time() - start_time) * 1000)
                    )
                
                # 检查进度超时 (30秒无进度)
                if self._progress_timer.is_expired():
                    return ActionResult(
                        success=False,
                        action="mine",
                        message=f"采集 {block_type} 30秒无进度，已采集 {count - remaining}/{count}",
                        status=ActionStatus.TIMEOUT,
                        error_code="NO_PROGRESS",
                        data={"collected": collected, "progress_count": self._progress_timer.progress_count},
                        duration_ms=int((time.time() - start_time) * 1000)
                    )
                
                # 寻找最近的目标方块
                target_block = self._bot.findBlock({
                    "matching": block_id,
                    "maxDistance": 64
                })
                
                if not target_block:
                    if remaining == count:
                        return ActionResult(
                            success=False,
                            action="mine",
                            message=f"附近找不到 {block_type}",
                            status=ActionStatus.FAILED,
                            error_code="TARGET_NOT_FOUND"
                        )
                    else:
                        # 已采集部分，返回成功
                        break
                
                last_location = [
                    int(target_block.position.x),
                    int(target_block.position.y),
                    int(target_block.position.z)
                ]
                
                # 记录采集前状态，用于检测采集是否成功
                inventory_before = self._get_inventory_count(block_type)
                
                # 自动选择合适的工具
                try:
                    await asyncio.wait_for(
                        asyncio.get_event_loop().run_in_executor(
                            None,
                            lambda: self._bot.tool.equipForBlock(target_block)
                        ),
                        timeout=5.0
                    )
                    self._progress_timer.reset("tool_equipped")
                except Exception as e:
                    logger.warning(f"Auto-equip tool failed: {e}")
                
                # 启动采集 (非阻塞)
                collect_done = False
                collect_error = None
                
                def do_collect():
                    nonlocal collect_done, collect_error
                    try:
                        self._bot.collectBlock.collect(target_block)
                        collect_done = True
                    except Exception as e:
                        collect_error = e
                
                # 在后台线程启动采集
                import threading
                collect_thread = threading.Thread(target=do_collect, daemon=True)
                collect_thread.start()
                
                # 轮询等待，同时检查进度 (通过 inventory 变化)
                last_inventory_check = inventory_before
                while not collect_done and collect_error is None:
                    await asyncio.sleep(1.0)  # 每秒检查一次
                    
                    # 检查 inventory 变化 (用于重置进度计时器)
                    try:
                        current_inventory = self._get_inventory_count(block_type)
                        if current_inventory > last_inventory_check:
                            self._progress_timer.reset("inventory_changed")
                            last_inventory_check = current_inventory
                            logger.debug(f"Inventory increased: {current_inventory}")
                    except:
                        pass
                    
                    # 检查进度超时 (30秒无 inventory 变化)
                    if self._progress_timer.is_expired():
                        logger.warning(f"No inventory progress for 30s during collect")
                        break
                    
                    # 检查总超时
                    if time.time() - start_time > timeout:
                        break
                
                # 检测是否真的采集到了 (通过 inventory 变化)
                inventory_after = self._get_inventory_count(block_type)
                actually_collected = inventory_after - inventory_before
                
                if actually_collected > 0:
                    collected[block_type] = collected.get(block_type, 0) + actually_collected
                    remaining -= actually_collected
                    self._progress_timer.reset("inventory_increased")
                    logger.info(f"Collected {actually_collected} {block_type}, remaining: {remaining}")
                elif collect_done:
                    # JS 端说采集完成但 inventory 没变，可能是掉落物还在路上
                    collected[block_type] = collected.get(block_type, 0) + 1
                    remaining -= 1
                    self._progress_timer.reset("collect_completed")
                    logger.info(f"Collect reported done for {block_type}, remaining: {remaining}")
                elif collect_error:
                    logger.warning(f"Collect error: {collect_error}")
                    await asyncio.sleep(0.5)
            
            return ActionResult(
                success=True,
                action="mine",
                message=f"成功采集 {collected.get(block_type, 0)} 个 {block_type}",
                status=ActionStatus.SUCCESS,
                data={"collected": collected, "location": last_location, "progress_events": self._progress_timer.progress_count},
                duration_ms=int((time.time() - start_time) * 1000)
            )
            
        except Exception as e:
            logger.error(f"mine failed: {e}")
            return ActionResult(
                success=False,
                action="mine",
                message=str(e),
                status=ActionStatus.FAILED,
                error_code="UNKNOWN",
                data={"collected": collected},
                duration_ms=int((time.time() - start_time) * 1000)
            )
        finally:
            self._progress_timer = None
    
    def _get_inventory_count(self, item_name: str) -> int:
        """获取背包中指定物品的数量"""
        try:
            total = 0
            for item in self._bot.inventory.items():
                if item.name == item_name:
                    total += item.count
            return total
        except:
            return 0
    
    async def place(self, block_type: str, x: int, y: int, z: int, timeout: float = 10.0) -> ActionResult:
        """在指定位置放置方块"""
        start_time = time.time()
        
        try:
            # 检查背包中是否有该方块
            item = self._find_inventory_item(block_type)
            if not item:
                return ActionResult(
                    success=False,
                    action="place",
                    message=f"背包中没有 {block_type}",
                    status=ActionStatus.FAILED,
                    error_code="INSUFFICIENT_MATERIALS"
                )
            
            # 装备方块
            await asyncio.wait_for(
                asyncio.get_event_loop().run_in_executor(
                    None,
                    lambda: self._bot.equip(item, "hand")
                ),
                timeout=3.0
            )
            
            # 获取放置位置的参考方块 (下方方块)
            target_pos = self._Vec3(x, y - 1, z)
            ref_block = self._bot.blockAt(target_pos)
            
            if not ref_block or ref_block.name == "air":
                return ActionResult(
                    success=False,
                    action="place",
                    message=f"放置位置 ({x},{y},{z}) 下方没有参考方块",
                    status=ActionStatus.FAILED,
                    error_code="TARGET_NOT_FOUND"
                )
            
            # 放置方块
            await asyncio.wait_for(
                asyncio.get_event_loop().run_in_executor(
                    None,
                    lambda: self._bot.placeBlock(ref_block, self._Vec3(0, 1, 0))
                ),
                timeout=timeout
            )
            
            return ActionResult(
                success=True,
                action="place",
                message=f"成功放置 {block_type} 在 ({x},{y},{z})",
                status=ActionStatus.SUCCESS,
                data={"placed_at": [x, y, z]},
                duration_ms=int((time.time() - start_time) * 1000)
            )
            
        except asyncio.TimeoutError:
            return ActionResult(
                success=False,
                action="place",
                message=f"放置 {block_type} 超时",
                status=ActionStatus.TIMEOUT,
                error_code="TIMEOUT",
                duration_ms=int((time.time() - start_time) * 1000)
            )
        except Exception as e:
            logger.error(f"place failed: {e}")
            return ActionResult(
                success=False,
                action="place",
                message=str(e),
                status=ActionStatus.FAILED,
                error_code="UNKNOWN",
                duration_ms=int((time.time() - start_time) * 1000)
            )
    
    async def craft(self, item_name: str, count: int = 1, timeout: float = 30.0) -> ActionResult:
        """合成物品"""
        start_time = time.time()
        
        try:
            # 获取配方
            item_info = self._mcData.itemsByName[item_name] if hasattr(self._mcData.itemsByName, item_name) else None
            if not item_info:
                return ActionResult(
                    success=False,
                    action="craft",
                    message=f"未知的物品: {item_name}",
                    status=ActionStatus.FAILED,
                    error_code="TARGET_NOT_FOUND"
                )
            
            # 尝试获取配方 (先用 recipesFor，失败则用 recipesAll)
            recipes_proxy = self._bot.recipesFor(item_info.id)
            recipes = list(recipes_proxy) if recipes_proxy else []
            
            # 如果 recipesFor 没有结果，尝试 recipesAll (忽略当前库存)
            if not recipes:
                try:
                    all_recipes_proxy = self._bot.recipesAll(item_info.id, None, None)
                    recipes = list(all_recipes_proxy) if all_recipes_proxy else []
                except:
                    pass
            
            if not recipes:
                return ActionResult(
                    success=False,
                    action="craft",
                    message=f"找不到 {item_name} 的配方",
                    status=ActionStatus.FAILED,
                    error_code="TARGET_NOT_FOUND"
                )
            
            recipe = recipes[0]
            
            # 检查是否需要工作台
            crafting_table = None
            if recipe.requiresTable:
                # 寻找附近的工作台
                ct_info = self._mcData.blocksByName["crafting_table"] if hasattr(self._mcData.blocksByName, "crafting_table") else None
                if ct_info:
                    crafting_table = self._bot.findBlock({
                        "matching": ct_info.id,
                        "maxDistance": 32
                    })
                
                if not crafting_table:
                    return ActionResult(
                        success=False,
                        action="craft",
                        message=f"合成 {item_name} 需要工作台，但附近没有找到",
                        status=ActionStatus.FAILED,
                        error_code="NO_TOOL"
                    )
            
            # 执行合成
            await asyncio.wait_for(
                asyncio.get_event_loop().run_in_executor(
                    None,
                    lambda: self._bot.craft(recipe, count, crafting_table)
                ),
                timeout=timeout
            )
            
            return ActionResult(
                success=True,
                action="craft",
                message=f"成功合成 {count} 个 {item_name}",
                status=ActionStatus.SUCCESS,
                data={"crafted": {item_name: count}},
                duration_ms=int((time.time() - start_time) * 1000)
            )
            
        except asyncio.TimeoutError:
            return ActionResult(
                success=False,
                action="craft",
                message=f"合成 {item_name} 超时",
                status=ActionStatus.TIMEOUT,
                error_code="TIMEOUT",
                duration_ms=int((time.time() - start_time) * 1000)
            )
        except Exception as e:
            logger.error(f"craft failed: {e}")
            error_msg = str(e)
            error_code = "UNKNOWN"
            if "missing" in error_msg.lower():
                error_code = "INSUFFICIENT_MATERIALS"
            return ActionResult(
                success=False,
                action="craft",
                message=error_msg,
                status=ActionStatus.FAILED,
                error_code=error_code,
                duration_ms=int((time.time() - start_time) * 1000)
            )
    
    async def give(self, player_name: str, item_name: str, count: int = 1, timeout: float = 30.0) -> ActionResult:
        """将物品交给玩家"""
        start_time = time.time()
        
        try:
            # 检查玩家是否在线
            player = self._bot.players.get(player_name)
            if not player or not player.entity:
                return ActionResult(
                    success=False,
                    action="give",
                    message=f"找不到玩家 {player_name}",
                    status=ActionStatus.FAILED,
                    error_code="TARGET_NOT_FOUND"
                )
            
            # 检查背包
            item = self._find_inventory_item(item_name)
            if not item:
                return ActionResult(
                    success=False,
                    action="give",
                    message=f"背包中没有 {item_name}",
                    status=ActionStatus.FAILED,
                    error_code="INSUFFICIENT_MATERIALS"
                )
            
            # 先走到玩家附近
            goto_result = await self.goto(f"@{player_name}", timeout=timeout/2)
            if not goto_result.success:
                return ActionResult(
                    success=False,
                    action="give",
                    message=f"无法走到玩家 {player_name} 身边",
                    status=goto_result.status,
                    error_code=goto_result.error_code,
                    duration_ms=int((time.time() - start_time) * 1000)
                )
            
            # 丢物品给玩家
            await asyncio.wait_for(
                asyncio.get_event_loop().run_in_executor(
                    None,
                    lambda: self._bot.tossStack(item)
                ),
                timeout=5.0
            )
            
            return ActionResult(
                success=True,
                action="give",
                message=f"已将 {count} 个 {item_name} 交给 {player_name}",
                status=ActionStatus.SUCCESS,
                data={"given": {item_name: count}, "to": player_name},
                duration_ms=int((time.time() - start_time) * 1000)
            )
            
        except Exception as e:
            logger.error(f"give failed: {e}")
            return ActionResult(
                success=False,
                action="give",
                message=str(e),
                status=ActionStatus.FAILED,
                error_code="UNKNOWN",
                duration_ms=int((time.time() - start_time) * 1000)
            )
    
    async def equip(self, item_name: str, timeout: float = 5.0) -> ActionResult:
        """装备物品到手上"""
        start_time = time.time()
        
        try:
            item = self._find_inventory_item(item_name)
            if not item:
                return ActionResult(
                    success=False,
                    action="equip",
                    message=f"背包中没有 {item_name}",
                    status=ActionStatus.FAILED,
                    error_code="TARGET_NOT_FOUND"
                )
            
            await asyncio.wait_for(
                asyncio.get_event_loop().run_in_executor(
                    None,
                    lambda: self._bot.equip(item, "hand")
                ),
                timeout=timeout
            )
            
            return ActionResult(
                success=True,
                action="equip",
                message=f"已装备 {item_name}",
                status=ActionStatus.SUCCESS,
                data={"equipped": item_name},
                duration_ms=int((time.time() - start_time) * 1000)
            )
            
        except Exception as e:
            logger.error(f"equip failed: {e}")
            return ActionResult(
                success=False,
                action="equip",
                message=str(e),
                status=ActionStatus.FAILED,
                error_code="UNKNOWN",
                duration_ms=int((time.time() - start_time) * 1000)
            )
    
    async def scan(self, target_type: str, radius: int = 32) -> ActionResult:
        """扫描周围实体/方块"""
        start_time = time.time()
        
        try:
            targets = []
            
            if target_type == "player":
                # 扫描玩家
                for name, player in dict(self._bot.players).items():
                    if player.entity and name != self._bot.username:
                        pos = player.entity.position
                        dist = self._bot.entity.position.distanceTo(pos)
                        if dist <= radius:
                            targets.append({
                                "name": name,
                                "type": "player",
                                "position": [int(pos.x), int(pos.y), int(pos.z)],
                                "distance": int(dist)
                            })
            
            elif target_type in ("mob", "entity"):
                # 扫描实体
                for entity_id, entity in dict(self._bot.entities).items():
                    if entity.type == "mob" or entity.type == "animal":
                        pos = entity.position
                        dist = self._bot.entity.position.distanceTo(pos)
                        if dist <= radius:
                            targets.append({
                                "name": entity.name or entity.type,
                                "type": entity.type,
                                "position": [int(pos.x), int(pos.y), int(pos.z)],
                                "distance": int(dist)
                            })
            
            else:
                # 扫描方块
                block_info = self._mcData.blocksByName[target_type] if hasattr(self._mcData.blocksByName, target_type) else None
                if block_info:
                    blocks_proxy = self._bot.findBlocks({
                        "matching": block_info.id,
                        "maxDistance": radius,
                        "count": 64
                    })
                    
                    # 将 JS Proxy 转换为 Python list
                    blocks = list(blocks_proxy) if blocks_proxy else []
                    
                    if blocks:
                        # 找最近的
                        bot_pos = self._bot.entity.position
                        nearest = None
                        nearest_dist = float('inf')
                        
                        for block_pos in blocks:
                            try:
                                dist = bot_pos.distanceTo(block_pos)
                                if dist < nearest_dist:
                                    nearest_dist = dist
                                    nearest = block_pos
                            except:
                                pass
                        
                        targets.append({
                            "name": target_type,
                            "count": len(blocks),
                            "nearest": [int(nearest.x), int(nearest.y), int(nearest.z)] if nearest else None,
                            "distance": int(nearest_dist) if nearest and nearest_dist != float('inf') else None
                        })
            
            return ActionResult(
                success=True,
                action="scan",
                message=f"扫描完成，找到 {len(targets)} 个目标",
                status=ActionStatus.SUCCESS,
                data={"targets": targets},
                duration_ms=int((time.time() - start_time) * 1000)
            )
            
        except Exception as e:
            logger.error(f"scan failed: {e}")
            return ActionResult(
                success=False,
                action="scan",
                message=str(e),
                status=ActionStatus.FAILED,
                error_code="UNKNOWN",
                duration_ms=int((time.time() - start_time) * 1000)
            )
    
    def get_state(self) -> dict:
        """获取 Bot 当前状态"""
        try:
            pos = self._bot.entity.position
            
            return {
                "position": {
                    "x": int(pos.x),
                    "y": int(pos.y),
                    "z": int(pos.z)
                },
                "health": float(self._bot.health) if self._bot.health else 20.0,
                "food": int(self._bot.food) if self._bot.food else 20,
                "inventory": self._get_inventory_summary(),
                "equipped": self._get_equipped_item()
            }
        except Exception as e:
            logger.error(f"get_state failed: {e}")
            return {
                "position": {"x": 0, "y": 0, "z": 0},
                "health": 0,
                "food": 0,
                "inventory": {},
                "equipped": None,
                "error": str(e)
            }
    
    # ========================================================================
    # Helper Methods
    # ========================================================================
    
    def _parse_goal(self, target: str):
        """解析目标字符串为 Goal 对象"""
        goals = self._pathfinder.goals
        
        # 玩家目标: @PlayerName
        if target.startswith("@"):
            player_name = target[1:]
            player = self._bot.players.get(player_name)
            if player and player.entity:
                return goals.GoalFollow(player.entity, 2)
            logger.warning(f"Player not found: {player_name}")
            return None
        
        # 坐标目标: x,y,z
        if "," in target:
            parts = target.replace(" ", "").split(",")
            if len(parts) == 3:
                try:
                    x, y, z = map(int, parts)
                    return goals.GoalBlock(x, y, z)
                except ValueError:
                    logger.warning(f"Invalid coordinates: {target}")
                    return None
        
        logger.warning(f"Unsupported target format: {target}")
        return None
    
    async def _wait_for_goal_reached(self):
        """等待寻路目标达成"""
        while True:
            if not self._bot.pathfinder.isMoving():
                # 检查目标是否达成
                goal = self._bot.pathfinder.goal
                if goal is None or self._is_goal_reached(goal):
                    return
            await asyncio.sleep(0.1)
    
    def _is_goal_reached(self, goal) -> bool:
        """检查目标是否达成"""
        try:
            pos = self._bot.entity.position
            return goal.isEnd(pos.x, pos.y, pos.z)
        except:
            return False
    
    def _find_inventory_item(self, item_name: str):
        """在背包中查找物品"""
        try:
            items = self._bot.inventory.items()
            for item in items:
                if item.name == item_name:
                    return item
            return None
        except:
            return None
    
    def _get_inventory_summary(self) -> Dict[str, int]:
        """获取背包摘要 (合并同类项)"""
        summary = {}
        try:
            items = self._bot.inventory.items()
            for item in items:
                name = item.name
                count = item.count
                summary[name] = summary.get(name, 0) + count
        except Exception as e:
            logger.warning(f"Failed to get inventory: {e}")
        return summary
    
    def _get_equipped_item(self) -> Optional[str]:
        """获取当前装备的物品"""
        try:
            held_item = self._bot.heldItem
            return held_item.name if held_item else None
        except:
            return None
