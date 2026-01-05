# Stack Planner
# 栈式任务管理器 - 管理任务的压栈/出栈

import logging
from typing import List, Optional

from .interfaces import StackTask, TaskStatus


logger = logging.getLogger(__name__)


class StackOverflowError(Exception):
    """
    栈深度超限异常
    
    当任务链过深时抛出，表示任务分解可能存在问题
    (如循环依赖: 做木棍需木板 → 做木板需木头 → 砍木头需斧头 → 做斧头需木棍)
    """
    pass


class StackPlanner:
    """
    栈式任务规划器
    
    职责：
    - 管理任务栈的压入/弹出
    - 维护任务状态 (IN_PROGRESS/BLOCKED)
    - 强制栈深度限制
    
    设计决策：
    - soft_limit=6: 超过时发出警告，但继续执行
    - hard_limit=9: 超过时抛出 StackOverflowError，停止执行
    
    注意：
    - 本类是非线程安全的 (Not Thread-Safe)。
    - 必须由调用者 (TaskExecutor) 确保并发访问的串行化 (如使用 asyncio.Lock)。
    - 虽然 asyncio 单线程运行，但在 await 切换点如果共享实例可能导致状态不一致，因此依赖外部锁。

    工作流程示例：
    ```
    任务: 合成床
    
    1. [合成床] ← 当前任务 (IN_PROGRESS)
       └─ 发现没羊毛
    2. 压栈 → [杀羊] ← 新任务 (IN_PROGRESS)
       └─ [合成床] 变为 BLOCKED
    3. 杀羊成功 → pop()
       └─ [合成床] 恢复为 IN_PROGRESS
    ```
    """
    
    def __init__(self, soft_limit: int = 6, hard_limit: int = 9):
        """
        初始化栈式规划器
        
        Args:
            soft_limit: 软限制，超过时发出警告
            hard_limit: 硬限制，超过时抛出异常
        """
        self._stack: List[StackTask] = []
        self._soft_limit = soft_limit
        self._hard_limit = hard_limit
    
    def push(self, task: StackTask) -> None:
        """
        压入新任务
        
        - 将当前任务 (栈顶) 标记为 BLOCKED
        - 将新任务标记为 IN_PROGRESS 并压入栈顶
        
        Args:
            task: 要压入的任务
            
        Raises:
            StackOverflowError: 超过硬限制
        """
        # 检查硬限制
        if len(self._stack) >= self._hard_limit:
            raise StackOverflowError(
                f"任务栈深度超过硬限制 ({self._hard_limit})，"
                f"当前任务链: {' → '.join(t.name for t in self._stack)}"
            )
        
        # 检查软限制
        if len(self._stack) >= self._soft_limit:
            logger.warning(
                f"任务栈深度达到软限制 ({self._soft_limit})，"
                f"任务链: {' → '.join(t.name for t in self._stack)} → {task.name}"
            )
        
        # 将当前任务标记为阻塞
        if self._stack:
            current = self._stack[-1]
            current.status = TaskStatus.BLOCKED
            current.blocking_reason = f"等待前置任务: {task.name}"
            logger.debug(f"Task '{current.name}' blocked by '{task.name}'")
        
        # 压入新任务
        task.status = TaskStatus.IN_PROGRESS
        self._stack.append(task)
        logger.info(f"Pushed task: {task.name} (depth={len(self._stack)})")
    
    def pop(self) -> Optional[StackTask]:
        """
        弹出已完成的任务
        
        - 弹出栈顶任务
        - 将新的栈顶任务 (如果有) 恢复为 IN_PROGRESS
        
        Returns:
            弹出的任务，栈空时返回 None
        """
        if not self._stack:
            return None
        
        completed = self._stack.pop()
        completed.status = TaskStatus.COMPLETED
        logger.info(f"Popped task: {completed.name} (remaining depth={len(self._stack)})")
        
        # 恢复上一个任务
        if self._stack:
            resumed = self._stack[-1]
            resumed.status = TaskStatus.IN_PROGRESS
            resumed.blocking_reason = None
            logger.debug(f"Resumed task: {resumed.name}")
        
        return completed
    
    def current(self) -> Optional[StackTask]:
        """
        获取当前任务 (栈顶)
        
        Returns:
            当前任务，栈空时返回 None
        """
        return self._stack[-1] if self._stack else None
    
    def clear(self) -> None:
        """
        清空任务栈
        
        用于任务中断时清理所有待执行任务
        """
        count = len(self._stack)
        self._stack.clear()
        logger.info(f"Cleared task stack (removed {count} tasks)")
    
    def is_empty(self) -> bool:
        """
        检查栈是否为空
        
        Returns:
            True 如果栈为空
        """
        return len(self._stack) == 0
    
    @property
    def depth(self) -> int:
        """
        当前栈深度
        
        Returns:
            栈中任务数量
        """
        return len(self._stack)
    
    @property
    def soft_limit(self) -> int:
        """软限制值"""
        return self._soft_limit
    
    @property
    def hard_limit(self) -> int:
        """硬限制值"""
        return self._hard_limit
    
    def get_stack_trace(self) -> List[str]:
        """
        获取栈追踪信息 (用于调试/日志)
        
        Returns:
            任务名称列表，从底到顶
        """
        return [f"{i+1}. [{t.status.value}] {t.name}" 
                for i, t in enumerate(self._stack)]
    
    def __repr__(self) -> str:
        if not self._stack:
            return "StackPlanner(empty)"
        return f"StackPlanner(depth={len(self._stack)}, current='{self._stack[-1].name}')"
