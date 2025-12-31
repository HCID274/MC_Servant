# LLM Test Script
"""
Qwen-Flash 调用测试脚本

使用方法:
    cd d:\\Code\\Python_OtherPro\\LHQ\\MC_agent\\MC_Servant\\backend
    python -m llm.test_qwen
    
需要配置:
    在 .env 文件中设置 MC_SERVANT_OPENAI_API_KEY
"""

import asyncio
import sys


async def test_qwen_client():
    """测试 QwenClient 基础功能"""
    from config import settings
    from llm.qwen_client import QwenClient
    
    print("=" * 50)
    print("测试 1: QwenClient 基础调用")
    print("=" * 50)
    
    if not settings.openai_api_key:
        print("❌ 错误: 未配置 OPENAI_API_KEY")
        print("请在 .env 文件中设置 MC_SERVANT_OPENAI_API_KEY")
        return False
    
    client = QwenClient(
        api_key=settings.openai_api_key,
        base_url=settings.openai_base_url,
        model=settings.openai_model,
    )
    
    print(f"使用模型: {client.model_name}")
    
    # 测试普通对话
    print("\n--- 测试 chat() ---")
    try:
        response = await client.chat(
            messages=[{"role": "user", "content": "你好，请用一句话介绍你自己"}],
            max_tokens=100,
        )
        print(f"回复: {response}")
        print("✅ chat() 测试通过")
    except Exception as e:
        print(f"❌ chat() 测试失败: {e}")
        return False
    
    # 测试 JSON 输出
    print("\n--- 测试 chat_json() ---")
    try:
        response = await client.chat_json(
            messages=[
                {"role": "system", "content": "输出 JSON 格式，包含 greeting 和 mood 两个字段"},
                {"role": "user", "content": "你好"},
            ],
            max_tokens=100,
        )
        print(f"JSON 回复: {response}")
        assert "greeting" in response or "mood" in response
        print("✅ chat_json() 测试通过")
    except Exception as e:
        print(f"❌ chat_json() 测试失败: {e}")
        return False
    
    return True


async def test_intent_recognizer():
    """测试意图识别器"""
    from config import settings
    from llm.qwen_client import QwenClient
    from llm.intent import IntentRecognizer, Intent
    
    print("\n" + "=" * 50)
    print("测试 2: IntentRecognizer 意图识别")
    print("=" * 50)
    
    if not settings.openai_api_key:
        print("⚠️ 跳过: 未配置 API Key")
        return True
    
    client = QwenClient(
        api_key=settings.openai_api_key,
        base_url=settings.openai_base_url,
        model=settings.openai_model,
    )
    
    recognizer = IntentRecognizer(client)
    
    # 测试用例
    test_cases = [
        ("帮我盖个房子", Intent.BUILD),
        ("去挖点铁矿", Intent.MINE),
        ("你好呀", Intent.CHAT),
        ("你现在在哪", Intent.STATUS),
        ("停下来", Intent.CANCEL),
    ]
    
    all_passed = True
    for user_input, expected_intent in test_cases:
        print(f"\n输入: \"{user_input}\"")
        try:
            intent, metadata = await recognizer.recognize(user_input)
            status = "✅" if intent == expected_intent else "⚠️"
            print(f"{status} 识别结果: {intent.value} (期望: {expected_intent.value})")
            print(f"   置信度: {metadata.get('confidence', 'N/A')}")
            print(f"   原因: {metadata.get('reason', 'N/A')}")
            
            if intent != expected_intent:
                all_passed = False
                
        except Exception as e:
            print(f"❌ 识别失败: {e}")
            all_passed = False
    
    return all_passed


async def test_simple_recognizer():
    """测试简单规则匹配意图识别（不需要 API Key）"""
    from llm.intent import IntentRecognizer, Intent
    from llm.interfaces import ILLMClient
    
    print("\n" + "=" * 50)
    print("测试 3: 简单规则匹配 (无需 API Key)")
    print("=" * 50)
    
    # 创建一个 Mock LLM Client
    class MockLLMClient(ILLMClient):
        @property
        def model_name(self): return "mock"
        async def chat(self, messages, **kwargs): return ""
        async def chat_json(self, messages, **kwargs): return {}
    
    recognizer = IntentRecognizer(MockLLMClient())
    
    test_cases = [
        ("帮我盖个房子", Intent.BUILD),
        ("去挖铁矿", Intent.MINE),
        ("种些小麦", Intent.FARM),
        ("守住这里", Intent.GUARD),
        ("你在哪", Intent.STATUS),
        ("停下", Intent.CANCEL),
        ("你好", Intent.CHAT),
    ]
    
    all_passed = True
    for user_input, expected_intent in test_cases:
        result = recognizer.recognize_simple(user_input)
        status = "✅" if result == expected_intent else "❌"
        print(f"{status} \"{user_input}\" -> {result.value} (期望: {expected_intent.value})")
        if result != expected_intent:
            all_passed = False
    
    return all_passed


async def main():
    print("🔧 MC_Servant LLM 模块测试")
    print("-" * 50)
    
    # 测试简单规则匹配（无需 API Key）
    simple_ok = await test_simple_recognizer()
    
    # 测试 QwenClient（需要 API Key）
    client_ok = await test_qwen_client()
    
    # 测试意图识别（需要 API Key）
    intent_ok = await test_intent_recognizer()
    
    print("\n" + "=" * 50)
    print("测试结果汇总")
    print("=" * 50)
    print(f"简单规则匹配: {'✅ 通过' if simple_ok else '❌ 失败'}")
    print(f"QwenClient: {'✅ 通过' if client_ok else '❌ 失败'}")
    print(f"意图识别: {'✅ 通过' if intent_ok else '❌ 失败'}")
    
    return 0 if (simple_ok and client_ok and intent_ok) else 1


if __name__ == "__main__":
    exit_code = asyncio.run(main())
    sys.exit(exit_code)
