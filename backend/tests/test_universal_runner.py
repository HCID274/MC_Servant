# Test UniversalRunner - Phase 3 MVP
# 统一执行器单元测试
#
# 测试验收场景：
# 1. 纯采集 (Gather) + L1 RETRY_SAME 微重试
# 2. 锚定逻辑 (Anchoring) - 主人位置 vs 自由位置
# 3. 复合任务流 (Flow) - Gather -> Craft -> Give

import pytest
import asyncio
from dataclasses import dataclass, field
from typing import Optional, List, Dict, Any
from unittest.mock import Mock, AsyncMock, MagicMock, patch

# Import from task module
import sys
from pathlib import Path

# Add parent to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from task.behavior_rules import BehaviorRules
from task.recovery_coordinator import RecoveryCoordinator
from task.interfaces import (
    StackTask,
    ActionStep,
    TaskResult,
    TaskType,
    RunContext,
    ITaskPlanner,
)
from task.recovery_interfaces import (
    RecoveryDecision,
    RecoveryLevel,
    RecoveryActionType,
)


# ============================================================================
# Mock Classes
# ============================================================================

class MockKnowledgeBase:
    """Mock JsonKnowledgeBase for testing"""
    
    def resolve_alias(self, concept: str) -> str:
        aliases = {"tree": "logs", "wood": "logs"}
        return aliases.get(concept, concept)
    
    def get_candidates(self, concept: str) -> List[str]:
        candidates = {
            "logs": ["oak_log", "birch_log", "spruce_log"],
            "planks": ["oak_planks", "birch_planks"],
        }
        return candidates.get(concept, [])
    
    def is_valid_id(self, item_id: str) -> bool:
        valid_ids = {"oak_log", "birch_log", "oak_planks", "birch_planks"}
        return item_id in valid_ids

@dataclass
class MockActionResult:
    """Mock ActionResult for testing"""
    success: bool
    action: str
    message: str = ""
    error_code: Optional[str] = None
    data: Optional[dict] = None
    status: str = "success"
    
    def __post_init__(self):
        self.status = "success" if self.success else "failed"


class MockBotActions:
    """Mock IBotActions for testing"""
    
    def __init__(self):
        self.call_log: List[Dict[str, Any]] = []
        self.mine_results: List[MockActionResult] = []
        self.craft_results: List[MockActionResult] = []
        self.give_results: List[MockActionResult] = []
        self.goto_results: List[MockActionResult] = []
        self.state: Dict[str, Any] = {
            "position": {"x": 0, "y": 64, "z": 0},
            "inventory": {},
            "health": 20,
        }
    
    def get_state(self) -> dict:
        return self.state.copy()
    
    async def mine(self, **kwargs) -> MockActionResult:
        self.call_log.append({"action": "mine", "params": kwargs})
        if self.mine_results:
            return self.mine_results.pop(0)
        return MockActionResult(success=True, action="mine")
    
    async def mine_tree(self, **kwargs) -> MockActionResult:
        self.call_log.append({"action": "mine_tree", "params": kwargs})
        if self.mine_results:
            return self.mine_results.pop(0)
        return MockActionResult(success=True, action="mine_tree")
    
    async def craft(self, **kwargs) -> MockActionResult:
        self.call_log.append({"action": "craft", "params": kwargs})
        if self.craft_results:
            return self.craft_results.pop(0)
        return MockActionResult(success=True, action="craft")
    
    async def give(self, **kwargs) -> MockActionResult:
        self.call_log.append({"action": "give", "params": kwargs})
        if self.give_results:
            return self.give_results.pop(0)
        return MockActionResult(success=True, action="give")
    
    async def goto(self, **kwargs) -> MockActionResult:
        self.call_log.append({"action": "goto", "params": kwargs})
        if self.goto_results:
            return self.goto_results.pop(0)
        return MockActionResult(success=True, action="goto")
    
    async def scan(self, **kwargs) -> MockActionResult:
        self.call_log.append({"action": "scan", "params": kwargs})
        return MockActionResult(success=True, action="scan", data={"found": []})


class MockPlanner:
    """Mock ITaskPlanner for testing"""
    
    def __init__(self):
        self.act_responses: List[tuple] = []  # [(step, done, message), ...]
        self.call_count = 0
    
    async def act(
        self,
        task_description: str,
        bot_state: dict,
        completed_steps: list,
    ) -> tuple:
        """Return mocked (ActionStep, done, message)"""
        self.call_count += 1
        if self.act_responses:
            response = self.act_responses.pop(0)
            return response
        # Default: return done
        return (ActionStep(action="noop", params={}), True, "No more actions")
    
    async def plan(self, task_description: str, bot_state: dict):
        return []


# ============================================================================
# Test Case 1: 纯采集 + L1 RETRY_SAME 微重试
# ============================================================================

def create_runner_with_mock_kb():
    """创建带 Mock KB 的 UniversalRunner"""
    with patch('task.universal_runner.KBOnlyResolver') as MockResolver:
        # 配置 mock resolver
        mock_resolver_instance = MagicMock()
        mock_resolver_instance.resolve_concept.side_effect = lambda x: {
            "tree": "oak_log", "log": "oak_log", "logs": "oak_log",
            "wood": "oak_log", "planks": "oak_planks"
        }.get(x, x)
        mock_resolver_instance.get_candidates.return_value = ["oak_log"]
        MockResolver.return_value = mock_resolver_instance
        
        # 导入并创建 runner
        from task.universal_runner import UniversalRunner
        rules = BehaviorRules()
        recovery = RecoveryCoordinator(rules)
        runner = UniversalRunner(rules=rules, recovery=recovery)
        return runner


class TestGatherWithRetry:
    """Test Case 1: 纯采集 (Gather) + L1 RETRY_SAME"""
    
    @pytest.fixture
    def runner(self):
        return create_runner_with_mock_kb()
    
    @pytest.fixture
    def context(self):
        return RunContext(
            owner_name="TestPlayer",
            owner_position={"x": 100, "y": 64, "z": 100},
            max_ticks=10,
            overall_timeout=60.0,
        )
    
    @pytest.mark.asyncio
    async def test_mine_with_first_failure_then_success(self, runner, context):
        """第一次挖矿失败后应该触发 L1 RETRY_SAME，第二次成功"""
        actions = MockBotActions()
        planner = MockPlanner()
        
        # LLM 返回 mine 动作
        planner.act_responses = [
            (ActionStep(action="mine", params={"target": "log"}), False, None),
            # 第二次调用不应该发生（RETRY_SAME 跳过 LLM）
            (ActionStep(action="mine", params={"target": "log"}), False, None),
            (ActionStep(action="noop", params={}), True, "Done"),
        ]
        
        # 第一次挖矿失败，第二次成功
        actions.mine_results = [
            MockActionResult(success=False, action="mine", error_code="PATH_NOT_FOUND"),
            MockActionResult(success=True, action="mine"),
        ]
        
        task = StackTask(name="test_gather", goal="mine some logs", task_type=TaskType.GATHER)
        
        result = await runner.run(task, actions, planner, context)
        
        # 验证：LLM 调用次数应该减少（因为 RETRY_SAME 跳过了 LLM）
        # 注意：具体次数取决于重试配置
        assert planner.call_count <= 4
        
        # 验证：mine 被调用了至少 2 次（首次失败 + 重试）
        mine_calls = [c for c in actions.call_log if c["action"] == "mine"]
        assert len(mine_calls) >= 2


# ============================================================================
# Test Case 2: 锚定逻辑 (Anchoring)
# ============================================================================

class TestAnchoringLogic:
    """Test Case 2: 锚定逻辑"""
    
    @pytest.fixture
    def runner(self):
        return create_runner_with_mock_kb()
    
    def test_should_anchor_to_owner_with_keywords(self, runner):
        """包含锚定关键词时应该锚定到主人位置"""
        assert runner._should_anchor_to_owner("come here and mine logs")
        assert runner._should_anchor_to_owner("在我这边砍树")
        assert runner._should_anchor_to_owner("get wood near me")
        assert runner._should_anchor_to_owner("来我这挖矿")
    
    def test_should_not_anchor_without_keywords(self, runner):
        """不包含锚定关键词时不应该锚定"""
        assert not runner._should_anchor_to_owner("mine some logs")
        assert not runner._should_anchor_to_owner("go to forest and chop trees")
        assert not runner._should_anchor_to_owner("砍点木头")
    
    def test_resolve_search_center_with_llm_position(self, runner):
        """LLM 指定位置时应该使用 LLM 位置"""
        step = ActionStep(
            action="mine",
            params={"near_position": {"x": 200, "y": 64, "z": 200}}
        )
        context = RunContext(
            owner_name="TestPlayer",
            owner_position={"x": 100, "y": 64, "z": 100},
        )
        
        center = runner._resolve_search_center(step, context, "mine logs near me")
        
        # 即使有锚定关键词，也应该使用 LLM 指定的位置
        assert center == {"x": 200, "y": 64, "z": 200}
    
    def test_resolve_search_center_with_anchor_intent(self, runner):
        """有锚定意图但无 LLM 位置时应该使用主人位置"""
        step = ActionStep(action="mine", params={"target": "log"})
        context = RunContext(
            owner_name="TestPlayer",
            owner_position={"x": 100, "y": 64, "z": 100},
        )
        
        center = runner._resolve_search_center(step, context, "mine logs near me")
        
        assert center == {"x": 100, "y": 64, "z": 100}
    
    def test_resolve_search_center_without_anchor_intent(self, runner):
        """无锚定意图时应该返回 None（让 bot 自己决定）"""
        step = ActionStep(action="mine", params={"target": "log"})
        context = RunContext(
            owner_name="TestPlayer",
            owner_position={"x": 100, "y": 64, "z": 100},
        )
        
        center = runner._resolve_search_center(step, context, "go to forest and mine logs")
        
        assert center is None


# ============================================================================
# Test Case 3: 复合任务流 (Flow)
# ============================================================================

class TestCompositeTaskFlow:
    """Test Case 3: 复合任务流 - Gather -> Craft -> Give"""
    
    @pytest.fixture
    def runner(self):
        return create_runner_with_mock_kb()
    
    @pytest.fixture
    def context(self):
        return RunContext(
            owner_name="TestPlayer",
            owner_position={"x": 100, "y": 64, "z": 100},
            max_ticks=10,
            overall_timeout=60.0,
        )
    
    def test_is_pure_single_step_detects_composite(self, runner):
        """复合任务应该被检测为非纯单步"""
        # 复合任务
        task1 = StackTask(name="t1", goal="做点木板给我", task_type=TaskType.CRAFT)
        assert not runner._is_pure_single_step_task(task1)
        
        task2 = StackTask(name="t2", goal="砍棵树给我木头", task_type=TaskType.GATHER)
        assert not runner._is_pure_single_step_task(task2)
        
        task3 = StackTask(name="t3", goal="craft planks and give to me", task_type=TaskType.CRAFT)
        assert not runner._is_pure_single_step_task(task3)
    
    def test_is_pure_single_step_detects_single(self, runner):
        """纯单步任务应该被正确检测"""
        # 纯单步任务
        task1 = StackTask(name="t1", goal="过来", task_type=TaskType.GOTO)
        assert runner._is_pure_single_step_task(task1)
        
        task2 = StackTask(name="t2", goal="合成木板", task_type=TaskType.CRAFT)
        assert runner._is_pure_single_step_task(task2)
        
        task3 = StackTask(name="t3", goal="mine some logs", task_type=TaskType.GATHER)
        assert runner._is_pure_single_step_task(task3)
    
    @pytest.mark.asyncio
    async def test_composite_task_does_not_terminate_early(self, runner, context):
        """复合任务在 craft 成功后不应该提前终止"""
        actions = MockBotActions()
        planner = MockPlanner()
        
        # LLM 返回序列：mine -> craft -> give -> done
        planner.act_responses = [
            (ActionStep(action="mine", params={"target": "log"}), False, None),
            (ActionStep(action="craft", params={"item": "planks"}), False, None),
            (ActionStep(action="give", params={"player": "TestPlayer", "item": "planks"}), False, None),
            (ActionStep(action="noop", params={}), True, "完成"),
        ]
        
        task = StackTask(name="composite_test", goal="做点木板给我", task_type=TaskType.CRAFT)
        
        result = await runner.run(task, actions, planner, context)
        
        # 验证：所有动作都被执行
        action_names = [c["action"] for c in actions.call_log]
        assert "mine" in action_names
        assert "craft" in action_names
        assert "give" in action_names
        
        # 验证：任务成功完成
        assert result.success


# ============================================================================
# Test Inventory Delta as Hint
# ============================================================================

class TestInventoryDeltaHint:
    """测试 Inventory Delta 作为辅助信息"""
    
    @pytest.fixture
    def runner(self):
        return create_runner_with_mock_kb()
    
    def test_parse_gather_spec(self, runner):
        """测试采集规格解析"""
        # 从 goal 解析
        task = StackTask(name="gather_test", goal="mine oak_log 5", task_type=TaskType.GATHER)
        item_id, count = runner._parse_gather_spec(task)
        assert item_id == "oak_log"
        assert count == 5
        
        # 从 context 解析
        task2 = StackTask(
            name="gather_test2",
            goal="gather wood",
            task_type=TaskType.GATHER,
            context={"gather": {"item_id": "birch_log", "target_count": 3}}
        )
        item_id2, count2 = runner._parse_gather_spec(task2)
        assert item_id2 == "birch_log"
        assert count2 == 3


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
