# Task Executor Integration Tests
# 任务执行器集成测试 (使用 Mock)

import pytest
import asyncio
from unittest.mock import AsyncMock, MagicMock, patch
from typing import Dict, Any, List

from task.interfaces import (
    StackTask, 
    ActionStep, 
    ActionPlan, 
    TaskResult, 
    TaskStatus,
    ITaskPlanner,
    IPrerequisiteResolver,
)
from task.executor import TaskExecutor
from task.stack_planner import StackOverflowError
from bot.interfaces import ActionResult as BotActionResult, ActionStatus


# ============================================================================
# Mock Fixtures
# ============================================================================

class MockBotActions:
    """Mock Bot Actions"""
    
    def __init__(self, inventory: Dict[str, int] = None):
        self._inventory = inventory or {"oak_log": 10}
        self._position = {"x": 100, "y": 64, "z": -200}
        # 可编程返回序列（用于失败/重试用例）
        self.mine_results: List[BotActionResult] = []
        self.craft_results: List[BotActionResult] = []
        self.goto_results: List[BotActionResult] = []
    
    def get_state(self) -> Dict[str, Any]:
        return {
            "position": self._position,
            "health": 20.0,
            "food": 20,
            "inventory": self._inventory.copy(),
            "equipped": None
        }
    
    async def mine(self, block_type: str, count: int = 1, timeout: float = 120.0) -> BotActionResult:
        """模拟采集"""
        if self.mine_results:
            return self.mine_results.pop(0)
        return BotActionResult(
            success=True,
            action="mine",
            message=f"采集了 {count} 个 {block_type}",
            status=ActionStatus.SUCCESS,
            data={"collected": {block_type: count}}
        )
    
    async def craft(self, item_name: str, count: int = 1, timeout: float = 30.0) -> BotActionResult:
        """模拟合成"""
        if self.craft_results:
            return self.craft_results.pop(0)
        return BotActionResult(
            success=True,
            action="craft",
            message=f"合成了 {count} 个 {item_name}",
            status=ActionStatus.SUCCESS,
            data={"crafted": {item_name: count}}
        )
    
    async def goto(self, target: str, timeout: float = 60.0) -> BotActionResult:
        """模拟导航"""
        if self.goto_results:
            return self.goto_results.pop(0)
        return BotActionResult(
            success=True,
            action="goto",
            message=f"已到达 {target}",
            status=ActionStatus.SUCCESS,
            data={"arrived_at": [100, 64, -200]}
        )


class MockTaskPlanner(ITaskPlanner):
    """
    Mock Task Planner - 可编程的任务规划器
    
    设计原则：Mock 应该是一个"可编程的演员"，完全服从测试用例的设定。
    
    Args:
        steps: act() 依次返回的步骤列表（执行完后返回 done=True）
    """
    
    def __init__(
        self, 
        steps: List[ActionStep] = None,
        done_message: str = "任务完成"
    ):
        self._steps = list(steps) if steps is not None else [
            ActionStep(action="mine", params={"block_type": "oak_log", "count": 5}, description="采集木头")
        ]
        self._done_message = done_message
        self.act_call_count = 0
    
    async def plan(self, task_description: str, bot_state: Dict[str, Any]) -> ActionPlan:
        # UniversalRunner 不使用 plan()；保留实现仅为满足接口
        return ActionPlan(
            task_description=task_description,
            steps=[],
            estimated_time=60
        )
    
    async def replan(
        self,
        task_description: str,
        bot_state: Dict[str, Any],
        failed_result: BotActionResult,
        completed_steps: List[BotActionResult]
    ) -> ActionPlan:
        # UniversalRunner 不使用 replan()；保留实现仅为满足接口
        return ActionPlan(
            task_description=task_description,
            steps=[],
            estimated_time=30
        )

    async def act(
        self,
        task_description: str,
        bot_state: Dict[str, Any],
        completed_steps: List[BotActionResult],
    ):
        self.act_call_count += 1
        if self._steps:
            step = self._steps.pop(0)
            return step, False, None
        return ActionStep(action="noop", params={}, description="done"), True, self._done_message


class MockPrerequisiteResolver(IPrerequisiteResolver):
    """Mock Prerequisite Resolver"""
    
    def __init__(self, should_return_task: bool = False):
        self._should_return = should_return_task
        self._resolve_count = 0
    
    def resolve(
        self,
        error_code: str,
        context: Dict[str, Any],
        inventory: Dict[str, int]
    ) -> StackTask:
        self._resolve_count += 1
        if self._should_return:
            return StackTask(
                name="前置任务",
                goal="prerequisite task",
                context={"source": "test"},
                status=TaskStatus.PENDING
            )
        return None


# ============================================================================
# Tests
# ============================================================================

class TestTaskExecutorBasic:
    """基础功能测试"""
    
    @pytest.mark.asyncio
    async def test_simple_task_success(self):
        """测试简单任务成功执行"""
        actions = MockBotActions()
        planner = MockTaskPlanner([
            ActionStep(action="mine", params={"block_type": "oak_log", "count": 5}, description="采集木头")
        ])
        
        executor = TaskExecutor(planner=planner, actions=actions)
        result = await executor.execute("采集5个木头")
        
        assert result.success
        assert len(result.completed_steps) == 1
        assert planner.act_call_count >= 1
    
    @pytest.mark.asyncio
    async def test_multi_step_task(self):
        """测试多步骤任务"""
        actions = MockBotActions()
        planner = MockTaskPlanner([
            ActionStep(action="goto", params={"target": "100,64,-200"}, description="导航"),
            ActionStep(action="mine", params={"block_type": "oak_log", "count": 3}, description="采集"),
            ActionStep(action="craft", params={"item_name": "oak_planks", "count": 4}, description="合成"),
        ])
        
        executor = TaskExecutor(planner=planner, actions=actions)
        result = await executor.execute("合成木板")
        
        assert result.success
        assert len(result.completed_steps) == 3
    
    @pytest.mark.asyncio
    async def test_cancel_execution(self):
        """测试取消执行"""
        actions = MockBotActions()
        # 创建一个会延迟的 action
        async def slow_mine(*args, **kwargs):
            await asyncio.sleep(1)
            return BotActionResult(
                success=True, action="mine", message="done", status=ActionStatus.SUCCESS
            )
        actions.mine = slow_mine
        
        planner = MockTaskPlanner([
            ActionStep(action="mine", params={"block_type": "oak_log", "count": 5}, description="采集")
        ])
        
        executor = TaskExecutor(planner=planner, actions=actions)
        
        # 启动执行任务
        task = asyncio.create_task(executor.execute("慢任务"))
        
        # 等待一点时间后取消
        await asyncio.sleep(0.1)
        executor.cancel()
        
        result = await task
        assert not result.success
        assert "取消" in result.message


class TestTaskExecutorFailure:
    """失败处理测试"""
    
    @pytest.mark.asyncio
    async def test_action_failure_with_replan(self):
        """测试动作失败后的行为（UniversalRunner 无恢复规划器时会终止）"""
        actions = MockBotActions()
        actions.mine_results = [
            BotActionResult(success=False, action="mine", message="失败", status=ActionStatus.FAILED, error_code="TARGET_NOT_FOUND")
        ]
        planner = MockTaskPlanner([ActionStep(action="mine", params={"block_type": "oak_log", "count": 1}, description="采集")])
        executor = TaskExecutor(planner=planner, actions=actions, max_retries=1)
        result = await executor.execute("采集任务")
        assert not result.success
        assert "任务失败" in result.message
    
    @pytest.mark.asyncio
    async def test_max_retries_exceeded(self):
        """测试失败时会返回失败结果（无恢复规划器）"""
        actions = MockBotActions()
        actions.mine_results = [
            BotActionResult(success=False, action="mine", message="总是失败", status=ActionStatus.FAILED, error_code="UNKNOWN")
        ]
        planner = MockTaskPlanner([ActionStep(action="mine", params={"block_type": "stone", "count": 1}, description="重试采集")])
        executor = TaskExecutor(planner=planner, actions=actions, max_retries=1)
        result = await executor.execute("会失败的任务")
        
        assert not result.success
        assert "任务失败" in result.message
    
    @pytest.mark.asyncio
    async def test_unknown_action(self):
        """测试未知动作 - 即使 replan 也无法修复"""
        actions = MockBotActions()
        planner = MockTaskPlanner([ActionStep(action="fly_to_moon", params={}, description="飞到月球")])
        
        executor = TaskExecutor(planner=planner, actions=actions, max_retries=3)
        result = await executor.execute("不可能的任务")
        
        assert not result.success
        assert result.failed_step is not None
        assert result.failed_step.error_code == "UNKNOWN_ACTION"


class TestTaskExecutorPrerequisite:
    """前置任务解析测试"""
    
    @pytest.mark.asyncio
    async def test_prerequisite_push(self):
        """测试前置任务压栈 - 材料不足时触发符号层解析"""
        actions = MockBotActions(inventory={})
        
        craft_call_count = 0
        async def craft_with_prereq(*args, **kwargs):
            nonlocal craft_call_count
            craft_call_count += 1
            if craft_call_count == 1:
                # 第一次合成失败 (材料不足)
                return BotActionResult(
                    success=False, action="craft", message="材料不足",
                    status=ActionStatus.FAILED, error_code="INSUFFICIENT_MATERIALS",
                    data={"missing": {"oak_planks": 2}}
                )
            # 第二次成功
            return BotActionResult(
                success=True, action="craft", message="成功", status=ActionStatus.SUCCESS
            )
        
        # 前置任务 mine 成功
        async def mine_success(*args, **kwargs):
            return BotActionResult(
                success=True, action="mine", message="采集成功", status=ActionStatus.SUCCESS
            )
        
        actions.craft = craft_with_prereq
        actions.mine = mine_success
        
        planner = MockTaskPlanner([ActionStep(action="craft", params={"item_name": "stick", "count": 4}, description="合成木棍")])
        
        # Resolver 返回前置任务
        prereq = MockPrerequisiteResolver(should_return_task=True)
        
        executor = TaskExecutor(planner=planner, actions=actions, prereq_resolver=prereq, max_retries=3)
        
        # 这个测试验证 prereq resolver 被调用
        result = await executor.execute("合成木棍")
        
        # prereq resolver 应该被调用
        assert prereq._resolve_count >= 1


class TestTaskExecutorState:
    """状态检查测试"""
    
    @pytest.mark.asyncio
    async def test_is_running(self):
        """测试 is_running 状态"""
        actions = MockBotActions()
        
        async def slow_mine(*args, **kwargs):
            await asyncio.sleep(0.5)
            return BotActionResult(
                success=True, action="mine", message="done", status=ActionStatus.SUCCESS
            )
        actions.mine = slow_mine
        
        planner = MockTaskPlanner()
        executor = TaskExecutor(planner=planner, actions=actions)
        
        assert not executor.is_running
        
        # 启动任务
        task = asyncio.create_task(executor.execute("测试任务"))
        await asyncio.sleep(0.1)
        
        assert executor.is_running
        
        await task
        assert not executor.is_running
    
    @pytest.mark.asyncio
    async def test_stack_depth(self):
        """测试栈深度跟踪"""
        actions = MockBotActions()
        planner = MockTaskPlanner()
        executor = TaskExecutor(planner=planner, actions=actions)
        
        assert executor.stack_depth == 0
        
        # 执行任务后栈应该清空
        await executor.execute("测试任务")
        assert executor.stack_depth == 0


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
