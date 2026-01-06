# Test Meta Actions
# 元动作模块单元测试

import pytest
import asyncio
from unittest.mock import AsyncMock, MagicMock, patch
from typing import Dict, Any

# 导入被测模块 (相对于 backend 目录)
from bot.meta_actions.interface import (
    IMetaAction,
    MetaActionResult,
    ParameterSpec,
    ToolMatcherMixin,
)
from bot.meta_actions.registry import MetaActionRegistry
from bot.meta_actions.navigate import NavigateAction
from bot.meta_actions.gather_block import GatherBlockAction
from bot.meta_actions.scan_environment import ScanEnvironmentAction
from bot.meta_actions.craft_item import CraftItemAction


# ============================================================================
# Fixtures
# ============================================================================

@pytest.fixture
def bot_state_with_tools():
    """有工具的 Bot 状态"""
    return {
        "position": {"x": 100, "y": 64, "z": 200},
        "dimension": "overworld",
        "inventory": {
            "iron_pickaxe": 1,
            "stone_pickaxe": 1,
            "diamond_axe": 1,
            "oak_planks": 16,
            "crafting_table": 1,
        },
        "health": 20,
    }


@pytest.fixture
def bot_state_no_tools():
    """无工具的 Bot 状态"""
    return {
        "position": {"x": 100, "y": 64, "z": 200},
        "dimension": "overworld",
        "inventory": {
            "dirt": 64,
            "oak_log": 10,
        },
        "health": 20,
    }


@pytest.fixture
def mock_actions():
    """Mock IBotActions"""
    actions = AsyncMock()
    actions.goto = AsyncMock(return_value=MagicMock(success=True))
    actions.mine = AsyncMock(return_value=MagicMock(success=True))
    actions.scan = AsyncMock(return_value=MagicMock(success=True))
    actions.craft = AsyncMock(return_value=MagicMock(success=True))
    actions.get_state = AsyncMock(return_value={"inventory": {"stone_pickaxe": 1}})
    return actions


# ============================================================================
# ToolMatcherMixin Tests
# ============================================================================

class TestToolMatcherMixin:
    """工具匹配 Mixin 测试"""
    
    def setup_method(self):
        """创建测试用 Mixin 实例"""
        class TestMatcher(ToolMatcherMixin):
            pass
        self.matcher = TestMatcher()
    
    def test_has_required_tool_iron_ore_with_stone_pickaxe(self):
        """测试石镐挖铁矿"""
        inventory = {"stone_pickaxe": 1}
        
        result = self.matcher.has_required_tool("iron_ore", inventory)
        
        assert result is True
    
    def test_has_required_tool_iron_ore_without_pickaxe(self):
        """测试无镐挖铁矿"""
        inventory = {"wooden_axe": 1}
        
        result = self.matcher.has_required_tool("iron_ore", inventory)
        
        assert result is False
    
    def test_has_required_tool_iron_ore_with_wooden_pickaxe(self):
        """测试木镐挖铁矿 (等级不够)"""
        inventory = {"wooden_pickaxe": 1}
        
        result = self.matcher.has_required_tool("iron_ore", inventory)
        
        assert result is False
    
    def test_has_required_tool_diamond_ore_with_iron_pickaxe(self):
        """测试铁镐挖钻石矿"""
        inventory = {"iron_pickaxe": 1}
        
        result = self.matcher.has_required_tool("diamond_ore", inventory)
        
        assert result is True
    
    def test_has_required_tool_obsidian_with_iron_pickaxe(self):
        """测试铁镐挖黑曜石 (等级不够)"""
        inventory = {"iron_pickaxe": 1}
        
        result = self.matcher.has_required_tool("obsidian", inventory)
        
        assert result is False
    
    def test_has_required_tool_obsidian_with_diamond_pickaxe(self):
        """测试钻石镐挖黑曜石"""
        inventory = {"diamond_pickaxe": 1}
        
        result = self.matcher.has_required_tool("obsidian", inventory)
        
        assert result is True
    
    def test_has_required_tool_dirt_without_tool(self):
        """测试徒手挖泥土"""
        inventory = {}
        
        result = self.matcher.has_required_tool("dirt", inventory)
        
        assert result is True  # 可以徒手挖
    
    def test_has_required_tool_oak_log_with_any_axe(self):
        """测试任意斧头砍木头"""
        inventory = {"wooden_axe": 1}
        
        result = self.matcher.has_required_tool("oak_log", inventory)
        
        assert result is True
    
    def test_get_best_tool_returns_highest_tier(self):
        """测试返回最高等级工具"""
        inventory = {
            "wooden_pickaxe": 1,
            "stone_pickaxe": 1,
            "diamond_pickaxe": 1,
        }
        
        result = self.matcher.get_best_tool("iron_ore", inventory)
        
        assert result == "diamond_pickaxe"
    
    def test_get_missing_tool_requirement(self):
        """测试获取缺失工具描述"""
        inventory = {"wooden_pickaxe": 1}
        
        result = self.matcher.get_missing_tool_requirement("iron_ore", inventory)
        
        assert result is not None
        assert "stone_pickaxe" in result


# ============================================================================
# MetaActionRegistry Tests
# ============================================================================

class TestMetaActionRegistry:
    """元动作注册表测试"""
    
    def test_actions_are_registered(self):
        """测试动作已注册"""
        # 由于 import 时会触发注册，检查已注册的动作
        assert MetaActionRegistry.count() >= 4
        
        assert MetaActionRegistry.get("navigate") is not None
        assert MetaActionRegistry.get("gather_block") is not None
        assert MetaActionRegistry.get("scan_environment") is not None
        assert MetaActionRegistry.get("craft_item") is not None
    
    def test_get_nonexistent_action(self):
        """测试获取不存在的动作"""
        result = MetaActionRegistry.get("nonexistent_action")
        
        assert result is None
    
    def test_get_available_filters_by_state(self, bot_state_with_tools):
        """测试动态过滤"""
        available = MetaActionRegistry.get_available(bot_state_with_tools)
        
        # 应该返回所有可用动作
        action_names = [a.name for a in available]
        assert "navigate" in action_names
        assert "scan_environment" in action_names
    
    def test_format_for_prompt_markdown(self, bot_state_with_tools):
        """测试 Markdown 格式化"""
        available = MetaActionRegistry.get_available(bot_state_with_tools)
        
        prompt_text = MetaActionRegistry.format_for_prompt(available, style="markdown")
        
        assert "## Available Actions" in prompt_text
        assert "**navigate**" in prompt_text
    
    def test_format_for_prompt_xml(self, bot_state_with_tools):
        """测试 XML 格式化"""
        available = MetaActionRegistry.get_available(bot_state_with_tools)
        
        prompt_text = MetaActionRegistry.format_for_prompt(available, style="xml")
        
        assert "<available_actions>" in prompt_text
        assert "</available_actions>" in prompt_text


# ============================================================================
# NavigateAction Tests
# ============================================================================

class TestNavigateAction:
    """导航动作测试"""
    
    def test_name_and_description(self):
        """测试名称和描述"""
        action = NavigateAction()
        
        assert action.name == "navigate"
        assert "Navigate" in action.description
    
    def test_can_execute_with_healthy_bot(self, bot_state_with_tools):
        """测试健康 Bot 可以导航"""
        action = NavigateAction()
        
        result = action.can_execute(bot_state_with_tools)
        
        assert result is True
    
    def test_can_execute_with_low_health(self):
        """测试低血量不能导航"""
        action = NavigateAction()
        bot_state = {"health": 1}
        
        result = action.can_execute(bot_state)
        
        assert result is False
    
    @pytest.mark.asyncio
    async def test_execute_calls_goto(self, mock_actions):
        """测试执行调用 goto"""
        action = NavigateAction()
        
        await action.execute(mock_actions, target="100,64,200")
        
        mock_actions.goto.assert_called_once_with(target="100,64,200")


# ============================================================================
# GatherBlockAction Tests
# ============================================================================

class TestGatherBlockAction:
    """采集方块动作测试"""
    
    def test_name_and_description(self):
        """测试名称和描述"""
        action = GatherBlockAction()
        
        assert action.name == "gather_block"
        assert "mine" in action.description.lower()
    
    def test_can_gather_iron_ore_with_stone_pickaxe(self, bot_state_with_tools):
        """测试石镐可以挖铁矿"""
        action = GatherBlockAction()
        bot_state_with_tools["inventory"] = {"stone_pickaxe": 1}
        
        result = action.can_gather_block("iron_ore", bot_state_with_tools)
        
        assert result is True
    
    def test_can_gather_iron_ore_without_pickaxe(self, bot_state_no_tools):
        """测试无镐不能挖铁矿"""
        action = GatherBlockAction()
        
        result = action.can_gather_block("iron_ore", bot_state_no_tools)
        
        assert result is False
    
    @pytest.mark.asyncio
    async def test_execute_calls_mine(self, mock_actions):
        """测试执行调用 mine"""
        action = GatherBlockAction()
        mock_actions.get_state = AsyncMock(return_value={
            "inventory": {"stone_pickaxe": 1}
        })
        
        await action.execute(mock_actions, block_type="iron_ore", count=3)
        
        mock_actions.mine.assert_called_once_with(block_type="iron_ore", count=3)


# ============================================================================
# ScanEnvironmentAction Tests
# ============================================================================

class TestScanEnvironmentAction:
    """扫描环境动作测试"""
    
    def test_can_execute_always_true(self, bot_state_with_tools):
        """测试扫描总是可用"""
        action = ScanEnvironmentAction()
        
        result = action.can_execute(bot_state_with_tools)
        
        assert result is True
    
    @pytest.mark.asyncio
    async def test_execute_calls_scan(self, mock_actions):
        """测试执行调用 scan"""
        action = ScanEnvironmentAction()
        
        await action.execute(
            mock_actions, 
            target_type="iron_ore", 
            radius=32
        )
        
        mock_actions.scan.assert_called_once()


# ============================================================================
# CraftItemAction Tests
# ============================================================================

class TestCraftItemAction:
    """合成物品动作测试"""
    
    def test_needs_crafting_table_for_pickaxe(self):
        """测试镐需要工作台"""
        action = CraftItemAction()
        
        result = action.needs_crafting_table("iron_pickaxe")
        
        assert result is True
    
    def test_no_crafting_table_for_planks(self):
        """测试木板不需要工作台"""
        action = CraftItemAction()
        
        result = action.needs_crafting_table("oak_planks")
        
        assert result is False
    
    def test_has_crafting_table_access_in_inventory(self, bot_state_with_tools):
        """测试背包有工作台"""
        action = CraftItemAction()
        
        result = action.has_crafting_table_access(
            "iron_pickaxe", 
            bot_state_with_tools
        )
        
        assert result is True
    
    @pytest.mark.asyncio
    async def test_execute_calls_craft(self, mock_actions):
        """测试执行调用 craft"""
        action = CraftItemAction()
        mock_actions.get_state = AsyncMock(return_value={
            "inventory": {"crafting_table": 1}
        })
        
        await action.execute(mock_actions, item_name="oak_planks", count=4)
        
        mock_actions.craft.assert_called_once_with(item_name="oak_planks", count=4)


# ============================================================================
# SmeltItemAction Tests
# ============================================================================

class TestSmeltItemAction:
    """冶炼物品动作测试"""
    
    def test_name_and_description(self):
        """测试名称和描述"""
        from bot.meta_actions.smelt_item import SmeltItemAction
        action = SmeltItemAction()
        
        assert action.name == "smelt_item"
        assert "smelt" in action.description.lower()
    
    def test_can_execute_with_raw_iron(self):
        """测试有生铁时可冶炼"""
        from bot.meta_actions.smelt_item import SmeltItemAction
        action = SmeltItemAction()
        bot_state = {"inventory": {"raw_iron": 5}}
        
        result = action.can_execute(bot_state)
        
        assert result is True
    
    def test_can_execute_with_sand(self):
        """测试有沙子时可冶炼"""
        from bot.meta_actions.smelt_item import SmeltItemAction
        action = SmeltItemAction()
        bot_state = {"inventory": {"sand": 16}}
        
        result = action.can_execute(bot_state)
        
        assert result is True
    
    def test_can_execute_without_smeltable(self):
        """测试无可冶炼物品时不可用"""
        from bot.meta_actions.smelt_item import SmeltItemAction
        action = SmeltItemAction()
        bot_state = {"inventory": {"iron_ingot": 5, "diamond": 2}}
        
        result = action.can_execute(bot_state)
        
        assert result is False
    
    @pytest.mark.asyncio
    async def test_execute_calls_smelt(self, mock_actions):
        """测试执行调用 smelt"""
        from bot.meta_actions.smelt_item import SmeltItemAction
        action = SmeltItemAction()
        mock_actions.smelt = AsyncMock(return_value=MagicMock(success=True))
        
        await action.execute(mock_actions, item="raw_iron", count=3)
        
        mock_actions.smelt.assert_called_once_with("raw_iron", count=3)


# ============================================================================
# RetreatSafeAction Tests
# ============================================================================

class TestRetreatSafeAction:
    """紧急避险动作测试"""
    
    def test_name_and_description(self):
        """测试名称和描述"""
        from bot.meta_actions.retreat_safe import RetreatSafeAction
        action = RetreatSafeAction()
        
        assert action.name == "retreat_safe"
        assert "retreat" in action.description.lower()
    
    def test_can_execute_low_health(self):
        """测试低血量时可用"""
        from bot.meta_actions.retreat_safe import RetreatSafeAction
        action = RetreatSafeAction()
        bot_state = {"health": 4}  # 2颗心
        
        result = action.can_execute(bot_state)
        
        assert result is True
    
    def test_can_execute_hostile_nearby(self):
        """测试附近有敌对生物时可用"""
        from bot.meta_actions.retreat_safe import RetreatSafeAction
        action = RetreatSafeAction()
        bot_state = {
            "health": 20,
            "nearby_entities": [{"type": "zombie", "distance": 5}]
        }
        
        result = action.can_execute(bot_state)
        
        assert result is True
    
    def test_can_execute_safe_state(self):
        """测试安全状态时不可用"""
        from bot.meta_actions.retreat_safe import RetreatSafeAction
        action = RetreatSafeAction()
        bot_state = {
            "health": 20,
            "nearby_entities": []
        }
        
        result = action.can_execute(bot_state)
        
        assert result is False
    
    @pytest.mark.asyncio
    async def test_execute_calls_goto(self, mock_actions):
        """测试执行调用 goto 避险"""
        from bot.meta_actions.retreat_safe import RetreatSafeAction
        action = RetreatSafeAction()
        mock_actions.get_state = MagicMock(return_value={
            "position": {"x": 100, "y": 64, "z": 200}
        })
        mock_actions.goto = AsyncMock(return_value=MagicMock(success=True))
        
        result = await action.execute(mock_actions)
        
        mock_actions.goto.assert_called_once()
        assert result.success is True


# ============================================================================
# MetaActionDispatcher Tests
# ============================================================================

class TestMetaActionDispatcher:
    """元动作分发器测试"""
    
    def test_dispatch_to_meta_action(self):
        """测试路由到 MetaAction"""
        from bot.meta_actions.dispatcher import MetaActionDispatcher
        
        dispatcher = MetaActionDispatcher()
        
        # 验证 dispatch 方法存在
        assert hasattr(dispatcher, 'dispatch')
    
    def test_default_timeouts(self):
        """测试默认超时配置"""
        from bot.meta_actions.dispatcher import MetaActionDispatcher
        
        assert MetaActionDispatcher.DEFAULT_TIMEOUTS.get("smelt_item") == 120.0
        assert MetaActionDispatcher.DEFAULT_TIMEOUTS.get("retreat_safe") == 30.0
    
    @pytest.mark.asyncio
    async def test_dispatch_unknown_action(self):
        """测试未知动作返回错误"""
        from bot.meta_actions.dispatcher import MetaActionDispatcher
        
        # 使用 MagicMock 并显式设置属性不存在
        mock_actions = MagicMock()
        del mock_actions.unknown_action_xyz  # 确保属性不存在
        
        dispatcher = MetaActionDispatcher()
        result = await dispatcher.dispatch("unknown_action_xyz", {}, mock_actions)
        
        assert result.success is False
        assert result.error_code == "UNKNOWN_ACTION"

