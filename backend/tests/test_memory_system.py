# Test Memory Facade and Session
# 验证统一记忆系统的基本功能

import asyncio
import sys
import os

# 添加 backend 到 path
backend_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, backend_dir)
os.chdir(backend_dir)


async def test_background_task_manager():
    """测试后台任务管理器"""
    print("\n=== Test 1: BackgroundTaskManager ===")
    
    from utils.background_task_manager import BackgroundTaskManager
    
    manager = BackgroundTaskManager()
    
    # 创建一些后台任务
    completed = []
    
    async def dummy_task(n: int):
        await asyncio.sleep(0.1)
        completed.append(n)
    
    # 发射 5 个任务
    for i in range(5):
        manager.fire_and_forget(dummy_task(i))
    
    print(f"Pending tasks: {manager.pending_count()}")
    assert manager.pending_count() == 5, f"Expected 5, got {manager.pending_count()}"
    
    # 等待所有任务完成
    count = await manager.wait_all_pending(timeout=5.0)
    print(f"Completed tasks: {count}")
    assert count == 5, f"Expected 5 completed, got {count}"
    assert len(completed) == 5, f"Expected 5 in list, got {len(completed)}"
    
    print("✅ BackgroundTaskManager: PASSED")


async def test_session():
    """测试会话管理"""
    print("\n=== Test 2: Session ===")
    
    from state.session import Session, SessionMessage
    
    # 创建会话
    session = Session.create(
        owner_uuid="player_123",
        owner_name="Steve",
        bot_name="TestBot",
    )
    
    assert session.owner_uuid == "player_123"
    assert session.owner_name == "Steve"
    assert session.is_active is True
    print(f"Session created: id={session.session_id}")
    
    # 添加消息
    session.add_message("user", "去挖铁矿", "player_123", "Steve")
    session.add_message("assistant", "好的主人，我去挖铁矿~", "bot", "TestBot")
    session.add_message("user", "你好", "player_456", "Alex")  # 旁观者
    
    assert session.message_count == 3
    assert session.owner_message_count == 1  # 只有 Steve 是主人
    print(f"Messages: {session.message_count}, Owner messages: {session.owner_message_count}")
    
    # 测试带归属标记的上下文
    context = session.get_context_with_ownership()
    print("Context with ownership:")
    for msg in context:
        print(f"  {msg['role']}: {msg['content'][:50]}...")
    
    assert "[Steve (Owner)]" in context[0]["content"]
    assert "[Alex (Bystander)]" in context[2]["content"]
    
    # 结束会话
    session.end("Test session summary")
    assert session.is_active is False
    
    print("✅ Session: PASSED")


async def test_memory_facade_basic():
    """测试 MemoryFacade 基本功能 (无 DB)"""
    print("\n=== Test 3: MemoryFacade (Basic) ===")
    
    from utils.background_task_manager import BackgroundTaskManager
    from state.memory_facade import MemoryFacade
    
    task_manager = BackgroundTaskManager()
    
    # 创建 MemoryFacade (无 ContextManager)
    memory = MemoryFacade(
        context_manager=None,  # 无 DB
        task_manager=task_manager,
        bot_name="TestBot",
    )
    
    # 开始会话
    session_id = memory.start_session("player_123", "Steve")
    print(f"Session started: {session_id}")
    assert memory.has_active_session is True
    
    # 添加消息
    memory.add_message("user", "你好", "player_123", "Steve")
    memory.add_message("assistant", "你好主人~", "bot", "TestBot")
    memory.add_message("user", "帮我挖矿", "player_123", "Steve")
    
    # 获取热缓冲区
    buffer = memory.get_hot_buffer()
    print(f"Hot buffer: {len(buffer)} messages")
    assert len(buffer) == 3
    
    # 测试获取 LLM 上下文
    context = await memory.get_llm_context(depth="fast")
    print(f"LLM context: {len(context)} messages")
    
    # 结束会话
    summary = memory.end_session()
    print(f"Session ended, summary: {summary}")
    assert memory.has_active_session is False
    
    # 清理
    await memory.flush_pending()
    
    print("✅ MemoryFacade (Basic): PASSED")


async def main():
    """运行所有测试"""
    print("=" * 50)
    print("Unified Memory System - Basic Tests")
    print("=" * 50)
    
    try:
        await test_background_task_manager()
        await test_session()
        await test_memory_facade_basic()
        
        print("\n" + "=" * 50)
        print("🎉 All tests PASSED!")
        print("=" * 50)
        return 0
        
    except AssertionError as e:
        print(f"\n❌ Test FAILED: {e}")
        return 1
    except Exception as e:
        print(f"\n❌ Error: {e}")
        import traceback
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    exit_code = asyncio.run(main())
    exit(exit_code)
