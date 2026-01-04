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
        
        # 线程管理：追踪所有后台采集线程，防止资源泄漏
        import threading
        self._background_threads: List[threading.Thread] = []
        self._thread_lock = threading.Lock()
        self._shutdown_requested = False
        
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
    
    def _track_thread(self, thread: "threading.Thread") -> None:
        """追踪后台线程"""
        with self._thread_lock:
            # 清理已完成的线程
            self._background_threads = [t for t in self._background_threads if t.is_alive()]
            self._background_threads.append(thread)
    
    def stop_all_background_tasks(self, timeout: float = 5.0) -> int:
        """
        停止所有后台任务，释放资源
        
        Args:
            timeout: 等待每个线程结束的超时时间
            
        Returns:
            仍在运行的线程数
        """
        self._shutdown_requested = True
        
        # 停止 pathfinder
        try:
            self._bot.pathfinder.stop()
        except:
            pass
        
        # 等待线程结束
        with self._thread_lock:
            threads = self._background_threads.copy()
        
        still_running = 0
        for t in threads:
            if t.is_alive():
                t.join(timeout=timeout / len(threads) if threads else timeout)
                if t.is_alive():
                    still_running += 1
                    logger.warning(f"Thread {t.name} did not terminate in time")
        
        # 清空列表
        with self._thread_lock:
            self._background_threads.clear()
        
        self._shutdown_requested = False
        return still_running
    
    # ========================================================================
    # Core Actions
    # ========================================================================
    
    async def goto(self, target: str, timeout: float = 60.0) -> ActionResult:
        """导航到目标位置"""
        start_time = time.time()
        logger.info(f"[DEBUG] goto called with target: {target}")
        
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
            
            logger.info(f"[DEBUG] goto: goal parsed, setting pathfinder goal")
            # 设置目标并等待到达
            self._bot.pathfinder.setGoal(goal)
            
            try:
                await asyncio.wait_for(
                    self._wait_for_goal_reached(saved_goal=goal),
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
    
    async def mine(
        self, 
        block_type: str, 
        count: int = 1, 
        timeout: float = 120.0,
        near_position: dict = None,
        search_radius: int = 64
    ) -> ActionResult:
        """
        采集指定类型的方块
        
        简单接口：
        - block_type: 方块类型
        - count: 数量 (-1 表示挖到附近没有为止，适合砍整棵树)
        - near_position: 搜索中心点 {"x": int, "y": int, "z": int}，默认 Bot 当前位置
        - search_radius: 搜索半径 (默认64格)
        
        深度功能：
        - 自动寻找 → 自动导航 → 自动选工具 → 挖掘
        - 进度感知超时：每次检测到进度重置 30s 计时器
        - 支持 count=-1 持续挖掘直到搜索范围内没有目标
        """
        start_time = time.time()
        collected = {}
        
        # 初始化进度计时器 (30秒无进度超时)
        self._progress_timer = ProgressTimer(timeout_seconds=30.0)
        
        # 确定搜索中心点
        if near_position:
            search_center = self._Vec3(near_position["x"], near_position["y"], near_position["z"])
        else:
            search_center = self._bot.entity.position
        
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
            remaining = count if count > 0 else float('inf')  # -1 表示无限
            unlimited_mode = (count <= 0)
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
                
                # 寻找搜索范围内最近的目标方块
                # 使用 search_center 作为搜索原点（可以是玩家位置）
                target_block = self._find_nearest_block(
                    block_id, 
                    search_center, 
                    search_radius
                )
                
                if not target_block:
                    if unlimited_mode:
                        # 无限模式下，找不到就是成功完成
                        break
                    elif collected.get(block_type, 0) == 0:
                        # 有限模式下，一个都没挖到才算失败
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
                        if self._shutdown_requested:
                            return
                        self._bot.collectBlock.collect(target_block)
                        collect_done = True
                    except Exception as e:
                        collect_error = e
                
                # 在后台线程启动采集 (追踪以防资源泄漏)
                import threading
                collect_thread = threading.Thread(target=do_collect, daemon=True, name=f"collect_{block_type}")
                self._track_thread(collect_thread)
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
            
            total_collected = collected.get(block_type, 0)
            if unlimited_mode:
                msg = f"采集完成！共采集 {total_collected} 个 {block_type}"
            else:
                msg = f"成功采集 {total_collected} 个 {block_type}"
            
            return ActionResult(
                success=True,
                action="mine",
                message=msg,
                status=ActionStatus.SUCCESS,
                data={
                    "collected": collected, 
                    "location": last_location, 
                    "progress_events": self._progress_timer.progress_count,
                    "unlimited_mode": unlimited_mode
                },
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
    
    async def mine_tree(
        self,
        near_position: dict = None,
        search_radius: int = 32,
        timeout: float = 120.0
    ) -> ActionResult:
        """
        智能砍树 - 砍掉一整棵树（使用 BFS 精确识别连通的原木）
        
        简单接口：
        - near_position: 搜索中心点 {"x": int, "y": int, "z": int}，默认 Bot 当前位置
        - search_radius: 搜索半径 (默认32格)
        
        深度功能：
        - 使用 BFS 找到与起始原木相连的所有原木（不会砍到相邻的树）
        - 从下往上砍，确保砍完整棵树
        - 自动识别各种类型的原木
        """
        start_time = time.time()
        
        # 所有原木类型
        LOG_TYPES = [
            "oak_log", "birch_log", "spruce_log", "jungle_log", 
            "acacia_log", "dark_oak_log", "mangrove_log", "cherry_log"
        ]
        
        try:
            # 确定搜索中心
            if near_position:
                search_center = {
                    "x": int(near_position.get("x", 0)),
                    "y": int(near_position.get("y", 64)),
                    "z": int(near_position.get("z", 0))
                }
            else:
                pos = self._bot.entity.position
                search_center = {"x": int(pos.x), "y": int(pos.y), "z": int(pos.z)}
            search_point = self._Vec3(search_center["x"], search_center["y"], search_center["z"])
            
            logger.info(f"[mine_tree] Searching for tree near {search_center}, radius={search_radius}")
            
            # 找到最近的原木
            mcData = self._mcData
            first_log = None
            first_log_type = None
            
            for log_type in LOG_TYPES:
                try:
                    block_id = mcData.blocksByName[log_type]
                    if block_id:
                        block = self._bot.findBlock({
                            "matching": block_id.id,
                            "maxDistance": search_radius,
                            "point": search_point
                        })
                        if block:
                            if first_log is None:
                                first_log = block
                                first_log_type = log_type
                            else:
                                dist_new = (
                                    (block.position.x - search_center["x"]) ** 2 +
                                    (block.position.y - search_center["y"]) ** 2 +
                                    (block.position.z - search_center["z"]) ** 2
                                )
                                dist_old = (
                                    (first_log.position.x - search_center["x"]) ** 2 +
                                    (first_log.position.y - search_center["y"]) ** 2 +
                                    (first_log.position.z - search_center["z"]) ** 2
                                )
                                if dist_new < dist_old:
                                    first_log = block
                                    first_log_type = log_type
                except:
                    continue
            
            if not first_log:
                return ActionResult(
                    success=False,
                    action="mine_tree",
                    message=f"附近 {search_radius} 格内没有找到树",
                    status=ActionStatus.FAILED,
                    error_code="NO_TARGET"
                )
            
            # 使用 BFS 找到这棵树的所有连通原木
            tree_logs = self._find_connected_logs(first_log, first_log_type, mcData)
            logger.info(f"[mine_tree] Found tree with {len(tree_logs)} logs of type {first_log_type}")
            
            if not tree_logs:
                return ActionResult(
                    success=False,
                    action="mine_tree",
                    message="无法识别树的结构",
                    status=ActionStatus.FAILED,
                    error_code="TREE_SCAN_FAILED"
                )
            
            # 按 Y 坐标排序（从下往上砍，避免原木掉落问题）
            tree_logs.sort(key=lambda pos: pos[1])

            # Move closer to the trunk once before mining (helps when far from search center)
            try:
                bot_pos = self._bot.entity.position
                tx, ty, tz = tree_logs[0]
                dist = ((bot_pos.x - tx) ** 2 + (bot_pos.y - ty) ** 2 + (bot_pos.z - tz) ** 2) ** 0.5
                if dist > 5.0:
                    await self._navigate_to_block(tx, ty, tz)
                    await asyncio.sleep(0.3)
            except Exception:
                pass

            
            # 逐个挖掘原木（使用 collectblock 插件）
            collected = 0
            failed = 0

            # collectBlock 在某些情况下会报：
            # "Timeout: Took too long to decide path to goal!"
            # 这通常不是“地形复杂”，而是寻路决策超时/卡住，需要 stop + 重试。
            MAX_COLLECT_RETRIES = 3
            COLLECT_WAIT_SEC = 35  # 单个原木最多等待（包含寻路/挖掘/拾取的延迟）
            
            for log_pos in tree_logs:
                if time.time() - start_time > timeout:
                    logger.warning(f"[mine_tree] Timeout after collecting {collected} logs")
                    break
                
                x, y, z = log_pos
                
                # 检查该位置是否还有原木（可能已经被挖掉或掉落）
                try:
                    block = self._bot.blockAt(self._Vec3(x, y, z))
                    if not block or block.name != first_log_type:
                        logger.debug(f"[mine_tree] Block at ({x},{y},{z}) is no longer {first_log_type}, skipping")
                        continue
                except Exception as e:
                    logger.debug(f"[mine_tree] Error checking block at ({x},{y},{z}): {e}")
                    continue
                
                # 计算到方块的距离
                bot_pos = self._bot.entity.position
                distance = ((bot_pos.x - x) ** 2 + (bot_pos.y - y) ** 2 + (bot_pos.z - z) ** 2) ** 0.5
                
                try:
                    last_err = None
                    mined_this_log = False
                    inventory_before = self._get_inventory_count(first_log_type)
                    
                    import threading  # 提前导入，确保在所有 dig 调用中可用

                    for attempt in range(1, MAX_COLLECT_RETRIES + 1):
                        # 重新获取方块（可能已经掉落）
                        block = self._bot.blockAt(self._Vec3(x, y, z))
                        if not block or block.name != first_log_type:
                            mined_this_log = True  # 方块消失了，视为成功
                            break
                        
                        # 重新计算距离
                        bot_pos = self._bot.entity.position
                        distance = ((bot_pos.x - x) ** 2 + (bot_pos.y - y) ** 2 + (bot_pos.z - z) ** 2) ** 0.5
                        
                        # 方案 A: 优先使用 bot.dig() 直接挖掘
                        # Minecraft 触及距离约 4.5 格（保守值，避免空挖）
                        dig_attempted = False
                        if distance <= 5.0:
                            # 在触及范围内，直接挖掘
                            logger.debug(f"[mine_tree] Direct dig at ({x},{y},{z}), distance={distance:.1f}")
                            dig_attempted = True
                            try:
                                # 装备工具
                                try:
                                    self._bot.tool.equipForBlock(block)
                                except Exception:
                                    pass
                                
                                # 直接挖掘 (同步调用，在线程中执行)
                                dig_done = False
                                dig_error = None
                                
                                def do_dig():
                                    nonlocal dig_done, dig_error
                                    try:
                                        if self._shutdown_requested:
                                            return
                                        self._bot.dig(block)
                                        dig_done = True
                                    except Exception as e:
                                        dig_error = e
                                
                                dig_thread = threading.Thread(target=do_dig, daemon=True, name=f"dig_{x}_{y}_{z}")
                                self._track_thread(dig_thread)
                                dig_thread.start()
                                
                                # 等待挖掘完成（最多10秒）
                                dig_start = time.time()
                                while not dig_done and dig_error is None and (time.time() - dig_start < 10):
                                    await asyncio.sleep(0.3)
                                
                                # 检查方块是否真的被破坏
                                if await self._wait_for_block_break(x, y, z, first_log_type, timeout=2.0):
                                    collected += 1
                                    mined_this_log = True
                                    logger.debug(f"[mine_tree] Successfully dug log at ({x},{y},{z})")
                                    break
                                else:
                                    # Dig returned but block still exists -> likely out of reach
                                    logger.debug(f"[mine_tree] Dig completed but block still exists at ({x},{y},{z}) - moving closer")
                                    dig_attempted = False  # Mark that we should move
                                
                                if dig_error:
                                    last_err = dig_error
                                    logger.debug(f"[mine_tree] Dig error at ({x},{y},{z}): {dig_error}")
                                    
                            except Exception as e:
                                last_err = e
                                logger.debug(f"[mine_tree] Direct dig failed at ({x},{y},{z}): {e}")
                        
                        # 如果没挖成功（距离太远 或 dig后方块没消失），需要先移动
                        if not mined_this_log:
                            logger.debug(f"[mine_tree] Need to move closer to ({x},{y},{z}), distance={distance:.1f}, dig_attempted={dig_attempted}")
                            try:
                                # 清理旧目标
                                try:
                                    self._bot.pathfinder.stop()
                                except Exception:
                                    pass
                                
                                # 移动到方块附近
                                await self._navigate_to_block(x, y, z)
                                await asyncio.sleep(0.3)
                                
                                # 再次尝试直接挖掘
                                block = self._bot.blockAt(self._Vec3(x, y, z))
                                if block and block.name == first_log_type:
                                    try:
                                        self._bot.tool.equipForBlock(block)
                                    except Exception:
                                        pass
                                    
                                    dig_done = False
                                    dig_error = None
                                    
                                    def do_dig2():
                                        nonlocal dig_done, dig_error
                                        try:
                                            if self._shutdown_requested:
                                                return
                                            self._bot.dig(block)
                                            dig_done = True
                                        except Exception as e:
                                            dig_error = e
                                    
                                    dig_thread = threading.Thread(target=do_dig2, daemon=True, name=f"dig2_{x}_{y}_{z}")
                                    self._track_thread(dig_thread)
                                    dig_thread.start()
                                    
                                    dig_start = time.time()
                                    while not dig_done and dig_error is None and (time.time() - dig_start < 10):
                                        await asyncio.sleep(0.3)
                                    
                                    if dig_done:
                                        if await self._wait_for_block_break(x, y, z, first_log_type, timeout=2.0):
                                            collected += 1
                                            mined_this_log = True
                                            break

                                    if dig_error:
                                        last_err = dig_error
                                        
                            except Exception as e:
                                last_err = e
                                logger.debug(f"[mine_tree] Move+dig failed at ({x},{y},{z}): {e}")
                        
                        if mined_this_log:
                            break
                        
                        # 重试前等待
                        if attempt < MAX_COLLECT_RETRIES:
                            await asyncio.sleep(0.5 * attempt)

                    if not mined_this_log:
                        failed += 1
                        if last_err is not None:
                            logger.warning(f"[mine_tree] Failed to mine log at ({x},{y},{z}) after retries: {last_err}")
                        else:
                            logger.warning(f"[mine_tree] Failed to mine log at ({x},{y},{z}) after retries: block still present")
                        
                except Exception as e:
                    logger.warning(f"[mine_tree] Failed to mine log at ({x},{y},{z}): {e}")
                    failed += 1
            
            # 等待掉落物落地（高处原木可能需要时间掉落）
            logger.info(f"[mine_tree] Waiting for falling logs and items...")
            await asyncio.sleep(1.0)
            
            # 拾取掉落物：走到掉落物附近自动拾取
            try:
                # 搜索附近的掉落物实体
                pickup_count = 0
                logger.info(f"[mine_tree] Searching for dropped items...")
                
                for attempt in range(3):  # 最多尝试3次
                    # 获取附近的掉落物实体
                    items_to_pickup = []
                    try:
                        bot_pos = self._bot.entity.position
                        total_entities = 0
                        item_entities = 0
                        
                        for entity_id in self._bot.entities:
                            entity = self._bot.entities[entity_id]
                            total_entities += 1
                            
                            if entity.name == "item":
                                item_entities += 1
                                # 检查距离
                                try:
                                    e_pos = entity.position
                                    dist = ((e_pos.x - bot_pos.x)**2 + (e_pos.y - bot_pos.y)**2 + (e_pos.z - bot_pos.z)**2) ** 0.5
                                    if dist <= 16:  # 16格范围内的掉落物
                                        items_to_pickup.append((dist, e_pos))
                                        logger.debug(f"[mine_tree] Found item entity at distance {dist:.1f}")
                                except Exception as e:
                                    logger.debug(f"[mine_tree] Error checking item entity: {e}")
                        
                        logger.info(f"[mine_tree] Attempt {attempt+1}: Found {total_entities} entities, {item_entities} items, {len(items_to_pickup)} within range")
                        
                    except Exception as e:
                        logger.warning(f"[mine_tree] Error finding dropped items: {e}")
                    
                    if not items_to_pickup:
                        logger.info(f"[mine_tree] No items to pickup, stopping search")
                        break
                    
                    # 按距离排序，走向最近的掉落物
                    items_to_pickup.sort(key=lambda x: x[0])
                    nearest = items_to_pickup[0][1]
                    
                    logger.info(f"[mine_tree] Moving to pickup items at ({nearest.x:.1f},{nearest.y:.1f},{nearest.z:.1f})")
                    
                    try:
                        # 走到掉落物位置（会自动拾取）
                        await self.goto(
                            target=f"{int(nearest.x)},{int(nearest.y)},{int(nearest.z)}",
                            timeout=5.0
                        )
                        pickup_count += 1
                        await asyncio.sleep(0.5)  # 等待自动拾取
                    except Exception as e:
                        logger.warning(f"[mine_tree] Failed to pickup items: {e}")
                        break
                
                if pickup_count > 0:
                    logger.info(f"[mine_tree] Picked up items from {pickup_count} locations")
                else:
                    logger.info(f"[mine_tree] No items were picked up")
                    
            except Exception as e:
                logger.warning(f"[mine_tree] Error in item pickup phase: {e}")
            
            msg = f"砍树完成！共砍掉 {collected} 个 {first_log_type}"
            if failed > 0:
                msg += f"（{failed} 个失败）"
            
            return ActionResult(
                success=collected > 0,
                action="mine_tree",
                message=msg,
                status=ActionStatus.SUCCESS if collected > 0 else ActionStatus.FAILED,
                data={
                    "collected": collected,
                    "failed": failed,
                    "log_type": first_log_type,
                    "tree_size": len(tree_logs)
                },
                duration_ms=int((time.time() - start_time) * 1000)
            )
            
        except Exception as e:
            logger.error(f"mine_tree failed: {e}")
            return ActionResult(
                success=False,
                action="mine_tree",
                message=str(e),
                status=ActionStatus.FAILED,
                error_code="UNKNOWN",
                duration_ms=int((time.time() - start_time) * 1000)
            )
    
    def _find_connected_logs(self, start_block, log_type: str, mcData) -> list:
        """
        使用 BFS 找到与起始原木相连的所有原木
        
        连通规则（支持樱花树等分叉结构）：
        - 6 个正交方向（上下左右前后）
        - 向上时也检查对角线（支持分叉的树冠）
        - 水平距离限制在 5 格内（避免连接到相邻的树）
        """
        from collections import deque
        
        visited = set()
        tree_logs = []
        queue = deque()
        
        start_pos = (int(start_block.position.x), int(start_block.position.y), int(start_block.position.z))
        queue.append(start_pos)
        visited.add(start_pos)
        
        # 6 个正交方向 + 向上的对角线方向（支持分叉树）
        # 基础方向
        base_directions = [
            (0, 1, 0),   # 上
            (0, -1, 0),  # 下
            (1, 0, 0),   # 东
            (-1, 0, 0),  # 西
            (0, 0, 1),   # 南
            (0, 0, -1),  # 北
        ]
        # 向上的对角线方向（支持樱花树等分叉结构）
        diagonal_up_directions = [
            (1, 1, 0), (-1, 1, 0), (0, 1, 1), (0, 1, -1),  # 4 个向上的对角
            (1, 1, 1), (-1, 1, 1), (1, 1, -1), (-1, 1, -1),  # 4 个向上的角落
        ]
        
        # 获取原木的 block ID
        try:
            log_block_id = mcData.blocksByName[log_type].id
        except:
            return [start_pos]
        
        while queue:
            x, y, z = queue.popleft()
            tree_logs.append((x, y, z))
            
            # 检查所有方向
            all_directions = base_directions + diagonal_up_directions
            for dx, dy, dz in all_directions:
                nx, ny, nz = x + dx, y + dy, z + dz
                
                if (nx, ny, nz) in visited:
                    continue
                
                # 限制搜索范围，避免无限扩展
                # 水平距离限制在 5 格内（避免连接到相邻的树）
                if abs(nx - start_pos[0]) > 5 or abs(nz - start_pos[2]) > 5:
                    continue
                if ny < start_pos[1] - 3 or ny > start_pos[1] + 30:  # 树最高约 30 格
                    continue
                
                visited.add((nx, ny, nz))
                
                # 检查该位置是否是同类型原木
                try:
                    block = self._bot.blockAt(self._Vec3(nx, ny, nz))
                    if block and block.name == log_type:
                        queue.append((nx, ny, nz))
                except:
                    continue
        

        return tree_logs
    async def _wait_for_block_break(self, x: int, y: int, z: int, expected_name: str, timeout: float = 2.0) -> bool:
        'Poll the block state until it is no longer expected_name.'
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                block = self._bot.blockAt(self._Vec3(x, y, z))
            except Exception:
                block = None
            if block is not None and block.name != expected_name:
                return True
            # Unknown block state; keep waiting to avoid false positives
            await asyncio.sleep(0.2)
        return False

    
    async def _navigate_to_block(self, x: int, y: int, z: int):
        """导航到可以挖掘指定方块的位置"""
        try:
            # 计算一个可以站立的位置（方块旁边）
            bot_pos = self._bot.entity.position
            
            # 如果已经足够近，不需要移动
            dist = ((bot_pos.x - x) ** 2 + (bot_pos.y - y) ** 2 + (bot_pos.z - z) ** 2) ** 0.5
            if dist < 4:
                return
            
            # 使用 pathfinder 导航到方块附近
            goals = self._pathfinder.goals
            goal = goals.GoalNear(int(x), int(y), int(z), 3)
            self._bot.pathfinder.setGoal(goal)

            # Wait briefly; if no movement, fallback to an XZ-only goal
            start_wait = time.time()
            while not self._bot.pathfinder.isMoving() and time.time() - start_wait < 2.0:
                await asyncio.sleep(0.1)
            if not self._bot.pathfinder.isMoving():
                fallback_goal = None
                if hasattr(goals, "GoalNearXZ"):
                    fallback_goal = goals.GoalNearXZ(int(x), int(z), 3)
                else:
                    fallback_goal = goals.GoalNear(int(x), int(bot_pos.y), int(z), 3)
                logger.debug(f"Navigation fallback to XZ-only goal for ({x},{y},{z})")
                self._bot.pathfinder.setGoal(fallback_goal)

            # 等待到达
            start = time.time()
            while self._bot.pathfinder.isMoving() and time.time() - start < 10:
                await asyncio.sleep(0.1)
                
        except Exception as e:
            logger.debug(f"Navigation to ({x},{y},{z}) failed: {e}")
    
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
        """
        合成物品 (Tag-aware 版本)
        
        增强功能:
        - 自动尝试所有配方变体
        - Tag 等价材料匹配 (如 birch_planks 可替代 oak_planks 合成 stick)
        - 返回详细的缺失材料信息
        """
        start_time = time.time()
        
        try:
            # 获取物品信息
            item_info = self._mcData.itemsByName[item_name] if hasattr(self._mcData.itemsByName, item_name) else None
            if not item_info:
                return ActionResult(
                    success=False,
                    action="craft",
                    message=f"未知的物品: {item_name}",
                    status=ActionStatus.FAILED,
                    error_code="TARGET_NOT_FOUND"
                )
            
            # 获取所有配方 (使用 recipesAll 获取完整列表)
            all_recipes = []
            try:
                all_recipes_proxy = self._bot.recipesAll(item_info.id, None, None)
                all_recipes = list(all_recipes_proxy) if all_recipes_proxy else []
            except Exception as e:
                logger.debug(f"recipesAll failed: {e}")
            
            # 如果 recipesAll 失败，回退到 recipesFor
            if not all_recipes:
                try:
                    recipes_proxy = self._bot.recipesFor(item_info.id)
                    all_recipes = list(recipes_proxy) if recipes_proxy else []
                except:
                    pass
            
            if not all_recipes:
                return ActionResult(
                    success=False,
                    action="craft",
                    message=f"找不到 {item_name} 的配方",
                    status=ActionStatus.FAILED,
                    error_code="TARGET_NOT_FOUND"
                )
            
            # 获取当前背包状态
            inventory = self._get_inventory_summary()
            
            # 尝试找到可执行的配方 (Tag-aware)
            executable_recipe, missing_materials = self._find_executable_recipe(all_recipes, inventory, count)
            
            if not executable_recipe:
                # 所有配方都不可行，返回详细的缺失材料信息
                return ActionResult(
                    success=False,
                    action="craft",
                    message=f"合成 {item_name} 材料不足: {missing_materials}",
                    status=ActionStatus.FAILED,
                    error_code="INSUFFICIENT_MATERIALS",
                    data={"missing": missing_materials},
                    duration_ms=int((time.time() - start_time) * 1000)
                )
            
            # 检查是否需要工作台
            crafting_table = None
            if executable_recipe.requiresTable:
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
                    lambda: self._bot.craft(executable_recipe, count, crafting_table)
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
    
    def _find_executable_recipe(
        self, 
        recipes: list, 
        inventory: Dict[str, int],
        craft_count: int = 1
    ) -> tuple:
        """
        找到第一个可执行的配方 (Tag-aware)
        
        Args:
            recipes: 配方列表
            inventory: 当前背包 {item_name: count}
            craft_count: 要合成的数量
            
        Returns:
            (recipe, missing_materials)
            - 成功: (recipe, {})
            - 失败: (None, {material_name: required_count})
        """
        from bot.tag_resolver import get_tag_resolver
        tag_resolver = get_tag_resolver()
        
        best_missing = {}  # 记录最接近成功的配方缺少什么
        
        for recipe in recipes:
            required_materials = self._extract_recipe_materials(recipe)
            if not required_materials:
                continue
            
            # 检查每种材料是否有足够的等价物品
            can_craft = True
            recipe_missing = {}
            
            for material_id, required_count in required_materials.items():
                # 将 ID 转换为物品名
                material_name = self._get_item_name_by_id(material_id)
                if not material_name:
                    can_craft = False
                    recipe_missing[f"id:{material_id}"] = required_count * craft_count
                    continue
                
                # 使用 TagResolver 查找背包中的等价物品总数
                available_count = tag_resolver.get_available_count(material_name, inventory)
                needed = required_count * craft_count
                
                if available_count < needed:
                    can_craft = False
                    # 记录需要的 Tag 组名（更友好的提示）
                    equivalents = tag_resolver.get_equivalents(material_name)
                    tag_hint = material_name if len(equivalents) == 1 else f"{material_name} (或其他变体)"
                    recipe_missing[tag_hint] = needed - available_count
            
            if can_craft:
                return (recipe, {})
            
            # 记录最接近成功的配方
            if not best_missing or len(recipe_missing) < len(best_missing):
                best_missing = recipe_missing
        
        return (None, best_missing)
    
    def _extract_recipe_materials(self, recipe) -> Dict[int, int]:
        """
        从配方中提取所需材料
        
        Returns:
            {item_id: required_count}
        """
        materials: Dict[int, int] = {}
        
        try:
            # 处理 inShape (有形状配方)
            if hasattr(recipe, 'inShape') and recipe.inShape:
                for row in recipe.inShape:
                    for cell in row:
                        if cell and cell > 0:  # 有效的物品 ID
                            materials[cell] = materials.get(cell, 0) + 1
            
            # 处理 ingredients (无形状配方)
            if hasattr(recipe, 'ingredients') and recipe.ingredients:
                for ingredient in recipe.ingredients:
                    if ingredient and ingredient > 0:
                        materials[ingredient] = materials.get(ingredient, 0) + 1
            
            # 处理 delta 格式 (某些配方使用 delta)
            if hasattr(recipe, 'delta') and recipe.delta:
                for delta_item in recipe.delta:
                    if hasattr(delta_item, 'id') and hasattr(delta_item, 'count'):
                        if delta_item.count < 0:  # 负数表示消耗
                            materials[delta_item.id] = materials.get(delta_item.id, 0) + abs(delta_item.count)
                            
        except Exception as e:
            logger.warning(f"Failed to extract recipe materials: {e}")
        
        return materials
    
    def _get_item_name_by_id(self, item_id: int) -> Optional[str]:
        """根据物品 ID 获取物品名称"""
        try:
            item = self._mcData.items[item_id]
            return item.name if item else None
        except:
            return None
    
    async def give(self, player_name: str, item_name: str, count: int = 1, timeout: float = 30.0) -> ActionResult:
        """将物品交给玩家"""
        start_time = time.time()
        
        try:
            # 检查玩家是否在线 (JSPyBridge 兼容方式)
            try:
                player = self._bot.players[player_name]
            except (KeyError, TypeError):
                player = None
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
            
            # 面向玩家 (实时获取玩家位置)
            try:
                player = self._bot.players[player_name]
                if player and player.entity:
                    await asyncio.wait_for(
                        asyncio.get_event_loop().run_in_executor(
                            None,
                            lambda: self._bot.lookAt(player.entity.position)
                        ),
                        timeout=2.0
                    )
            except (KeyError, TypeError):
                pass  # 如果找不到玩家，继续丢物品
            
            # 丢物品给玩家 (使用 toss 指定数量，而不是 tossStack 丢整个栈)
            actual_count = min(count, item.count)  # 不能丢超过拥有的数量
            await asyncio.wait_for(
                asyncio.get_event_loop().run_in_executor(
                    None,
                    lambda: self._bot.toss(item.type, None, actual_count)
                ),
                timeout=5.0
            )
            
            return ActionResult(
                success=True,
                action="give",
                message=f"已将 {actual_count} 个 {item_name} 交给 {player_name}",
                status=ActionStatus.SUCCESS,
                data={"given": {item_name: actual_count}, "to": player_name},
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
        """
        扫描周围实体/方块
        
        注意: 此方法是 IBotActions 的一部分，服务于 TaskExecutor/LLM 规划器。
        返回 ActionResult，包含扫描到的目标摘要。
        
        与 perception/scanner.py 的 MineflayerScanner 区别:
        - 此方法: 动作层，单一 target_type，返回 ActionResult
        - MineflayerScanner: 感知层，多候选 ID，返回 List[ScanResult]
        """
        start_time = time.time()
        
        try:
            targets = []
            
            if target_type == "player":
                # 扫描玩家 (内存操作，无需 executor)
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
                # 扫描实体 (内存操作，无需 executor)
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
                # 扫描方块 - 使用 executor 避免阻塞事件循环
                block_info = self._mcData.blocksByName[target_type] if hasattr(self._mcData.blocksByName, target_type) else None
                if block_info:
                    # findBlocks 可能涉及大量计算，放入线程池
                    blocks_proxy = await asyncio.get_event_loop().run_in_executor(
                        None,
                        lambda: self._bot.findBlocks({
                            "matching": block_info.id,
                            "maxDistance": radius,
                            "count": 64
                        })
                    )
                    
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
    
    def get_player_position(self, player_name: str) -> Optional[dict]:
        """
        获取指定玩家的位置（感知能力）
        
        这是一个独立的感知方法，不属于 IBotActions 接口，
        因为获取其他实体位置是感知能力，不是动作能力。
        
        Args:
            player_name: 玩家名
            
        Returns:
            {"x": int, "y": int, "z": int} 或 None
        """
        try:
            player = self._bot.players[player_name]
            if player and player.entity:
                pos = player.entity.position
                return {
                    "x": int(pos.x),
                    "y": int(pos.y),
                    "z": int(pos.z)
                }
        except (KeyError, TypeError):
            pass
        return None
    
    # ========================================================================
    # Helper Methods
    # ========================================================================
    
    def _parse_goal(self, target: str):
        """解析目标字符串为 Goal 对象"""
        goals = self._pathfinder.goals
        
        # 玩家目标: @PlayerName
        if target.startswith("@"):
            player_name = target[1:]
            # JSPyBridge 兼容方式访问 players
            try:
                player = self._bot.players[player_name]
            except (KeyError, TypeError):
                player = None
            if player and player.entity:
                pos = player.entity.position
                logger.info(f"[DEBUG] goto @{player_name}: found at ({pos.x:.1f}, {pos.y:.1f}, {pos.z:.1f})")
                # 使用 GoalBlock 到达玩家脚下的方块位置
                return goals.GoalBlock(int(pos.x), int(pos.y), int(pos.z))
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
    
    async def _wait_for_goal_reached(self, saved_goal=None):
        """等待寻路目标达成"""
        # 等待 pathfinder 开始移动（最多等 2 秒）
        start_wait = time.time()
        while not self._bot.pathfinder.isMoving():
            if time.time() - start_wait > 2.0:
                # 超过 2 秒还没开始移动，检查是否已经在目标位置
                if saved_goal and self._is_goal_reached(saved_goal):
                    logger.info("[DEBUG] Already at goal, no movement needed")
                    return
                logger.warning("Pathfinder did not start moving within 2s")
                break
            await asyncio.sleep(0.1)
        
        logger.info(f"[DEBUG] Pathfinder started moving: {self._bot.pathfinder.isMoving()}")
        
        # 等待到达目标
        iteration = 0
        while True:
            is_moving = self._bot.pathfinder.isMoving()
            goal = self._bot.pathfinder.goal
            
            # 每秒打印一次状态
            if iteration % 10 == 0:
                pos = self._bot.entity.position
                logger.info(f"[DEBUG] Pathfinder status: moving={is_moving}, goal={goal is not None}, pos=({pos.x:.1f}, {pos.y:.1f}, {pos.z:.1f})")
            iteration += 1
            
            if not is_moving:
                # 停止移动了，检查是否到达
                # 使用保存的 goal 检查（因为 pathfinder.goal 可能被清空）
                check_goal = goal or saved_goal
                if check_goal and self._is_goal_reached(check_goal):
                    logger.info("[DEBUG] Goal reached!")
                    return
                if goal is None and saved_goal is None:
                    logger.info("[DEBUG] Goal is None, pathfinder stopped (no saved goal)")
                    return
                # 没有到达但停止了，可能是路径被阻挡或已到达
                logger.warning(f"[DEBUG] Pathfinder stopped, goal={goal is not None}, saved_goal={saved_goal is not None}")
                return
            
            await asyncio.sleep(0.1)
    
    def _is_goal_reached(self, goal) -> bool:
        """检查目标是否达成"""
        try:
            pos = self._bot.entity.position
            return goal.isEnd(pos.x, pos.y, pos.z)
        except:
            return False
    
    def _find_nearest_block(self, block_id: int, center, radius: int):
        """
        在指定中心点附近搜索最近的方块
        
        Args:
            block_id: 方块 ID
            center: 搜索中心点 (Vec3)
            radius: 搜索半径
            
        Returns:
            最近的方块对象，或 None
        """
        try:
            # 获取搜索范围内的所有目标方块
            blocks = self._bot.findBlocks({
                "matching": block_id,
                "maxDistance": radius,
                "count": 256  # 足够大以覆盖一棵树
            })
            
            if not blocks:
                return None
            
            # 找到距离 center 最近的方块
            nearest_block = None
            nearest_dist = float('inf')
            
            for block_pos in blocks:
                try:
                    dist = center.distanceTo(block_pos)
                    if dist < nearest_dist:
                        nearest_dist = dist
                        nearest_block = self._bot.blockAt(block_pos)
                except:
                    pass
            
            return nearest_block
        except Exception as e:
            logger.warning(f"_find_nearest_block failed: {e}")
            return None
    
    def _find_inventory_item(self, item_name: str):
        """
        在背包中查找物品对象 (内部辅助方法)
        
        用于动作执行: place(), give(), equip() 需要获取 Item 对象来操作
        
        与 perception/inventory.py 的 BotInventoryProvider.find_item() 区别:
        - 此方法: 动作层内部辅助，服务于物品操作动作
        - BotInventoryProvider: 感知层独立接口，服务于 EntityResolver
        """
        try:
            items = self._bot.inventory.items()
            for item in items:
                if item.name == item_name:
                    return item
            return None
        except:
            return None
    
    def _get_inventory_summary(self) -> Dict[str, int]:
        """
        获取背包摘要 (合并同类项) - 内部辅助方法
        
        用于: craft() 检查材料, get_state() 返回状态
        
        与 perception/inventory.py 的 BotInventoryProvider.get_items() 区别:
        - 此方法: 动作层内部辅助，服务于合成/状态查询
        - BotInventoryProvider: 感知层独立接口，服务于 EntityResolver 候选检查
        """
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

