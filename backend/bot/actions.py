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
import math
import re
import time
from typing import Optional, List, Dict, Any, Callable

from javascript import require, On

from bot.interfaces import IBotActions, ActionResult, ActionStatus

logger = logging.getLogger(__name__)


# ============================================================================
# Progress-Aware Timeout Utility
# ============================================================================

_INT_RE = re.compile(r"-?\d+")


def _coerce_js_int(value: Any) -> int:
    """
    将 JSPyBridge / JS Proxy 返回的“看起来像数字”的对象尽可能稳健地转换为 int。

    经验法则：
    - 直接 int(x) 往往对 Proxy 失败
    - str(x) 通常更稳定（很多 Proxy 会把 JS number 格式化为字符串）
    - 最后回退用正则从 repr/str 中抽取第一个整数
    """
    if value is None:
        raise TypeError("cannot coerce None to int")

    # bool 是 int 的子类，避免把 True/False 当作 1/0 误用
    if isinstance(value, bool):
        raise TypeError("cannot coerce bool to int")

    if isinstance(value, int):
        return value

    if isinstance(value, float):
        return int(value)

    if isinstance(value, str):
        s = value.strip()
        if s == "":
            raise ValueError("empty string")
        try:
            return int(s)
        except ValueError:
            # 允许 "1.0" 这类
            return int(float(s))

    # 常见 Proxy：int(proxy) 失败，但 str(proxy) 是 "123"
    try:
        return int(value)  # type: ignore[arg-type]
    except Exception:
        pass

    try:
        return _coerce_js_int(str(value))
    except Exception:
        pass

    m = _INT_RE.search(repr(value))
    if m:
        return int(m.group(0))

    raise TypeError(f"cannot coerce {type(value)} to int: {value!r}")


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
    # Tool Selection Helpers (Python-side, Neuro-Symbolic approach)
    # ========================================================================
    
    async def _get_block_harvest_info(self, block) -> dict:
        """
        安全获取方块的可采集性信息
        
        使用 asyncio.to_thread 包装 JS 调用，避免阻塞主线程和 JSPyBridge 崩溃
        
        Returns:
            {
                "name": str,           # 方块名
                "harvestTools": dict,  # {item_id: True} 可以采集此方块的工具 ID
                "can_hand_harvest": bool  # 是否可以徒手采集
            }
        """
        def _sync_get():
            try:
                harvest_tools = getattr(block, 'harvestTools', None)
                # harvestTools 是 JS 对象，格式为 {itemId: true}
                # 如果为 None/undefined，表示可以徒手采集
                tools_dict = {}
                can_hand = True
                
                if harvest_tools:
                    can_hand = False
                    # 将 JS 对象转为 Python dict
                    try:
                        for key in harvest_tools:
                            tools_dict[int(key)] = True
                    except Exception:
                        # 可能是迭代失败，尝试 Object.keys
                        pass
                
                return {
                    "name": getattr(block, 'name', 'unknown'),
                    "harvestTools": tools_dict,
                    "can_hand_harvest": can_hand
                }
            except Exception as e:
                logger.warning(f"Failed to get harvest info: {e}")
                return {"name": "unknown", "harvestTools": {}, "can_hand_harvest": True}
        
        return await asyncio.get_event_loop().run_in_executor(None, _sync_get)
    
    async def _select_best_harvest_tool(self, block) -> Optional[dict]:
        """
        Python 侧选择最佳采集工具
        
        简单接口：只需传入方块，返回最佳工具 item 对象
        
        深度功能：
        - 利用 minecraft-data 的 harvestTools 数据
        - 按工具等级排序（钻石 > 铁 > 石 > 木）
        - 如果该方块可以徒手采集，返回 None（表示不需要换工具）
        - 如果需要工具但背包没有，返回 {"error": "NO_TOOL", "required": [...]}
        
        Returns:
            - None: 不需要换工具（可徒手或已装备最佳）
            - {"item": item_obj}: 需要装备的工具
            - {"error": "NO_TOOL", "required": [item_names]}: 没有合适工具
        """
        # 工具等级优先级（从高到低）
        TOOL_TIERS = {
            "netherite": 5,
            "diamond": 4,
            "iron": 3,
            "stone": 2,
            "golden": 1,  # 金工具速度快但耐久低
            "wooden": 0,
        }
        
        def _sync_select():
            try:
                harvest_tools = getattr(block, 'harvestTools', None)
                
                # 如果没有 harvestTools 限制，表示可以徒手采集
                if not harvest_tools:
                    logger.debug(f"Block {block.name} can be harvested by hand")
                    return None
                
                # 获取需要的工具 ID 列表
                required_tool_ids = set()
                try:
                    for key in harvest_tools:
                        required_tool_ids.add(int(key))
                except Exception:
                    pass
                
                if not required_tool_ids:
                    return None
                
                # 扫描背包，找出匹配的工具
                inventory_items = list(self._bot.inventory.items())
                available_tools = []
                
                for item in inventory_items:
                    if item.type in required_tool_ids:
                        # 计算工具等级
                        tier = 0
                        item_name = item.name.lower()
                        for tier_name, tier_value in TOOL_TIERS.items():
                            if tier_name in item_name:
                                tier = tier_value
                                break
                        available_tools.append((tier, item))
                
                if not available_tools:
                    # 没有合适工具！Fail Fast
                    # 尝试获取需要的工具名称（方便 LLM 理解）
                    required_names = []
                    for tool_id in list(required_tool_ids)[:5]:  # 最多列5个
                        try:
                            item_info = self._mcData.items[tool_id]
                            required_names.append(item_info.name)
                        except:
                            required_names.append(f"item_{tool_id}")
                    
                    return {
                        "error": "NO_TOOL",
                        "required": required_names,
                        "block": block.name
                    }
                
                # 按等级降序排序，选择最好的工具
                available_tools.sort(key=lambda x: x[0], reverse=True)
                best_tool = available_tools[0][1]
                
                # 检查是否已经装备（避免不必要的切换）
                held_item = self._bot.heldItem
                if held_item and held_item.type == best_tool.type:
                    logger.debug(f"Already holding best tool: {best_tool.name}")
                    return None
                
                logger.info(f"Selected tool: {best_tool.name} (tier {available_tools[0][0]}) for {block.name}")
                return {"item": best_tool}
                
            except Exception as e:
                logger.error(f"Tool selection failed: {e}")
                return None
        
        return await asyncio.get_event_loop().run_in_executor(None, _sync_select)
    
    def _infer_tool_requirements(self, required_tools: List[str]) -> tuple[Optional[str], Optional[str]]:
        """Infer tool type and minimum tier from required tool names."""
        tier_order = ["wooden", "stone", "iron", "diamond", "netherite"]
        tool_type = None
        min_tier = None

        for tool in required_tools or []:
            if not isinstance(tool, str):
                continue
            name = tool.lower()
            parts = name.split("_")
            if len(parts) < 2:
                continue
            tier = parts[0]
            kind = parts[-1]

            if tool_type is None:
                tool_type = kind
            if tier in tier_order:
                if min_tier is None or tier_order.index(tier) < tier_order.index(min_tier):
                    min_tier = tier

        if tool_type and min_tier is None:
            min_tier = "wooden"

        return tool_type, min_tier

    def _equip_axe_sync(self) -> bool:
        """
        同步装备斧头（用于砍树场景）
        
        优先选择高等级斧头，避免调用 JS 侧的 equipForBlock 减少线程压力
        """
        AXE_PRIORITY = [
            "netherite_axe", "diamond_axe", "iron_axe", 
            "stone_axe", "golden_axe", "wooden_axe"
        ]
        
        try:
            # 检查当前手持是否已经是斧头
            held = self._bot.heldItem
            if held and "axe" in held.name:
                return True
            
            # 扫描背包找斧头
            for axe_name in AXE_PRIORITY:
                for item in self._bot.inventory.items():
                    if item.name == axe_name:
                        self._bot.equip(item, "hand")
                        logger.debug(f"Equipped {axe_name} for tree mining")
                        return True
            
            return False  # 没找到斧头，徒手也行
        except Exception as e:
            logger.warning(f"Axe equip failed: {e}")
            return False
    
    # ========================================================================
    # Core Actions
    # ========================================================================
    
    async def chat(self, message: str) -> bool:
        """发送聊天消息"""
        try:
            return await self._mf_bot.chat(message)
        except Exception as e:
            logger.error(f"chat failed: {e}")
            return False

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
                
                # ============================================================
                # Python 侧智能工具选择 (替代 JS 侧 equipForBlock)
                # 
                # 设计原则：Fail Fast
                # - 如果需要特定工具但背包没有，直接返回错误
                # - 让 LLM 决定是合成工具、寻找工具、还是放弃任务
                # ============================================================
                tool_result = await self._select_best_harvest_tool(target_block)
                
                if tool_result and "error" in tool_result:
                    # 没有合适工具！立即失败，反馈给 LLM
                    required_tools = tool_result.get("required", ["pickaxe"])
                    tool_type, min_tier = self._infer_tool_requirements(required_tools)
                    return ActionResult(
                        success=False,
                        action="mine",
                        message=f"无法采集 {block_type}：需要合适的工具 (如 {', '.join(required_tools[:3])})",
                        status=ActionStatus.FAILED,
                        error_code="NO_TOOL",
                        data={
                            "block": block_type,
                            "required_tools": required_tools,
                            "tool_type": tool_type,
                            "min_tier": min_tier,
                            "hint": "建议先合成或获取合适的工具"
                        },
                        duration_ms=int((time.time() - start_time) * 1000)
                    )
                
                if tool_result and "item" in tool_result:
                    # 需要切换工具
                    try:
                        best_tool = tool_result["item"]
                        await asyncio.wait_for(
                            asyncio.get_event_loop().run_in_executor(
                                None,
                                lambda: self._bot.equip(best_tool, "hand")
                            ),
                            timeout=3.0
                        )
                        self._progress_timer.reset("tool_equipped")
                        logger.info(f"Equipped {best_tool.name} for mining {block_type}")
                    except Exception as e:
                        logger.warning(f"Failed to equip tool: {e}")
                        # 装备失败不阻止挖掘，可能仍然能挖（只是更慢）
                
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
                                # 装备斧头（同步简化版）
                                # 原木可以徒手采集，但斧头更快
                                try:
                                    self._equip_axe_sync()
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
                                        self._equip_axe_sync()
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
            # 如果目标位置已经是该方块，直接成功（避免重复放置导致 blockUpdate 不触发）
            try:
                existing = self._bot.blockAt(self._Vec3(x, y, z))
                if existing and getattr(existing, "name", None) == block_type:
                    return ActionResult(
                        success=True,
                        action="place",
                        message=f"{block_type} 已在 ({x},{y},{z})，无需重复放置",
                        status=ActionStatus.SUCCESS,
                        data={"placed_at": [x, y, z], "already_there": True},
                        duration_ms=int((time.time() - start_time) * 1000),
                    )
            except Exception:
                pass

            # 确保距离足够近（mineflayer 放置需要在可达范围内；否则可能超时等不到 blockUpdate）
            try:
                pos = self._bot.entity.position
                dx = float(pos.x) - float(x)
                dy = float(pos.y) - float(y)
                dz = float(pos.z) - float(z)
                dist = (dx * dx + dy * dy + dz * dz) ** 0.5
            except Exception:
                dist = 9999.0
            if dist > 4.5:
                # 用较短超时靠近；失败不立即返回，让 placeBlock 自身决定
                try:
                    await self.goto(f"{x},{y},{z}", timeout=min(10.0, max(3.0, timeout / 2)))
                except Exception:
                    pass

            # 检查背包中是否有该方块
            item = self._find_inventory_item(block_type)
            if not item:
                return ActionResult(
                    success=False,
                    action="place",
                    message=f"背包中没有 {block_type}",
                    status=ActionStatus.FAILED,
                    error_code="INSUFFICIENT_MATERIALS",
                    # 🔴 修复: 添加 missing 数据供 PrerequisiteResolver 使用
                    data={"missing": {block_type: 1}, "item": block_type}
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

            # 二次确认（某些服务器/延迟下 blockUpdate 事件可能不可靠，但方块已放下）
            try:
                placed = self._bot.blockAt(self._Vec3(x, y, z))
                if placed and getattr(placed, "name", None) != block_type:
                    logger.debug(f"[place] Post-check mismatch: expected={block_type}, got={getattr(placed,'name',None)}")
            except Exception:
                pass
            
            return ActionResult(
                success=True,
                action="place",
                message=f"成功放置 {block_type} 在 ({x},{y},{z})",
                status=ActionStatus.SUCCESS,
                data={"placed_at": [x, y, z]},
                duration_ms=int((time.time() - start_time) * 1000)
            )
            
        except asyncio.TimeoutError:
            # 超时也做一次 world-state 校验：若实际已放置则返回成功
            try:
                placed = self._bot.blockAt(self._Vec3(x, y, z))
                if placed and getattr(placed, "name", None) == block_type:
                    return ActionResult(
                        success=True,
                        action="place",
                        message=f"成功放置 {block_type} 在 ({x},{y},{z})（事件超时但已确认落地）",
                        status=ActionStatus.SUCCESS,
                        data={"placed_at": [x, y, z], "event_timeout_but_placed": True},
                        duration_ms=int((time.time() - start_time) * 1000),
                    )
            except Exception:
                pass
            return ActionResult(
                success=False,
                action="place",
                message=f"放置 {block_type} 超时",
                status=ActionStatus.TIMEOUT,
                error_code="TIMEOUT",
                duration_ms=int((time.time() - start_time) * 1000)
            )
        except Exception as e:
            # 兼容 mineflayer placeBlock 的 blockUpdate 超时异常（它不是 asyncio.TimeoutError）
            msg = str(e)
            if "blockupdate" in msg.lower() and "did not fire within timeout" in msg.lower():
                try:
                    placed = self._bot.blockAt(self._Vec3(x, y, z))
                    if placed and getattr(placed, "name", None) == block_type:
                        return ActionResult(
                            success=True,
                            action="place",
                            message=f"成功放置 {block_type} 在 ({x},{y},{z})（blockUpdate 超时但已确认落地）",
                            status=ActionStatus.SUCCESS,
                            data={"placed_at": [x, y, z], "blockupdate_timeout_but_placed": True},
                            duration_ms=int((time.time() - start_time) * 1000),
                        )
                except Exception:
                    pass
                return ActionResult(
                    success=False,
                    action="place",
                    message=msg,
                    status=ActionStatus.TIMEOUT,
                    error_code="TIMEOUT",
                    duration_ms=int((time.time() - start_time) * 1000),
                )

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
        合成物品
        
        增强功能:
        - 自动尝试所有配方变体
        - 基于 recipe.delta 解析材料消耗（负数=消耗，正数=产出），避免 JSPyBridge Proxy 解析不稳定
        - 返回详细的缺失材料信息（machine-readable: data.missing）
        """
        start_time = time.time()
        
        executable_recipe = None
        inventory: Dict[str, int] = {}
        missing_materials: Dict[str, int] = {}

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
            
            # 1. 预先寻找附近的工作台 (32格内)
            crafting_table_block = None
            try:
                ct_info = self._mcData.blocksByName["crafting_table"]
                if ct_info:
                    crafting_table_block = self._bot.findBlock({
                        "matching": ct_info.id,
                        "maxDistance": 32
                    })
            except Exception:
                pass

            # 获取所有配方 (传入工作台以解锁 3x3 配方)
            all_recipes = []
            try:
                all_recipes_proxy = self._bot.recipesAll(item_info.id, None, crafting_table_block)
                all_recipes = list(all_recipes_proxy) if all_recipes_proxy else []
            except Exception as e:
                logger.debug(f"recipesAll failed: {e}")
            
            # 如果 recipesAll 失败，回退到 recipesFor
            if not all_recipes:
                try:
                    # mineflayer: recipesFor(itemType[, metadata[, minResultCount[, craftingTable]]])
                    # 兼容不同版本/桥接层签名差异：依次尝试更完整的参数
                    recipes_proxy = None
                    try:
                        recipes_proxy = self._bot.recipesFor(item_info.id, None, int(count), None)
                    except Exception:
                        try:
                            recipes_proxy = self._bot.recipesFor(item_info.id, None, int(count))
                        except Exception:
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
            
            # 🔴 调试日志：显示配方数量
            logger.info(f"[craft] Found {len(all_recipes)} recipe variants for {item_name}")

            # 兼容逻辑：如果 mineflayerAPI 找不到配方 (通常因为缺少工作台)，尝试检查 raw recipe 是否存在
            if not all_recipes:
                # 检查 mcData.recipes 是否有此物品的配方数据
                has_raw_recipe = False
                try:
                    raw_recipes = self._mcData.recipes.get(str(item_info.id))
                    if raw_recipes and len(raw_recipes) > 0:
                        has_raw_recipe = True
                except Exception:
                    pass
                
                if has_raw_recipe:
                    # 原生配方存在但 valid recipes 为空 -> 99% 概率是缺工作台
                    # 直接返回 STATION_NOT_PLACED，让 Resolver 去处理（如果没有工作台物品，Resolver 会进一步生成合成工作台的任务）
                    return ActionResult(
                        success=False,
                        action="craft",
                        message=f"合成 {item_name} 需要工作台，请确保工作台已放置",
                        status=ActionStatus.FAILED,
                        error_code="STATION_NOT_PLACED",
                        data={"station": "crafting_table", "item": item_name}
                    )

            # 尝试找到可执行的配方
            executable_recipe, missing_materials = self._find_executable_recipe(all_recipes, inventory, count)

            # 如果所有配方都无法解析（delta 缺失/Proxy 解析失败），给出明确错误码
            if not executable_recipe and "__recipe_parse_failed__" in missing_materials:
                return ActionResult(
                    success=False,
                    action="craft",
                    message=f"合成 {item_name} 失败：配方解析失败 (delta)",
                    status=ActionStatus.FAILED,
                    error_code="RECIPE_PARSE_FAILED",
                    data={
                        "item": item_name,
                        "parse_failures": missing_materials.get("__recipe_parse_failed__", 0),
                        "recipe_count": len(all_recipes),
                    },
                    duration_ms=int((time.time() - start_time) * 1000),
                )
            
            if not executable_recipe:
                # 所有配方都不可行，返回详细的缺失材料信息
                return ActionResult(
                    success=False,
                    action="craft",
                    message=f"合成 {item_name} 材料不足: {missing_materials}",
                    status=ActionStatus.FAILED,
                    error_code="INSUFFICIENT_MATERIALS",
                    data={"missing": missing_materials, "item": item_name},
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
            
            try:
                await asyncio.wait_for(
                    asyncio.get_event_loop().run_in_executor(
                        None,
                        lambda: self._bot.craft(executable_recipe, count, crafting_table)
                    ),
                    timeout=timeout
                )
            except Exception as craft_exc:
                # Mineflayer 对 recipe 示例材料做严格检查（不理解 #planks），会在这里抛 missing ingredient。
                # 对 crafting_table（2x2，无需工作台）我们提供一个“手动摆盘”的兜底路径，避免任务进入“Tag 满足但不可解”死循环。
                msg_lower = str(craft_exc).lower()
                
                # Check if we have a tag-compatible recipe identified earlier (even if not strictly matching)
                # 'best_recipe' variable from earlier scope is not directly available here unless we use the one passed to craft()
                # But we know 'executable_recipe' was what we tried to craft.
                
                if ("missing ingredient" in msg_lower or "timed out" in msg_lower) and executable_recipe:
                     logger.warning(
                        f"[craft] bot.craft() failed ({msg_lower}) for {item_name}. "
                        f"Attempting generic manual craft fallback..."
                    )
                     try:
                        # Ensure window is open if needed
                        use_window = None
                        if executable_recipe.requiresTable:
                            # If bot.craft failed/timeout, window might NOT be open.
                            # We MUST try to ensure it is open.
                            current_window = self._bot.currentWindow
                            
                            if not current_window or "crafting_table" not in str(current_window.title).lower():
                                # Try to open table manually
                                if crafting_table is None:
                                     # Re-find table if variable is lost (unlikely but safe)
                                     crafting_table = self._bot.findBlock({
                                        "matching": lambda b: b.name == "crafting_table",
                                        "maxDistance": 2
                                     })
                                
                                if crafting_table:
                                    logger.info(f"[craft] Manually opening crafting table at {crafting_table.position}")
                                    
                                    # Async open with navigation
                                    # Async open with navigation
                                    async def open_table():
                                        try:
                                            # 1. Navigate to be close enough
                                            try:
                                                pos = crafting_table.position
                                                logger.info(f"[craft] Navigating to {pos}...")
                                                await self._navigate_to_block(int(pos.x), int(pos.y), int(pos.z))
                                            except Exception as nav_err:
                                                logger.warning(f"[craft] Navigation to table failed: {nav_err}")

                                            # 2. Look at it
                                            try:
                                                # Offset to look at center of block
                                                center = crafting_table.position.offset(0.5, 0.5, 0.5)
                                                logger.info(f"[craft] Looking at {center}...")
                                                await self._bot.lookAt(center)
                                            except Exception:
                                                pass

                                            # 3. Activate
                                            logger.info("[craft] Activating block...")
                                            # Put await here, assuming javascript library handles promise awaiting if available.
                                            # If it's void/sync, await might warn or be no-op. Safe to try.
                                            try:
                                                self._bot.activateBlock(crafting_table)
                                            except Exception as act_err:
                                                 logger.error(f"[craft] activateBlock failed: {act_err}")
                                            
                                            # Initial wait for server/bridge response
                                            logger.info("[craft] Waiting for window to open...")
                                            await asyncio.sleep(1.0)

                                            # 4. Wait for window to open
                                            # Reduce polling frequency to avoid flooding the bridge (0.1s -> 1.0s)
                                            for i in range(15): # 15 seconds max
                                                try:
                                                    w = self._bot.currentWindow
                                                    if w:
                                                        # Log window details for debugging
                                                        w_title = str(w.title).lower() if w.title else "none"
                                                        w_type = str(w.type) if hasattr(w, 'type') else "none"
                                                        
                                                        # Calculate slot length safely via proxy
                                                        try:
                                                            w_len = int(w.slots.length)
                                                        except:
                                                            w_len = 0
                                                            
                                                        logger.info(f"[craft] Detected open window: title='{w_title}', type='{w_type}', slots={w_len}")
                                                        
                                                        # Multi-factor check: Title OR Type OR Slot Count (46 = 3x3 table + inventory)
                                                        is_crafting = (
                                                            "crafting_table" in w_title or 
                                                            "工作台" in w_title or
                                                            "crafting" in w_type or
                                                            w_len == 46
                                                        )
                                                        
                                                        if is_crafting:
                                                            logger.info(f"[craft] Verified crafting table detected!")
                                                            return w
                                                except Exception as e:
                                                    logger.warning(f"[craft] Window check warning: {e}")
                                                await asyncio.sleep(1.0)
                                            logger.warning("[craft] Window open poll timed out.")
                                            return None
                                        except Exception as e:
                                            logger.error(f"[craft] open_table logic crashed: {e}")
                                            return None

                                    use_window = await asyncio.wait_for(open_table(), timeout=40.0) # ample time for nav + open
                            else:
                                use_window = current_window
                                
                            if not use_window:
                                 raise RuntimeError("Failed to open crafting table window for manual fallback.")
                        
                        # Execute manual craft
                        await asyncio.wait_for(
                            asyncio.get_event_loop().run_in_executor(
                                None,
                                lambda: self._manual_craft_generic_sync(executable_recipe, int(count), use_window)
                            ),
                            timeout=timeout * 3 # Give manual craft plenty of time
                        )

                        return ActionResult(
                            success=True,
                            action="craft",
                            message=f"成功合成 {count} 个 {item_name} (Manual Fallback)",
                            status=ActionStatus.SUCCESS,
                            data={"crafted": {item_name: count}, "mode": "manual_generic"},
                            duration_ms=int((time.time() - start_time) * 1000)
                        )
                     except Exception as manual_exc:
                        logger.error(f"[craft] Manual generic fallback failed: {manual_exc}")
                        # Fallthrough to raise original exception

                if "missing ingredient" in msg_lower and item_name == "crafting_table" and crafting_table is None:
                    # Deprecated specific fallback (kept for safety if generic fails or recipe object issue)
                    pass 
                
                raise craft_exc
            
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
            data = None
            if "missing" in error_msg.lower():
                error_code = "INSUFFICIENT_MATERIALS"

                # 尽可能把缺失材料补齐到 data.missing，避免上层拿到空上下文
                missing: Dict[str, int] = {}
                try:
                    if executable_recipe is not None:
                        required = self._extract_recipe_materials(executable_recipe)
                        for material_id, required_count in required.items():
                            material_name = self._get_item_name_by_id(material_id)
                            if not material_name:
                                continue
                            have = int(inventory.get(material_name, 0))
                            need = int(required_count) * int(count)
                            if have < need:
                                missing[material_name] = need - have
                except Exception:
                    pass

                # 兜底：从错误文本里解析出 missing ingredient XXX
                if not missing:
                    m = re.search(r"missing ingredient\s+([a-z0-9_]+)", error_msg.lower())
                    if m:
                        missing[m.group(1)] = 1

                if missing:
                    data = {"missing": missing, "item": item_name}
            return ActionResult(
                success=False,
                action="craft",
                message=error_msg,
                status=ActionStatus.FAILED,
                error_code=error_code,
                data=data,
                duration_ms=int((time.time() - start_time) * 1000)
            )

    # -------------------------------------------------------------------------
    # Manual crafting fallback (safe, protocol-compliant)
    # -------------------------------------------------------------------------
    def _manual_craft_crafting_table_sync(self, plank_item_name: str, count: int = 1) -> None:
        """
        手动摆盘合成 crafting_table（2x2）

        适用场景：
        - Mineflayer 的 recipe 示例材料导致 strict missing ingredient
        - 服务器允许 tag(#planks) 变体，但 Mineflayer 不会自动替代

        实现方式：
        - 通过 bot.clickWindow 操作玩家自身 2x2 crafting grid
        - 放入 4 个 plank_item_name
        - shift-click 结果槽取出 crafting_table

        注意：
        - 该方法是阻塞的，必须在 executor 中调用
        - Slot 约定基于 prismarine-windows 的 player inventory window：
          0: crafting output, 1-4: crafting input
        """
        import time as _time

        OUTPUT_SLOT = 0
        INPUT_SLOTS = [1, 2, 3, 4]

        def _item_name(it) -> Optional[str]:
            if it is None:
                return None
            try:
                return it.name
            except Exception:
                try:
                    return it.get("name")
                except Exception:
                    return None

        def _item_count(it) -> int:
            if it is None:
                return 0
            try:
                return int(it.count)
            except Exception:
                try:
                    return int(it.get("count", 0))
                except Exception:
                    return 0

        def _slots_list() -> List[Any]:
            try:
                slots = getattr(self._bot.inventory, "slots", None)
                return list(slots) if slots is not None else []
            except Exception:
                return []

        def _find_source_slot(min_needed: int) -> int:
            slots = _slots_list()
            best_idx = -1
            best_count = 0
            for idx, it in enumerate(slots):
                if _item_name(it) == plank_item_name:
                    c = _item_count(it)
                    if c >= min_needed and c > best_count:
                        best_idx = idx
                        best_count = c
            return best_idx

        # 每次 craft 需要 4 个木板
        for _ in range(int(count)):
            source = _find_source_slot(4)
            if source < 0:
                raise RuntimeError(f"manual craft missing material: {plank_item_name} x4")

            # 1) 拿起整叠木板
            self._bot.clickWindow(source, 0, 0)  # left click
            _time.sleep(0.05)

            # 2) 右键依次放 1 个到 2x2 合成格
            for slot in INPUT_SLOTS:
                self._bot.clickWindow(slot, 1, 0)  # right click place 1
                _time.sleep(0.05)

            # 3) 把剩余木板放回原槽位（避免鼠标光标持物导致后续 desync）
            self._bot.clickWindow(source, 0, 0)
            _time.sleep(0.05)

            # 4) shift-click 取走结果（工作台）
            self._bot.clickWindow(OUTPUT_SLOT, 0, 1)  # mode=1 shift-click
            _time.sleep(0.1)

    def _manual_craft_generic_sync(self, recipe, count: int = 1, crafting_table_window=None) -> None:
        """
        通用手动合成 (First Principles fallback)
        
        解析 recipe.inShape，根据背包实际拥有的 Tag 等价物，手动执行 clickWindow。
        支持 2x2 (Inventory) 和 3x3 (Crafting Table)。
        
        Args:
            recipe: Mineflayer Recipe 对象
            count: 合成次数
            crafting_table_window: 如果是 3x3，传入打开的窗口对象；如果是 2x2，传 None (使用 player inventory)
        """
        import time as _time
        from bot.tag_resolver import get_tag_resolver
        tag_resolver = get_tag_resolver()

        # 1. 确定窗口和槽位映射
        # Inventory Window (id=0): Output=0, Input=1,2,3,4 (2x2)
        # Crafting Window: Output=0, Input=1..9 (3x3)
        window = crafting_table_window if crafting_table_window else self._bot.inventory
        
        is_3x3 = (crafting_table_window is not None)
        GRID_WIDTH = 3 if is_3x3 else 2
        
        # 槽位偏移 (Output slot index usually 0 for widely used windows)
        # 3x3 Input slots: 1,2,3 / 4,5,6 / 7,8,9
        # 2x2 Input slots: 1,2 / 3,4
        def get_grid_slot(row, col):
            if is_3x3:
                return 1 + row * 3 + col
            else:
                return 1 + row * 2 + col

        # 2. Preparation: Clear Cursor & Grid
        # 这一步至关重要：如果 Grid 里有上次残留的物品，配方形状就会错乱
        
        # Clear Grid Slots
        # 3x3: 1..9, 2x2: 1..4
        grid_slots_count = 9 if is_3x3 else 4
        for i in range(1, grid_slots_count + 1):
            slot_item = window.slots[i]
            if slot_item:
                # Shift click to move back to inventory
                self._bot.clickWindow(i, 0, 1)
                _time.sleep(0.2) # Wait for server update
        
        # 3. 解析配方形状并准备材料映射
        # Capture snapshot for later verification
        inventory_snapshot = {}
        for item in self._bot.inventory.items():
            inventory_snapshot[item.name] = inventory_snapshot.get(item.name, 0) + item.count

        # inShape: [row][col] -> RecipeItem (has id) or List of RecipeItems
        # 我们需要将其展平为一个 Plan: [(slot_idx, item_id_needed)]
        # 并提前解析出 "我应该用哪个 item 来满足 item_id_needed"
        
        shape = recipe.inShape # List[List[Item]]
        if not shape:
            raise RuntimeError("Recipe has no inShape")
        
        # 预先获取背包快照
        slots = getattr(window, "slots", [])
        if not slots:
             # 如果是 window 对象，可能 slots 在 .slots 属性 (Array)
             pass
        
        # 辅助函数：找可用材料槽位
        # ⚠️ CRITICAL FIX: Must skip crafting slots (0-grid_max) to avoid cannibalizing placed ingredients!
        # For 3x3 table (window), slots 0-9 are crafting. Inventory starts at 10.
        # For 2x2 inventory (id 0), slots 0-4 are crafting. Armor 5-8. Main Inv 9+.
        # We start searching from 9 or 10 depending on window type.
        search_start = 10 if is_3x3 else 9 # Safe lower bound for main inventory
        
        def find_material_slot(target_id: int) -> int:
            # Fix: Proxy has no len(), use .length
            slots_len = int(window.slots.length)
            
            # 优先找精确匹配
            for i in range(search_start, slots_len):
                item = window.slots[i]
                if item and item.type == target_id:
                    return i
            
            # Tag 匹配
            target_name = self._get_item_name_by_id(target_id)
            if not target_name:
                return -1
                
            # 查找所有等价物
            equivs = tag_resolver.get_equivalents(target_name) # includes self
            for i in range(search_start, slots_len):
                item = window.slots[i]
                if item and item.name in equivs:
                    return i
            return -1

        # 3. 执行合成循环
        for _ in range(int(count)):
            used_materials_slots = {} # slot -> count_taken_this_round (简单起见，每次都重新扫)
            
            # Plan execution for one craft
            # 遍历 shape，把材料放上去
            # 遍历 shape，把材料放上去
            for r, row_data in enumerate(shape):
                for c, ingredient in enumerate(row_data):
                    # ingredient 可能是 Item 或 [Item] (variation)
                    required_id = None
                    if ingredient is None:
                        continue

                    if isinstance(ingredient, list):
                         if len(ingredient) > 0:
                             required_id = ingredient[0].id
                    elif hasattr(ingredient, 'id'):
                        required_id = ingredient.id
                    
                    if required_id is None:
                        continue # Empty slot
                    
                    if required_id < 0:
                        # id=-1 usually means "empty" or "no item required"
                        continue

                    grid_slot = get_grid_slot(r, c)
                    
                    # 找到源材料
                    src_slot = find_material_slot(required_id)
                    if src_slot < 0:
                         # Try to resolve variant names to log helpful error
                        needed_name = self._get_item_name_by_id(required_id)
                        raise RuntimeError(f"Manual craft: missing material for shape[{r}][{c}] (id={required_id}/{needed_name})")
                    
                    # Pickup
                    self._bot.clickWindow(src_slot, 0, 0)
                    _time.sleep(0.2)
                    # Place 1
                    self._bot.clickWindow(grid_slot, 1, 0)
                    _time.sleep(0.3)
                    # Put back
                    self._bot.clickWindow(src_slot, 0, 0)
                    _time.sleep(0.3)
            
            # Take result
            # Shift-click output to inventory
            self._bot.clickWindow(0, 0, 1) 
            _time.sleep(1.0) # Give server time to sync inventory

            # Close window to ensure transaction commits and inventory syncs
            # If we opened a table, we must close it.
            if window.type != 'minecraft:inventory':
                 self._bot.closeWindow(window)
                 _time.sleep(0.5)
            
            # Verify result
            start = _time.time()
            success_verify = False
            if crafting_table_window:
                 try:
                     self._bot.closeWindow(crafting_table_window)
                     _time.sleep(0.2)
                 except:
                     pass
            
            # 4. State Verification (Essential for prevention of infinite loops)
            # Wait for inventory to update
            try:
                result_id = recipe.result.id
                target_name = self._get_item_name_by_id(result_id)
                start_count = inventory_snapshot.get(target_name, 0) # Snapshot might be old?
                
                # Get fresh count
                current_inv = {}
                for item in self._bot.inventory.items():
                    current_inv[item.name] = current_inv.get(item.name, 0) + item.count
                start_count = current_inv.get(target_name, 0)

                success_verify = False
                for _v in range(20): # Wait up to 2.0s
                    _time.sleep(0.1)
                    # Check count
                    now_inv = {}
                    for item in self._bot.inventory.items():
                        now_inv[item.name] = now_inv.get(item.name, 0) + item.count
                    
                    if now_inv.get(target_name, 0) > start_count:
                        success_verify = True
                        break
                
                if not success_verify:
                    raise RuntimeError(f"Manual craft verification failed: {target_name} count did not increase.")
                    
            except Exception as e:
                # Don't block flow if verification logic errors, but do log it
                # Actually, if verify fails, we SHOULD error out to let retry happen logic properly.
                raise RuntimeError(f"Manual craft verification error: {e}")
            
            # 如果产生了多余 items 在 grid 里（某些配方），通常 shift-click 会自动清空 grid 吗？
            # 不会，shift-click result 只拿结果。
            # 原料被消耗了。如果配方正确，grid 应该空了（或剩下 bucket 等副产物）。
            # 简单起见，不处理副产物回收，依靠 inventory 同步。


    def _find_executable_recipe(
        self, 
        recipes: list, 
        inventory: Dict[str, int],
        craft_count: int = 1
    ) -> tuple:
        """
        找到第一个可执行的配方

        重要：为避免“误判可合成 → 盲目 craft() → Mineflayer 报 missing ingredient”，
        这里使用 recipe.delta 做材料推导，并按 **具体物品** 与背包严格匹配。
        
        Args:
            recipes: 配方列表
            inventory: 当前背包 {item_name: count}
            craft_count: 要合成的数量
            
        Returns:
            (recipe, missing_materials)
            - 成功: (recipe, {})
            - 失败: (None, {material_name: required_count})
        """
        parse_failures = 0
        parseable_recipes = 0
        best_missing = {}  # 记录最接近成功的配方缺少什么
        best_score = None  # (needs_mining_penalty, total_missing, missing_types)

        def _missing_score(missing: Dict[str, int]) -> tuple:
            """
            配方选择启发式：
            1) 优先选择“不需要额外采集”的缺料（例如缺 cherry_planks 且背包已有 cherry_log）
            2) 其次总缺口数量最小
            3) 再其次缺料种类最少
            """
            needs_mining = 0
            total = 0
            for k, v in missing.items():
                if k.startswith("id:"):
                    # 未知 ID 一律视为“需要额外处理”，优先级最低
                    needs_mining += 1
                    total += int(v)
                    continue

                total += int(v)

                # 木板缺料：如果背包里已有对应 log/stem，则不需要采集，只需要 craft 一步
                if k.endswith("_planks"):
                    base = k[: -len("_planks")]
                    if inventory.get(f"{base}_log", 0) > 0 or inventory.get(f"{base}_stem", 0) > 0:
                        continue

                needs_mining += 1

            return (needs_mining, total, len(missing))
        
        best_recipe = None
        best_recipe_missing = {}
        best_score = None 

        # New: Track strict match to avoid "missing ingredient" crash in bot.craft()
        # If we have multiple recipes (e.g. stick from oak, stick from birch), we MUST pick the one 
        # that matches our actual inventory items.
        exact_match_found = False

        for recipe in recipes:
            try:
                required_materials = self._extract_recipe_materials(recipe)
            except Exception:
                parse_failures += 1
                continue

            parseable_recipes += 1
            
            can_craft_tag = True
            is_strict_match = True
            recipe_missing = {}
            
            from bot.tag_resolver import get_tag_resolver
            tag_resolver = get_tag_resolver()
            
            for material_id, required_count in required_materials.items():
                material_name = self._get_item_name_by_id(material_id)
                if not material_name:
                    can_craft_tag = False
                    is_strict_match = False
                    recipe_missing[f"id:{material_id}"] = required_count * craft_count
                    continue

                needed = int(required_count) * int(craft_count)
                
                # 1. 精确匹配检查
                available_strict = int(inventory.get(material_name, 0))
                
                if available_strict < needed:
                    is_strict_match = False
                    
                    # 2. Tag 等价检查 (Soft Match)
                    try:
                        total_equiv = int(tag_resolver.get_available_count(material_name, inventory))
                    except Exception:
                        total_equiv = available_strict

                    if total_equiv < needed:
                        can_craft_tag = False
                        # 记录真正的缺口 (基于 Tag 总量)
                        recipe_missing[material_name] = needed - total_equiv
                
            if can_craft_tag:
                if is_strict_match:
                    # 完美匹配：配方要求的材料我们背包里都有 (e.g. Recipe=Cherry->Stick, Inv=Cherry)
                    logger.info(f"[craft] Exact strict recipe match found! using {recipe}")
                    return (recipe, {})
                
                # Tag 匹配但非严格匹配 (e.g. Recipe=Oak->Stick, Inv=Cherry)
                # 暂时存下来，如果后面没有 Strict Match 再用这个兜底
                # 注意：Mineflayer bot.craft 可能对非严格匹配报错，除非它是通用 Tag 配方
                if not exact_match_found: 
                    # Only overwrite if we haven't found a better one yet
                    # We prefer the one with fewer strict mismatches if possible? 
                    # Actually, if we have multiple "Tag Compatible" recipes, we should pick the one 
                    # where we have the most *strict* ingredients.
                    
                    # For now just save the first tag-compatible one, or maybe last?
                    # Ideally we want to find the one that IS strict match.
                    if best_recipe is None:
                        logger.info(f"[craft] Found tag-compatible recipe (fallback): {recipe}")
                        best_recipe = recipe
                        best_recipe_missing = {}
            
            # 如果即使 Tag 也不满足，记录缺口得分，以便报错时告诉用户缺什么
            if not can_craft_tag:
                score = _missing_score(recipe_missing)
                # 如果这个配方的缺口比之前的更小，记录它为“最佳错误提示”
                if best_score is None or score < best_score:
                    best_recipe_missing = recipe_missing
                    best_score = score

        if exact_match_found:
             # Should have returned already
             pass

        if best_recipe:
            logger.info("Using best tag-compatible recipe (Strict match failed)")
            return (best_recipe, {})
            
        # 所有配方都不可行
        if parseable_recipes > 0:
             return (None, best_recipe_missing)

        # 所有配方都解析失败（delta 不可用/Proxy 无法读取）
        if parseable_recipes == 0 and parse_failures > 0:
            return (None, {"__recipe_parse_failed__": parse_failures})

        return (None, best_missing)
    
    def _extract_recipe_materials(self, recipe) -> Dict[int, int]:
        """
        从配方中提取所需材料
        
        Returns:
            {item_id: required_count}
        """
        materials: Dict[int, int] = {}
        
        # 🔴 只依赖 delta：避免 JSPyBridge 对 inShape/ingredients 的 Proxy/RecipeItem 解析不稳定
        if not hasattr(recipe, "delta") or not recipe.delta:
            raise ValueError("recipe has no delta")

        delta_items = list(recipe.delta)  # JS Proxy -> Python list（若不可迭代会抛）
        for delta_item in delta_items:
            try:
                # 兼容 dict / proxy-object 两种形态
                if isinstance(delta_item, dict):
                    raw_id = delta_item.get("id")
                    raw_count = delta_item.get("count")
                else:
                    raw_id = getattr(delta_item, "id", None)
                    raw_count = getattr(delta_item, "count", None)

                item_id = _coerce_js_int(raw_id)
                count = _coerce_js_int(raw_count)
            except Exception as exc:
                # 任一项解析失败：整条 recipe 不可信，避免“漏材料 → 误判可合成”
                raise TypeError(f"failed to parse recipe.delta item: {delta_item!r}") from exc

            if count < 0:  # 负数表示消耗
                if item_id > 0:
                    materials[item_id] = materials.get(item_id, 0) + abs(int(count))

        # 安全阀：delta 没有任何消耗项时，不把它当作“无需材料即可合成”
        if not materials:
            raise ValueError("recipe.delta has no consumptions")
        
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

            # 距离足够近时，直接给（避免“已贴脸但 pathfinder 认为没到达”导致 give 失败）
            reach_distance = 3.0
            try:
                bot_pos = self._bot.entity.position
                target_pos = player.entity.position
                try:
                    dist = float(bot_pos.distanceTo(target_pos))
                except Exception:
                    dx = float(bot_pos.x) - float(target_pos.x)
                    dy = float(bot_pos.y) - float(target_pos.y)
                    dz = float(bot_pos.z) - float(target_pos.z)
                    dist = (dx * dx + dy * dy + dz * dz) ** 0.5
            except Exception:
                dist = 9999.0

            if dist > reach_distance:
                # 先走到玩家附近
                goto_result = await self.goto(f"@{player_name}", timeout=timeout/2)
                if not goto_result.success:
                    # goto 失败但如果此刻已经足够近，仍然尝试 toss（常见于高低差/小障碍）
                    try:
                        bot_pos = self._bot.entity.position
                        target_pos = player.entity.position
                        try:
                            dist2 = float(bot_pos.distanceTo(target_pos))
                        except Exception:
                            dx = float(bot_pos.x) - float(target_pos.x)
                            dy = float(bot_pos.y) - float(target_pos.y)
                            dz = float(bot_pos.z) - float(target_pos.z)
                            dist2 = (dx * dx + dy * dy + dz * dz) ** 0.5
                    except Exception:
                        dist2 = 9999.0

                    if dist2 > reach_distance:
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
    
    async def pickup(
        self,
        target: Optional[str] = None,
        count: int = -1,
        radius: int = 16,
        timeout: float = 60.0
    ) -> ActionResult:
        """
        拾取附近的掉落物
        
        简单接口：
        - LLM 只需说 {"action": "pickup", "target": "apple"}
        
        深度功能：
        - 自动寻找最近的掉落物 → 寻路走过去 → 校验是否捡到 → 找下一个
        - 支持指定物品类型过滤
        - 支持指定拾取数量
        - 30秒无进度超时保护
        
        Args:
            target: 目标物品类型 (可选，None 或 "all" 表示拾取所有)
            count: 拾取数量 (-1 表示尽可能多捡)
            radius: 搜索半径 (格)
            timeout: 超时时间 (秒)
            
        Returns:
            ActionResult
            data: {"picked_up": {"apple": 3, "oak_log": 5}, "total": 8}
        """
        start_time = time.time()
        picked_up: Dict[str, int] = {}
        total_picked = 0
        unreachable_entities: Dict[int, int] = {}
        MAX_UNREACHABLE_ATTEMPTS = 3
        
        # 进度感知超时 (30秒无进度)
        self._progress_timer = ProgressTimer(timeout_seconds=30.0)
        
        # 目标物品类型 (None 表示捡所有)
        target_item_name: Optional[str] = None
        if target and target.lower() not in ("all", "any", "*", ""):
            target_item_name = target.lower()
        
        # 无限拾取模式还是指定数量
        unlimited_mode = (count <= 0)
        remaining = count if count > 0 else float('inf')
        
        logger.info(f"[pickup] Starting: target={target_item_name or 'all'}, count={count}, radius={radius}")
        
        try:
            while remaining > 0:
                # 检查总超时
                if time.time() - start_time > timeout:
                    msg = f"拾取超时，已捡起 {total_picked} 个物品"
                    return ActionResult(
                        success=total_picked > 0,
                        action="pickup",
                        message=msg,
                        status=ActionStatus.TIMEOUT if total_picked == 0 else ActionStatus.SUCCESS,
                        error_code="TIMEOUT" if total_picked == 0 else None,
                        data={"picked_up": picked_up, "total": total_picked},
                        duration_ms=int((time.time() - start_time) * 1000)
                    )
                
                # 检查进度超时 (30秒无进度)
                if self._progress_timer.is_expired():
                    msg = f"拾取停滞（30秒无进度），已捡起 {total_picked} 个物品"
                    return ActionResult(
                        success=total_picked > 0,
                        action="pickup",
                        message=msg,
                        status=ActionStatus.SUCCESS if total_picked > 0 else ActionStatus.FAILED,
                        error_code="NO_PROGRESS" if total_picked == 0 else None,
                        data={"picked_up": picked_up, "total": total_picked},
                        duration_ms=int((time.time() - start_time) * 1000)
                    )
                
                # 1. 收集附近掉落物并按距离排序
                item_entities = self._list_item_entities(target_item_name, radius)
                
                if not item_entities:
                    # 没有更多掉落物了
                    if total_picked > 0:
                        msg = f"附近没有更多掉落物了，共捡起 {total_picked} 个物品"
                        return ActionResult(
                            success=True,
                            action="pickup",
                            message=msg,
                            status=ActionStatus.SUCCESS,
                            data={"picked_up": picked_up, "total": total_picked},
                            duration_ms=int((time.time() - start_time) * 1000)
                        )
                    else:
                        target_desc = target_item_name or "掉落物"
                        msg = f"附近 {radius} 格内没有找到 {target_desc}"
                        return ActionResult(
                            success=False,
                            action="pickup",
                            message=msg,
                            status=ActionStatus.FAILED,
                            error_code="TARGET_NOT_FOUND",
                            data={"picked_up": picked_up, "total": 0},
                            duration_ms=int((time.time() - start_time) * 1000)
                        )
                
                # 过滤掉重复失败的目标，避免原地卡死
                available_entities = [
                    entity for entity in item_entities
                    if unreachable_entities.get(entity["entity_id"], 0) < MAX_UNREACHABLE_ATTEMPTS
                ]
                
                if not available_entities:
                    msg = f"附近掉落物均不可达，已捡起 {total_picked} 个物品"
                    return ActionResult(
                        success=total_picked > 0,
                        action="pickup",
                        message=msg,
                        status=ActionStatus.SUCCESS if total_picked > 0 else ActionStatus.FAILED,
                        error_code=None if total_picked > 0 else "ITEM_UNREACHABLE",
                        data={"picked_up": picked_up, "total": total_picked},
                        duration_ms=int((time.time() - start_time) * 1000)
                    )
                
                progress_this_cycle = False
                
                for item_entity in available_entities:
                    if remaining <= 0:
                        break
                    
                    item_pos = item_entity.get("position")
                    item_name = item_entity.get("name", "unknown")
                    entity_id = item_entity.get("entity_id")
                    
                    logger.info(
                        f"[pickup] Target item: {item_name} at ({item_pos['x']:.1f}, {item_pos['y']:.1f}, {item_pos['z']:.1f}) "
                        f"(attempt {unreachable_entities.get(entity_id, 0)+1})"
                    )
                    
                    inventory_before = self._get_inventory_count(item_name)
                    
                    moved_close = await self._navigate_close_to_position(
                        item_pos,
                        timeout=10.0,
                        reach=1.0
                    )
                    
                    if not moved_close:
                        unreachable_entities[entity_id] = unreachable_entities.get(entity_id, 0) + 1
                        logger.debug(f"[pickup] Failed to reach {item_name} ({entity_id}), mark unreachable={unreachable_entities[entity_id]}")
                        continue
                    
                    # 等待 inventory 同步
                    await asyncio.sleep(0.3)
                    inventory_after = self._get_inventory_count(item_name)
                    actually_picked = inventory_after - inventory_before
                    
                    if actually_picked > 0:
                        picked_up[item_name] = picked_up.get(item_name, 0) + actually_picked
                        total_picked += actually_picked
                        remaining -= actually_picked
                        self._progress_timer.reset("item_picked")
                        unreachable_entities.pop(entity_id, None)
                        progress_this_cycle = True
                        logger.info(f"[pickup] Picked up {actually_picked} x {item_name}, total: {total_picked}")
                        break
                    else:
                        if not self._entity_exists(entity_id):
                            logger.debug(f"[pickup] Item {item_name} disappeared but not in inventory")
                            self._progress_timer.reset("item_disappeared")
                            progress_this_cycle = True
                        else:
                            unreachable_entities[entity_id] = unreachable_entities.get(entity_id, 0) + 1
                            logger.debug(f"[pickup] Item {item_name} still exists after close approach")
                    
                    await asyncio.sleep(0.2)
                
                if not progress_this_cycle:
                    await asyncio.sleep(0.2)
            
            # 达到目标数量
            msg = f"成功捡起 {total_picked} 个物品"
            return ActionResult(
                success=True,
                action="pickup",
                message=msg,
                status=ActionStatus.SUCCESS,
                data={"picked_up": picked_up, "total": total_picked},
                duration_ms=int((time.time() - start_time) * 1000)
            )
            
        except Exception as e:
            logger.error(f"pickup failed: {e}")
            return ActionResult(
                success=total_picked > 0,
                action="pickup",
                message=str(e) if total_picked == 0 else f"部分成功，已捡起 {total_picked} 个",
                status=ActionStatus.FAILED,
                error_code="UNKNOWN",
                data={"picked_up": picked_up, "total": total_picked},
                duration_ms=int((time.time() - start_time) * 1000)
            )
        finally:
            self._progress_timer = None
    
    def _list_item_entities(
        self,
        target_name: Optional[str] = None,
        radius: int = 16
    ) -> List[Dict[str, Any]]:
        """
        获取附近掉落物实体列表（按距离升序）。
        """
        entities: List[Dict[str, Any]] = []
        try:
            bot_pos = self._bot.entity.position
            
            for entity_id in self._bot.entities:
                entity = self._bot.entities[entity_id]
                
                if entity.name != "item":
                    continue
                
                item_name = None
                try:
                    if hasattr(entity, 'metadata') and entity.metadata:
                        for meta in entity.metadata:
                            if isinstance(meta, dict) and 'itemId' in meta:
                                item_id = meta.get('itemId')
                                item_info = self._mcData.items[item_id]
                                if item_info:
                                    item_name = item_info.name
                                break
                            elif isinstance(meta, dict) and 'nbtData' in meta:
                                pass
                    
                    if not item_name:
                        try:
                            dropped_item = entity.getDroppedItem()
                            if dropped_item:
                                item_name = dropped_item.name
                        except Exception:
                            pass
                    
                    if not item_name:
                        item_name = getattr(entity, 'displayName', None) or "unknown"
                except Exception as e:
                    logger.debug(f"Failed to get item name for entity {entity_id}: {e}")
                    item_name = "unknown"
                
                if target_name:
                    if item_name and target_name.lower() not in item_name.lower():
                        continue
                
                try:
                    e_pos = entity.position
                    dist = ((e_pos.x - bot_pos.x) ** 2 + (e_pos.y - bot_pos.y) ** 2 + (e_pos.z - bot_pos.z) ** 2) ** 0.5
                    
                    if dist <= radius:
                        entities.append({
                            "entity_id": entity_id,
                            "name": item_name or "unknown",
                            "position": {"x": e_pos.x, "y": e_pos.y, "z": e_pos.z},
                            "distance": dist
                        })
                except Exception as e:
                    logger.debug(f"Failed to get position for entity {entity_id}: {e}")
                    continue
            
            entities.sort(key=lambda e: e["distance"])
            return entities
        except Exception as e:
            logger.warning(f"_list_item_entities failed: {e}")
            return []
    
    def _find_nearest_item_entity(
        self,
        target_name: Optional[str] = None,
        radius: int = 16
    ) -> Optional[Dict[str, Any]]:
        items = self._list_item_entities(target_name, radius)
        return items[0] if items else None
    
    async def _navigate_close_to_position(
        self,
        position: Dict[str, float],
        timeout: float = 10.0,
        reach: float = 1.0
    ) -> bool:
        """
        主动贴脸导航到指定坐标附近（默认 1 格内）。
        """
        try:
            goals = self._pathfinder.goals
            target_x = math.floor(position["x"])
            target_y = math.floor(position["y"])
            target_z = math.floor(position["z"])
            
            goal = None
            if hasattr(goals, "GoalBlock"):
                goal = goals.GoalBlock(target_x, target_y, target_z)
            else:
                goal = goals.GoalNear(target_x, target_y, target_z, max(1, int(math.ceil(reach))))
            
            self._bot.pathfinder.setGoal(goal)
            
            try:
                await asyncio.wait_for(
                    self._wait_for_goal_reached(saved_goal=goal),
                    timeout=timeout
                )
            except asyncio.TimeoutError:
                logger.debug(f"[pickup] Navigation to ({target_x},{target_y},{target_z}) timed out")
                return False
            except RuntimeError as e:
                logger.debug(f"[pickup] Navigation runtime error: {e}")
                return False
            finally:
                try:
                    self._bot.pathfinder.stop()
                except Exception:
                    pass
            
            # double-check距离，确保确实贴近
            pos = self._bot.entity.position
            dx = pos.x - position["x"]
            dy = pos.y - position["y"]
            dz = pos.z - position["z"]
            return (dx * dx + dy * dy + dz * dz) <= max(reach, 1.25) ** 2
        except Exception as e:
            logger.debug(f"[pickup] _navigate_close_to_position failed: {e}")
            return False
    
    def _entity_exists(self, entity_id) -> bool:
        """检查实体是否仍然存在"""
        try:
            return entity_id in self._bot.entities
        except:
            return False
    
    # ========================================================================
    # Semantic Perception - 语义感知动作
    # ========================================================================
    
    async def find_location(
        self,
        feature: str,
        radius: int = 64,
        count: int = 1
    ) -> ActionResult:
        """
        寻找符合特定特征的地点 (语义感知)
        
        简单接口：
        - LLM 只需说 {"action": "find_location", "feature": "highest"}
        
        深度功能：
        - Python 负责特征提取，返回候选坐标
        - LLM 不需要处理原始高程数据，只需处理语义化的结果
        
        支持的特征：
        - "highest": 视野内最高点 (山顶)
        - "lowest": 视野内最低点 (谷底/洞穴入口)
        - "flat": 平坦区域 (适合建筑)
        - "water": 最近的水源 (河边/海边)
        - "tree": 树木密集处 (森林)
        """
        start_time = time.time()
        feature = feature.lower().strip()
        
        try:
            bot_pos = self._bot.entity.position
            candidates = []
            
            if feature == "highest":
                # 算法：在半径内采样，寻找 Y 值最大的固体方块
                # 采样步长：radius / 10，最小 4 格，最大 8 格
                step = max(4, min(8, radius // 10))
                max_y = -999
                best_pos = None
                best_dist = float('inf')
                
                for x in range(int(bot_pos.x - radius), int(bot_pos.x + radius + 1), step):
                    for z in range(int(bot_pos.z - radius), int(bot_pos.z + radius + 1), step):
                        # 检查是否在圆形范围内
                        dx, dz = x - bot_pos.x, z - bot_pos.z
                        if dx * dx + dz * dz > radius * radius:
                            continue
                        
                        y = self._get_highest_block_y_at(x, z)
                        if y is not None:
                            dist = ((x - bot_pos.x)**2 + (z - bot_pos.z)**2) ** 0.5
                            # 优先选择更高的点，相同高度选择更近的
                            if y > max_y or (y == max_y and dist < best_dist):
                                max_y = y
                                best_pos = (x, y, z)
                                best_dist = dist
                
                if best_pos:
                    candidates.append({
                        "x": best_pos[0], 
                        "y": best_pos[1], 
                        "z": best_pos[2],
                        "description": f"Highest point (Y={best_pos[1]})",
                        "distance": round(best_dist, 1)
                    })
            
            elif feature == "lowest":
                # 算法：在半径内采样，寻找 Y 值最小的固体方块（避免空洞）
                step = max(4, min(8, radius // 10))
                min_y = 999
                best_pos = None
                best_dist = float('inf')
                
                for x in range(int(bot_pos.x - radius), int(bot_pos.x + radius + 1), step):
                    for z in range(int(bot_pos.z - radius), int(bot_pos.z + radius + 1), step):
                        dx, dz = x - bot_pos.x, z - bot_pos.z
                        if dx * dx + dz * dz > radius * radius:
                            continue
                        
                        y = self._get_highest_block_y_at(x, z)
                        if y is not None and y > 0:  # 避免虚空
                            dist = ((x - bot_pos.x)**2 + (z - bot_pos.z)**2) ** 0.5
                            if y < min_y or (y == min_y and dist < best_dist):
                                min_y = y
                                best_pos = (x, y, z)
                                best_dist = dist
                
                if best_pos:
                    candidates.append({
                        "x": best_pos[0],
                        "y": best_pos[1],
                        "z": best_pos[2],
                        "description": f"Lowest point (Y={best_pos[1]})",
                        "distance": round(best_dist, 1)
                    })
            
            elif feature == "flat":
                # 算法：寻找 5x5 范围内 Y 轴方差最小的区域
                step = 5  # 每 5 格检查一个候选中心
                best_pos = None
                best_variance = float('inf')
                best_dist = float('inf')
                
                for cx in range(int(bot_pos.x - radius), int(bot_pos.x + radius + 1), step):
                    for cz in range(int(bot_pos.z - radius), int(bot_pos.z + radius + 1), step):
                        dx, dz = cx - bot_pos.x, cz - bot_pos.z
                        if dx * dx + dz * dz > radius * radius:
                            continue
                        
                        # 计算 5x5 区域的 Y 值方差
                        heights = []
                        for ox in range(-2, 3):
                            for oz in range(-2, 3):
                                y = self._get_highest_block_y_at(cx + ox, cz + oz)
                                if y is not None:
                                    heights.append(y)
                        
                        if len(heights) >= 20:  # 至少 80% 有效
                            avg_y = sum(heights) / len(heights)
                            variance = sum((h - avg_y) ** 2 for h in heights) / len(heights)
                            dist = ((cx - bot_pos.x)**2 + (cz - bot_pos.z)**2) ** 0.5
                            
                            # 优先选择方差小的，方差相同选择更近的
                            if variance < best_variance or (variance == best_variance and dist < best_dist):
                                best_variance = variance
                                best_pos = (cx, int(avg_y) + 1, cz)  # +1 站在地面上
                                best_dist = dist
                
                if best_pos and best_variance < 2.0:  # 方差小于 2 才算平坦
                    candidates.append({
                        "x": best_pos[0],
                        "y": best_pos[1],
                        "z": best_pos[2],
                        "description": f"Flat area (variance={best_variance:.2f})",
                        "distance": round(best_dist, 1)
                    })
            
            elif feature == "water":
                # 使用 findBlocks 寻找水方块
                water_id = None
                try:
                    water_info = self._mcData.blocksByName.water
                    if water_info:
                        water_id = water_info.id
                except:
                    pass
                
                if water_id:
                    blocks = await asyncio.get_event_loop().run_in_executor(
                        None,
                        lambda: self._bot.findBlocks({
                            "matching": water_id,
                            "maxDistance": radius,
                            "count": count * 5  # 多找一些，以便筛选
                        })
                    )
                    
                    blocks = list(blocks) if blocks else []
                    
                    # 按距离排序，取最近的 count 个
                    water_blocks = []
                    for b in blocks:
                        dist = bot_pos.distanceTo(b)
                        water_blocks.append((b, dist))
                    
                    water_blocks.sort(key=lambda x: x[1])
                    
                    for b, dist in water_blocks[:count]:
                        candidates.append({
                            "x": int(b.x),
                            "y": int(b.y),
                            "z": int(b.z),
                            "description": "Water source",
                            "distance": round(dist, 1)
                        })
            
            elif feature in ("tree", "forest"):
                # 寻找原木密集区域
                log_types = ["oak_log", "birch_log", "spruce_log", "jungle_log", 
                            "acacia_log", "dark_oak_log", "cherry_log", "mangrove_log"]
                
                all_logs = []
                for log_name in log_types:
                    try:
                        log_info = self._mcData.blocksByName[log_name]
                        if log_info:
                            blocks = self._bot.findBlocks({
                                "matching": log_info.id,
                                "maxDistance": radius,
                                "count": 64
                            })
                            all_logs.extend(list(blocks) if blocks else [])
                    except:
                        pass
                
                if all_logs:
                    # 找最近的原木（树的起点）
                    nearest = min(all_logs, key=lambda b: bot_pos.distanceTo(b))
                    dist = bot_pos.distanceTo(nearest)
                    
                    candidates.append({
                        "x": int(nearest.x),
                        "y": int(nearest.y),
                        "z": int(nearest.z),
                        "description": f"Tree/Forest area ({len(all_logs)} logs nearby)",
                        "distance": round(dist, 1)
                    })
            
            else:
                return ActionResult(
                    success=False,
                    action="find_location",
                    message=f"Unknown feature type: {feature}. Supported: highest, lowest, flat, water, tree",
                    status=ActionStatus.FAILED,
                    error_code="INVALID_PARAM",
                    duration_ms=int((time.time() - start_time) * 1000)
                )
            
            if not candidates:
                return ActionResult(
                    success=False,
                    action="find_location",
                    message=f"No location found matching feature '{feature}' within {radius} blocks",
                    status=ActionStatus.FAILED,
                    error_code="TARGET_NOT_FOUND",
                    data={"feature": feature, "locations": []},
                    duration_ms=int((time.time() - start_time) * 1000)
                )
            
            return ActionResult(
                success=True,
                action="find_location",
                message=f"Found {len(candidates)} location(s) matching '{feature}'",
                status=ActionStatus.SUCCESS,
                data={"feature": feature, "locations": candidates},
                duration_ms=int((time.time() - start_time) * 1000)
            )
            
        except Exception as e:
            logger.error(f"find_location failed: {e}")
            return ActionResult(
                success=False,
                action="find_location",
                message=str(e),
                status=ActionStatus.FAILED,
                error_code="UNKNOWN",
                duration_ms=int((time.time() - start_time) * 1000)
            )
    
    def _get_highest_block_y_at(self, x: int, z: int) -> Optional[int]:
        """
        获取指定 X/Z 坐标处最高的固体方块 Y 坐标
        
        从 Bot 当前 Y 坐标开始向上/向下搜索，找到最高的可站立点
        """
        try:
            # 从高处开始向下搜索
            start_y = min(320, int(self._bot.entity.position.y) + 64)
            
            for y in range(start_y, -64, -1):
                try:
                    block = self._bot.blockAt({"x": x, "y": y, "z": z})
                    if block and block.name != "air" and block.name != "void_air" and block.name != "cave_air":
                        # 检查是否可站立（上方是空气）
                        above = self._bot.blockAt({"x": x, "y": y + 1, "z": z})
                        if above and above.name in ("air", "void_air", "cave_air"):
                            return y + 1  # 返回可站立的位置
                except:
                    pass
            
            return None
        except:
            return None
    
    async def patrol(
        self,
        center_x: int,
        center_z: int,
        radius: int = 10,
        duration: int = 30,
        timeout: float = 60.0
    ) -> ActionResult:
        """
        在指定区域内巡逻/游荡
        
        简单接口：
        - LLM 只需说 {"action": "patrol", "center_x": 100, "center_z": 200, "radius": 10}
        
        深度功能：
        - Python 自动生成随机巡逻路径点
        - 依次导航到各个路径点
        - 支持时间限制和超时保护
        """
        import random
        
        start_time = time.time()
        waypoints_visited = 0
        total_distance = 0.0
        
        logger.info(f"[patrol] Starting patrol at ({center_x}, {center_z}), radius={radius}, duration={duration}s")
        
        try:
            # 获取巡逻起点的 Y 坐标
            center_y = self._get_highest_block_y_at(center_x, center_z)
            if center_y is None:
                center_y = int(self._bot.entity.position.y)
            
            # 生成随机路径点（圆形分布）
            num_waypoints = max(3, duration // 10)  # 大约每 10 秒一个路径点
            waypoints = []
            
            for i in range(num_waypoints):
                # 使用极坐标生成随机点
                angle = random.uniform(0, 2 * 3.14159)
                r = random.uniform(radius * 0.3, radius)  # 避免太靠近中心
                
                wx = int(center_x + r * math.cos(angle))
                wz = int(center_z + r * math.sin(angle))
                wy = self._get_highest_block_y_at(wx, wz)
                
                if wy is not None:
                    waypoints.append((wx, wy, wz))
            
            if not waypoints:
                return ActionResult(
                    success=False,
                    action="patrol",
                    message="Failed to generate valid waypoints",
                    status=ActionStatus.FAILED,
                    error_code="TARGET_NOT_FOUND",
                    duration_ms=int((time.time() - start_time) * 1000)
                )
            
            logger.info(f"[patrol] Generated {len(waypoints)} waypoints")
            
            # 巡逻循环
            patrol_start = time.time()
            last_pos = self._bot.entity.position
            
            while time.time() - patrol_start < duration:
                # 检查总超时
                if time.time() - start_time > timeout:
                    break
                
                # 选择下一个路径点
                waypoint = random.choice(waypoints)
                target_str = f"{waypoint[0]},{waypoint[1]},{waypoint[2]}"
                
                logger.debug(f"[patrol] Moving to waypoint: {target_str}")
                
                # 导航到路径点（设置较短超时）
                goto_result = await self.goto(target_str, timeout=min(15, duration / 2))
                
                if goto_result.success:
                    waypoints_visited += 1
                    # 计算移动距离
                    curr_pos = self._bot.entity.position
                    dist = ((curr_pos.x - last_pos.x)**2 + 
                           (curr_pos.y - last_pos.y)**2 + 
                           (curr_pos.z - last_pos.z)**2) ** 0.5
                    total_distance += dist
                    last_pos = curr_pos
                    
                    # 短暂停留
                    await asyncio.sleep(random.uniform(0.5, 2.0))
                else:
                    # 导航失败，尝试下一个路径点
                    logger.debug(f"[patrol] Failed to reach waypoint, trying next")
                    await asyncio.sleep(0.5)
            
            actual_duration = time.time() - patrol_start
            
            return ActionResult(
                success=True,
                action="patrol",
                message=f"Patrol complete: visited {waypoints_visited} waypoints in {actual_duration:.1f}s",
                status=ActionStatus.SUCCESS,
                data={
                    "waypoints_visited": waypoints_visited,
                    "total_distance": round(total_distance, 1),
                    "duration_actual": round(actual_duration, 1)
                },
                duration_ms=int((time.time() - start_time) * 1000)
            )
            
        except Exception as e:
            logger.error(f"patrol failed: {e}")
            return ActionResult(
                success=waypoints_visited > 0,
                action="patrol",
                message=str(e) if waypoints_visited == 0 else f"Partial patrol: {waypoints_visited} waypoints",
                status=ActionStatus.FAILED,
                error_code="UNKNOWN",
                data={
                    "waypoints_visited": waypoints_visited,
                    "total_distance": round(total_distance, 1),
                    "duration_actual": round(time.time() - start_time, 1)
                },
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
    
    def _parse_goal(self, target):
        """
        解析目标为 Goal 对象
        
        支持的格式:
        - 字符串: "@PlayerName" 或 "x,y,z"
        - 字典: {"x": int, "y": int, "z": int}
        """
        goals = self._pathfinder.goals
        
        # 字典格式: {"x": int, "y": int, "z": int}
        if isinstance(target, dict):
            try:
                x = int(target.get("x", 0))
                y = int(target.get("y", 64))
                z = int(target.get("z", 0))
                logger.info(f"[DEBUG] goto dict target: ({x}, {y}, {z})")
                return goals.GoalBlock(x, y, z)
            except (ValueError, TypeError) as e:
                logger.warning(f"Invalid dict coordinates: {target}, error: {e}")
                return None
        
        # 确保是字符串
        if not isinstance(target, str):
            logger.warning(f"Unsupported target type: {type(target)}")
            return None
        
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
                # 重要：到玩家附近即可（GoalBlock 过于严格，容易出现“0.5 格还要精确踩点”的误判失败）
                # give/toss 等交互也不需要踩到同一格
                try:
                    return goals.GoalNear(int(pos.x), int(pos.y), int(pos.z), 2)
                except Exception:
                    # 兼容极端情况：GoalNear 不可用则退回 GoalBlock
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
                # 🔴 修复: 没有开始移动也没在目标，说明路径有问题
                logger.warning("Pathfinder did not start moving within 2s, path may be blocked")
                raise RuntimeError("Pathfinder failed to start - path may be blocked or unreachable")
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
                # 🔴 修复: 没有到达但停止了 → 抛出异常让 goto 返回失败
                pos = self._bot.entity.position
                logger.warning(f"[DEBUG] Pathfinder stopped without reaching goal! pos=({pos.x:.1f}, {pos.y:.1f}, {pos.z:.1f})")
                raise RuntimeError("Pathfinder stopped before reaching goal - path blocked or unreachable")
            
            await asyncio.sleep(0.1)
    
    def _is_goal_reached(self, goal) -> bool:
        """检查目标是否达成"""
        try:
            pos = self._bot.entity.position
            bx = math.floor(pos.x)
            by = math.floor(pos.y)
            bz = math.floor(pos.z)

            # GoalBlock: use block coords to avoid float mismatch (and handle negatives)
            if hasattr(goal, "x") and hasattr(goal, "y") and hasattr(goal, "z"):
                try:
                    gx = int(goal.x)
                    gy = int(goal.y)
                    gz = int(goal.z)
                    if bx == gx and by == gy and bz == gz:
                        return True
                except Exception:
                    pass

            # GoalNear: tolerate within range if present
            if hasattr(goal, "range") and hasattr(goal, "x") and hasattr(goal, "y") and hasattr(goal, "z"):
                try:
                    dx = pos.x - float(goal.x)
                    dy = pos.y - float(goal.y)
                    dz = pos.z - float(goal.z)
                    if (dx * dx + dy * dy + dz * dz) <= (float(goal.range) ** 2):
                        return True
                except Exception:
                    pass

            # Fallbacks for other goal types
            try:
                if goal.isEnd(self._Vec3(bx, by, bz)):
                    return True
            except Exception:
                pass
            try:
                if goal.isEnd(bx, by, bz):
                    return True
            except Exception:
                pass

            return False
        except Exception:
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

