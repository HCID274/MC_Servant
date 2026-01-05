# Memory System Test Script
"""
分层记忆系统测试脚本

使用方法:
    cd d:\\Code\\Python_OtherPro\\LHQ\\MC_agent\\MC_Servant\\backend
    python -m tests.test_context_manager

需要配置:
    1. 在 .env 文件中设置 MC_SERVANT_OPENAI_API_KEY
    2. 确保 PostgreSQL 服务运行中
    3. 执行 alembic upgrade head 创建表
"""

import asyncio
import sys


async def test_compression_prompts():
    """测试压缩 Prompt (无需数据库)"""
    print("=" * 50)
    print("测试 1: MemoryCompressor 压缩 Prompt")
    print("=" * 50)
    
    from config import settings
    
    if not settings.openai_api_key:
        print("⚠️ 跳过: 未配置 API Key")
        return True
    
    from llm.qwen_client import QwenClient
    from llm.compression import MemoryCompressor
    
    client = QwenClient(
        api_key=settings.openai_api_key,
        base_url=settings.openai_base_url,
        model=settings.openai_model,
    )
    
    compressor = MemoryCompressor(client)
    
    # 模拟对话
    raw_buffer = [
        {"role": "user", "content": "你好呀！我是玩家小明"},
        {"role": "assistant", "content": "你好主人~很高兴认识你喵~"},
        {"role": "user", "content": "帮我盖一个小木屋吧"},
        {"role": "assistant", "content": "好的主人！我来帮你建造温馨小木屋~"},
        {"role": "user", "content": "位置就在坐标 100, 64, 200"},
        {"role": "assistant", "content": "收到喵~我记住这个位置了！"},
    ]
    
    print("\n--- 测试 L0→L1 压缩 (叙事化) ---")
    try:
        result = await compressor.compress_with_result("L0_L1", raw_buffer=raw_buffer)
        if result.success:
            print(f"✅ 压缩成功!")
            print(f"   输入: {result.input_length} 字符")
            print(f"   输出: {result.output_length} 字符")
            print(f"   内容:\n{result.content[:500]}...")
        else:
            print(f"❌ 压缩失败: {result.error}")
            return False
    except Exception as e:
        print(f"❌ 异常: {e}")
        return False
    
    print("\n--- 测试 L1→L2 压缩 (认知化) ---")
    try:
        episodic = result.content
        result2 = await compressor.compress_with_result(
            "L1_L2",
            episodic=episodic,
            old_core="",
        )
        if result2.success:
            print(f"✅ 压缩成功!")
            print(f"   输入: {result2.input_length} 字符") 
            print(f"   输出: {result2.output_length} 字符")
            print(f"   内容:\n{result2.content}")
        else:
            print(f"❌ 压缩失败: {result2.error}")
            return False
    except Exception as e:
        print(f"❌ 异常: {e}")
        return False
    
    return True


async def test_database_connection():
    """测试数据库连接"""
    print("\n" + "=" * 50)
    print("测试 2: 数据库连接")
    print("=" * 50)
    
    from config import settings
    from db.database import db
    
    print(f"数据库 URL: {settings.database_url[:50]}...")
    
    try:
        await db.init(settings.database_url, echo=False)
        print("✅ 数据库连接成功")
        
        # 测试会话
        from sqlalchemy import text
        async with db.session() as session:
            result = await session.execute(text("SELECT 1"))
            print("✅ 会话测试成功")
        
        await db.close()
        return True
    except Exception as e:
        print(f"❌ 数据库连接失败: {e}")
        print("提示: 请确保 PostgreSQL 运行中，且 .env 配置正确")
        return False


async def test_context_repository():
    """测试上下文仓库"""
    print("\n" + "=" * 50)
    print("测试 3: ContextRepository CRUD")
    print("=" * 50)
    
    from config import settings
    from db.database import db
    from db.context_repository import ContextRepository
    
    try:
        await db.init(settings.database_url, echo=False)
        
        async with db.session() as session:
            repo = ContextRepository(session)
            
            # 创建测试上下文
            ctx = await repo.get_or_create(
                player_uuid="test-uuid-12345",
                player_name="TestPlayer",
                bot_name="TestBot",
            )
            print(f"✅ 创建上下文: id={ctx.id}")
            
            # 更新 buffer
            test_buffer = [
                {"role": "user", "content": "测试消息"},
                {"role": "assistant", "content": "测试回复"},
            ]
            await repo.update_buffer(ctx.id, test_buffer)
            print("✅ 更新 buffer 成功")
            
            # 更新记忆
            await repo.update_memories(
                ctx.id,
                episodic="这是测试情景记忆",
                core="这是测试核心记忆",
            )
            print("✅ 更新记忆成功")
        
        await db.close()
        return True
    except Exception as e:
        print(f"❌ 仓库测试失败: {e}")
        import traceback
        traceback.print_exc()
        return False


async def test_context_manager_basic():
    """测试 ContextManager 基础功能"""
    print("\n" + "=" * 50)
    print("测试 4: ContextManager 基础功能")
    print("=" * 50)
    
    from config import settings
    from db.database import db
    
    try:
        # 初始化数据库
        await db.init(settings.database_url, echo=False)
        
        # 创建 ContextManager (不带 LLM，测试基础功能)
        from llm.context_manager import ContextManager
        ctx_manager = ContextManager(llm_client=None)
        
        # 测试添加消息
        await ctx_manager.add_message(
            player_uuid="test-player-001",
            player_name="TestPlayer",
            bot_name="TestBot",
            role="user",
            content="你好！这是一条测试消息",
        )
        print("✅ 添加用户消息成功")
        
        await ctx_manager.add_message(
            player_uuid="test-player-001",
            player_name="TestPlayer", 
            bot_name="TestBot",
            role="assistant",
            content="收到~这是助手的回复喵",
        )
        print("✅ 添加助手消息成功")
        
        # 测试获取上下文
        llm_ctx = await ctx_manager.get_llm_context(
            player_uuid="test-player-001",
            bot_name="TestBot",
            depth="standard",
        )
        print(f"✅ 获取 LLM 上下文成功, 消息数: {len(llm_ctx)}")
        
        await db.close()
        return True
    except Exception as e:
        print(f"❌ ContextManager 测试失败: {e}")
        import traceback
        traceback.print_exc()
        return False


async def main():
    print("🧠 MC_Servant 分层记忆系统测试")
    print("-" * 50)
    
    results = {}
    
    # 测试 1: 压缩 Prompt (需要 LLM API Key)
    results["compression"] = await test_compression_prompts()
    
    # 测试 2: 数据库连接 (需要 PostgreSQL)
    results["database"] = await test_database_connection()
    
    # 测试 3: ContextRepository (需要数据库)
    if results["database"]:
        results["repository"] = await test_context_repository()
    else:
        results["repository"] = False
        print("\n⚠️ 跳过仓库测试 (数据库未连接)")
    
    # 测试 4: ContextManager 基础功能 (需要数据库)
    if results["database"]:
        results["context_manager"] = await test_context_manager_basic()
    else:
        results["context_manager"] = False
        print("\n⚠️ 跳过 ContextManager 测试 (数据库未连接)")
    
    # 汇总
    print("\n" + "=" * 50)
    print("测试结果汇总")
    print("=" * 50)
    print(f"压缩 Prompt: {'✅ 通过' if results.get('compression') else '❌ 失败'}")
    print(f"数据库连接: {'✅ 通过' if results.get('database') else '❌ 失败'}")
    print(f"ContextRepository: {'✅ 通过' if results.get('repository') else '❌ 失败'}")
    print(f"ContextManager: {'✅ 通过' if results.get('context_manager') else '❌ 失败'}")
    
    all_passed = all(results.values())
    return 0 if all_passed else 1


if __name__ == "__main__":
    exit_code = asyncio.run(main())
    sys.exit(exit_code)
