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
        return BotActionResult(
            success=True,
            action="mine",
            message=f"采集了 {count} 个 {block_type}",
            status=ActionStatus.SUCCESS,
            data={"collected": {block_type: count}}
        )
    
    async def craft(self, item_name: str, count: int = 1, timeout: float = 30.0) -> BotActionResult:
        """模拟合成"""
        return BotActionResult(
            success=True,
            action="craft",
            message=f"合成了 {count} 个 {item_name}",
            status=ActionStatus.SUCCESS,
            data={"crafted": {item_name: count}}
        )
    
    async def goto(self, target: str, timeout: float = 60.0) -> BotActionResult:
        """模拟导航"""
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
        plan_steps: plan() 返回的步骤列表
        replan_steps: replan() 返回的步骤列表
                      - None: 返回空计划（模拟 LLM 放弃/无法修复）
                      - []: 显式返回空计划
                      - [...]: 返回指定步骤（模拟 LLM 修复成功）
    """
    
    def __init__(
        self, 
        plan_steps: List[ActionStep] = None,
        replan_steps: List[ActionStep] = None
    ):
        self._plan_steps = plan_steps or [
            ActionStep(action="mine", params={"block_type": "oak_log", "count": 5}, description="采集木头")
        ]
        # replan_steps 默认为可执行的备选方案（向后兼容）
        # 设置为 None 表示 replan 返回空计划（LLM 放弃）
        self._replan_steps = replan_steps
        self._plan_call_count = 0
        self._replan_call_count = 0
    
    async def plan(self, task_description: str, bot_state: Dict[str, Any]) -> ActionPlan:
        self._plan_call_count += 1
        return ActionPlan(
            task_description=task_description,
            steps=self._plan_steps,
            estimated_time=60
        )
    
    async def replan(
        self,
        task_description: str,
        bot_state: Dict[str, Any],
        failed_result: BotActionResult,
        completed_steps: List[BotActionResult]
    ) -> ActionPlan:
        self._replan_call_count += 1
        
        # 如果 replan_steps 为 None，返回空计划（模拟 LLM 放弃）
        if self._replan_steps is None:
            return ActionPlan(
                task_description=task_description,
                steps=[],
                estimated_time=0
            )
        
        # 否则返回指定的步骤
        return ActionPlan(
            task_description=task_description,
            steps=self._replan_steps,
            estimated_time=30
        )


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
        assert planner._plan_call_count == 1
    
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
        """测试动作失败后重规划 - LLM 成功修复"""
        actions = MockBotActions()
        call_count = 0
        
        async def failing_then_success(*args, **kwargs):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return BotActionResult(
                    success=False, action="mine", message="失败",
                    status=ActionStatus.FAILED, error_code="TARGET_NOT_FOUND"
                )
            return BotActionResult(
                success=True, action="mine", message="成功", status=ActionStatus.SUCCESS
            )
        
        actions.mine = failing_then_success
        # replan 返回可执行的备选方案（LLM 成功修复）
        planner = MockTaskPlanner(
            replan_steps=[ActionStep(action="mine", params={"block_type": "cobblestone", "count": 1}, description="备选方案")]
        )
        
        executor = TaskExecutor(planner=planner, actions=actions, max_retries=3)
        result = await executor.execute("采集任务")
        
        # 应该触发 replan 且最终成功
        assert planner._replan_call_count >= 1
        assert result.success
    
    @pytest.mark.asyncio
    async def test_max_retries_exceeded(self):
        """测试超过最大重试次数 - replan 持续返回失败的动作"""
        actions = MockBotActions()
        
        async def always_fail(*args, **kwargs):
            return BotActionResult(
                success=False, action="mine", message="总是失败",
                status=ActionStatus.FAILED, error_code="UNKNOWN"
            )
        
        actions.mine = always_fail
        # replan 返回同样会失败的动作（模拟 LLM 尝试修复但仍然失败）
        planner = MockTaskPlanner(
            replan_steps=[ActionStep(action="mine", params={"block_type": "stone", "count": 1}, description="重试采集")]
        )
        
        executor = TaskExecutor(planner=planner, actions=actions, max_retries=2)
        result = await executor.execute("会失败的任务")
        
        assert not result.success
        assert "重试" in result.message
    
    @pytest.mark.asyncio
    async def test_unknown_action(self):
        """测试未知动作 - 即使 replan 也无法修复"""
        actions = MockBotActions()
        planner = MockTaskPlanner(
            plan_steps=[ActionStep(action="fly_to_moon", params={}, description="飞到月球")],
            replan_steps=None  # LLM 放弃，返回空计划
        )
        
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
        
        # Planner 返回 craft 计划，replan 返回空（LLM 放弃，交给符号层处理）
        planner = MockTaskPlanner(
            plan_steps=[ActionStep(action="craft", params={"item_name": "stick", "count": 4}, description="合成木棍")],
            replan_steps=None  # LLM 放弃，让符号层接管
        )
        
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
