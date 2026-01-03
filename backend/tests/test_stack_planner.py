# Stack Planner Unit Tests
# 栈式规划器单元测试

import pytest
from task.interfaces import StackTask, TaskStatus
from task.stack_planner import StackPlanner, StackOverflowError


class TestStackPlannerBasic:
    """基础功能测试"""
    
    def test_initial_state(self):
        """测试初始状态"""
        planner = StackPlanner()
        assert planner.is_empty()
        assert planner.depth == 0
        assert planner.current() is None
    
    def test_push_single_task(self):
        """测试压入单个任务"""
        planner = StackPlanner()
        task = StackTask(name="采集木头", goal="mine oak_log 5")
        
        planner.push(task)
        
        assert not planner.is_empty()
        assert planner.depth == 1
        assert planner.current() == task
        assert task.status == TaskStatus.IN_PROGRESS
    
    def test_push_multiple_tasks(self):
        """测试压入多个任务"""
        planner = StackPlanner()
        task1 = StackTask(name="合成床", goal="craft bed 1")
        task2 = StackTask(name="杀羊", goal="attack sheep")
        
        planner.push(task1)
        planner.push(task2)
        
        assert planner.depth == 2
        assert planner.current() == task2
        
        # 检查状态
        assert task1.status == TaskStatus.BLOCKED
        assert task2.status == TaskStatus.IN_PROGRESS
        assert task1.blocking_reason == "等待前置任务: 杀羊"
    
    def test_pop_task(self):
        """测试弹出任务"""
        planner = StackPlanner()
        task1 = StackTask(name="合成床", goal="craft bed 1")
        task2 = StackTask(name="杀羊", goal="attack sheep")
        
        planner.push(task1)
        planner.push(task2)
        
        popped = planner.pop()
        
        assert popped == task2
        assert popped.status == TaskStatus.COMPLETED
        assert planner.depth == 1
        assert planner.current() == task1
        assert task1.status == TaskStatus.IN_PROGRESS
        assert task1.blocking_reason is None
    
    def test_pop_empty_stack(self):
        """测试弹出空栈"""
        planner = StackPlanner()
        result = planner.pop()
        assert result is None
    
    def test_clear(self):
        """测试清空栈"""
        planner = StackPlanner()
        planner.push(StackTask(name="任务1", goal="task1"))
        planner.push(StackTask(name="任务2", goal="task2"))
        planner.push(StackTask(name="任务3", goal="task3"))
        
        planner.clear()
        
        assert planner.is_empty()
        assert planner.depth == 0


class TestStackPlannerLimits:
    """深度限制测试"""
    
    def test_soft_limit_warning(self):
        """测试软限制警告 (不抛异常)"""
        planner = StackPlanner(soft_limit=3, hard_limit=5)
        
        for i in range(4):
            planner.push(StackTask(name=f"任务{i}", goal=f"task{i}"))
        
        # 超过软限制但未超硬限制，应该成功
        assert planner.depth == 4
    
    def test_hard_limit_exception(self):
        """测试硬限制异常"""
        planner = StackPlanner(soft_limit=3, hard_limit=5)
        
        # 压入 5 个任务
        for i in range(5):
            planner.push(StackTask(name=f"任务{i}", goal=f"task{i}"))
        
        # 第 6 个应该抛出异常
        with pytest.raises(StackOverflowError) as exc_info:
            planner.push(StackTask(name="任务5", goal="task5"))
        
        assert "硬限制" in str(exc_info.value)
    
    def test_custom_limits(self):
        """测试自定义限制值"""
        planner = StackPlanner(soft_limit=2, hard_limit=3)
        
        assert planner.soft_limit == 2
        assert planner.hard_limit == 3


class TestStackPlannerDebug:
    """调试功能测试"""
    
    def test_get_stack_trace(self):
        """测试获取栈追踪"""
        planner = StackPlanner()
        planner.push(StackTask(name="根任务", goal="root"))
        planner.push(StackTask(name="子任务", goal="child"))
        
        trace = planner.get_stack_trace()
        
        assert len(trace) == 2
        assert "根任务" in trace[0]
        assert "子任务" in trace[1]
        assert "blocked" in trace[0]
        assert "in_progress" in trace[1]
    
    def test_repr_empty(self):
        """测试空栈的字符串表示"""
        planner = StackPlanner()
        assert "empty" in repr(planner)
    
    def test_repr_with_tasks(self):
        """测试有任务时的字符串表示"""
        planner = StackPlanner()
        planner.push(StackTask(name="测试任务", goal="test"))
        
        repr_str = repr(planner)
        assert "depth=1" in repr_str
        assert "测试任务" in repr_str


class TestStackTaskDataClass:
    """StackTask 数据类测试"""
    
    def test_default_values(self):
        """测试默认值"""
        task = StackTask(name="测试", goal="test")
        
        assert task.context == {}
        assert task.status == TaskStatus.PENDING
        assert task.blocking_reason is None
    
    def test_repr(self):
        """测试字符串表示"""
        task = StackTask(name="测试", goal="test")
        assert "测试" in repr(task)
        assert "pending" in repr(task)


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
