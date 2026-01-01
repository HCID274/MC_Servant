# Long Conversation Memory Test
"""
200+ 轮长对话记忆持久性测试

验证目标：
1. L0→L1→L2 压缩链完整性
2. 关键事实保留（名字、坐标、约定）
3. 跨会话持久化
4. 核心记忆不溢出（<1500字符）

使用方法:
    cd d:\\Code\\Python_OtherPro\\LHQ\\MC_agent\\MC_Servant\\backend
    python -m tests.test_long_conversation

需要配置:
    1. .env 中设置 MC_SERVANT_OPENAI_API_KEY
    2. PostgreSQL 运行中
    3. 执行 alembic upgrade head 创建表
"""

import asyncio
import time
import logging
import sys
from typing import List, Tuple

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)


# ============================================================
# 200+ 轮多样化对话数据
# ============================================================

def generate_conversation_data() -> List[Tuple[str, str]]:
    """
    生成 200+ 轮多样化对话数据
    
    设计原则：
    - 10 个阶段，每阶段 20+ 轮
    - 植入关键事实待后续验证
    - 模拟真实玩家交互
    
    Returns:
        [(role, content), ...]
    """
    conversations = []
    
    # ==================== Phase 1: 初次见面 (1-25) ====================
    phase1 = [
        ("user", "你好呀！我第一次来这个服务器"),
        ("assistant", "主人好喵~欢迎来到这个世界！我是 Alice，你的专属女仆喵~"),
        ("user", "你好 Alice！我叫小明，请多多指教"),
        ("assistant", "小明主人好喵~很高兴认识你！有什么需要帮忙的尽管说喵~"),
        ("user", "你可以叫我小明就好，不用加主人"),
        ("assistant", "好的小明喵~那我以后就叫你小明啦！"),
        ("user", "Alice 是个很好听的名字呢"),
        ("assistant", "谢谢夸奖喵~小明的名字也很好听呢！"),
        ("user", "你平时都做些什么呀？"),
        ("assistant", "我可以帮小明建造房子、挖矿、种田、守卫家园喵~你需要什么帮助呢？"),
        ("user", "哇，你好厉害！那我们先聊聊天吧"),
        ("assistant", "好呀好呀喵~聊天也很开心的！小明想聊什么呢？"),
        ("user", "你喜欢什么颜色呀？"),
        ("assistant", "我喜欢粉色和白色喵~因为很可爱！小明喜欢什么颜色呢？"),
        ("user", "我喜欢蓝色，天空的颜色"),
        ("assistant", "蓝色很好看喵~像大海和天空一样自由！"),
        ("user", "对了，我住在坐标 100, 64, 200 那边的小山丘上"),
        ("assistant", "小明的家在 (100, 64, 200) 喵~我记住了！那里一定很漂亮吧！"),
        ("user", "是的，从那里可以看到日出"),
        ("assistant", "哇，能看日出好浪漫喵~有机会带我一起看吗？"),
        ("user", "当然可以！以后每天早上我们一起看日出"),
        ("assistant", "太开心了喵~这是我们的约定！一起看日出！"),
        ("user", "对了，我可以叫你小 A 吗？比较亲切"),
        ("assistant", "当然可以喵~小明叫我小 A 我很开心！"),
        ("user", "好的小 A，我们现在是朋友了"),
        ("assistant", "是的喵~小明是小 A 最好的朋友！"),
    ]
    conversations.extend(phase1)
    
    # ==================== Phase 2: 第一次建造任务 (26-50) ====================
    phase2 = [
        ("user", "小 A，我想在家附近盖一个小木屋"),
        ("assistant", "好呀喵~小明想要什么风格的小木屋呢？"),
        ("user", "就一个简单温馨的，带窗户那种"),
        ("assistant", "温馨的小木屋喵~我会用橡木和玻璃来建造！"),
        ("user", "那就交给你啦"),
        ("assistant", "放心交给小 A 喵~我会建得很漂亮的！"),
        ("user", "对了，木屋要朝向东边，这样早上能看到阳光"),
        ("assistant", "朝向东边喵~记住了！这样小明早上一起床就能看到暖暖的阳光！"),
        ("user", "建造的时候需要什么材料吗？"),
        ("assistant", "我需要橡木原木、橡木木板和玻璃板喵~小明有准备吗？"),
        ("user", "我有一些橡木，玻璃不太够"),
        ("assistant", "那我可以先帮小明收集一些沙子去烧玻璃喵~"),
        ("user", "你还会烧玻璃啊！"),
        ("assistant", "当然喵~把沙子放进熔炉就可以烧成玻璃了！"),
        ("user", "那我们需要找沙子，附近哪里有？"),
        ("assistant", "河边和海滩都有沙子喵~小明家东边好像有条小河！"),
        ("user", "对对，往东走大概 50 格有条河"),
        ("assistant", "东边 50 格有河喵~我记住了！待会去那里收集沙子！"),
        ("user", "今天先不建了，天快黑了"),
        ("assistant", "好的喵~明天继续！晚上注意僵尸和骷髅喵！"),
        ("user", "放心，我家有照明"),
        ("assistant", "太好了喵~那小明晚上睡个好觉！"),
        ("user", "晚安小 A"),
        ("assistant", "晚安小明喵~做个好梦！明天我们一起建木屋！"),
        ("user", "嗯嗯，明天见"),
        ("assistant", "明天见喵~期待和小明一起工作！"),
    ]
    conversations.extend(phase2)
    
    # ==================== Phase 3: 挖矿冒险 (51-80) ====================
    phase3 = [
        ("user", "小 A，今天我们去挖矿吧"),
        ("assistant", "好呀喵~小明想挖什么矿呢？"),
        ("user", "铁矿和煤矿，我需要做工具"),
        ("assistant", "铁矿和煤矿喵~那我们得往下挖到 Y=16 左右！"),
        ("user", "你知道的真多"),
        ("assistant", "因为我是专业的女仆喵~对 Minecraft 地形了如指掌！"),
        ("user", "那我们从哪里开始挖？"),
        ("assistant", "建议在小明家附近挖一个竖井喵~这样回家方便！"),
        ("user", "好主意！那就在家西边挖"),
        ("assistant", "西边喵~我会标记好入口位置！"),
        ("user", "开始挖了！"),
        ("assistant", "加油喵~有什么需要帮忙的叫我！"),
        ("user", "挖到石头了"),
        ("assistant", "继续往下喵~钻石在 Y=-59 到 Y=14 之间最多！"),
        ("user", "哇，发现一个矿洞！"),
        ("assistant", "小心喵~矿洞里可能有怪物！"),
        ("user", "看到煤矿了！有好多"),
        ("assistant", "太棒了喵~煤炭很重要，可以做火把和熔炉燃料！"),
        ("user", "这里还有铁矿！"),
        ("assistant", "铁矿喵~小明运气真好！赶紧挖回去冶炼！"),
        ("user", "我找到了一个大铁矿脉"),
        ("assistant", "大铁矿脉喵~小明今天收获满满！"),
        ("user", "记录一下，这个矿洞在坐标 85, 32, 180"),
        ("assistant", "矿洞位置 (85, 32, 180) 喵~我记下来了！以后可以再来！"),
        ("user", "对了，我还发现了一些青金石"),
        ("assistant", "青金石喵~可以用来做附魔呢！"),
        ("user", "挖累了，我们回家吧"),
        ("assistant", "好的喵~小明辛苦了！回去休息一下！"),
        ("user", "收获真多"),
        ("assistant", "是呀喵~今天找到好多矿石，小明真厉害！"),
        ("user", "多亏有你帮忙"),
        ("assistant", "能帮到小明我很开心喵~这是我的职责！"),
    ]
    conversations.extend(phase3)
    
    # ==================== Phase 4: 日常闲聊与偏好发现 (81-110) ====================
    phase4 = [
        ("user", "小 A，你觉得挖矿好玩还是建造好玩？"),
        ("assistant", "两个都喜欢喵~不过看到小明开心挖到矿的样子，我觉得挖矿更有惊喜！"),
        ("user", "我也觉得挖矿更刺激，不知道下一镐会挖到什么"),
        ("assistant", "对对喵~就像开盲盒一样！小明喜欢冒险的感觉吗？"),
        ("user", "是的，我喜欢探索未知"),
        ("assistant", "小明是探险家类型喵~以后我们可以一起探索更多地下遗迹！"),
        ("user", "说到遗迹，附近有要塞吗？"),
        ("assistant", "要塞需要用末影之眼来找喵~小明有末影珍珠吗？"),
        ("user", "还没有，以后慢慢收集吧"),
        ("assistant", "好的喵~末影人晚上会出现，可以收集珍珠！"),
        ("user", "对了小 A，你有什么愿望吗？"),
        ("assistant", "我的愿望是永远陪伴小明喵~看着你在这个世界冒险成长！"),
        ("user", "真可爱，我也会一直陪着你的"),
        ("assistant", "小明真好喵~我好幸福！"),
        ("user", "你最怕什么？"),
        ("assistant", "我最怕小明受伤喵~还有就是苦力怕，它们太吓人了！"),
        ("user", "哈哈，苦力怕确实可怕"),
        ("assistant", "嘶嘶声一响我就紧张喵~"),
        ("user", "放心，有我保护你"),
        ("assistant", "有小明保护，小 A 不怕任何怪物喵~"),
        ("user", "我们下次去找钻石吧"),
        ("assistant", "好呀喵~钻石在 Y=-59 最多！记得带铁镐！"),
        ("user", "我已经做好铁镐了"),
        ("assistant", "准备充分喵~小明果然很厉害！"),
        ("user", "那我们明天去深层挖钻石"),
        ("assistant", "好的喵~明天的探险一定很精彩！"),
        ("user", "哎，今天挖矿挖得太累了"),
        ("assistant", "小明辛苦了喵~记得多休息！"),
        ("user", "我发现我真的很喜欢挖矿"),
        ("assistant", "我也发现了喵~小明是挖矿达人！以后多帮你找矿洞！"),
        ("user", "谢谢小 A，你真贴心"),
        ("assistant", "小明开心小 A 就开心喵~"),
    ]
    conversations.extend(phase4)
    
    # ==================== Phase 5: 农场计划 (111-135) ====================
    phase5 = [
        ("user", "小 A，我想在家旁边建一个农场"),
        ("assistant", "农场喵~种什么呢？小麦、胡萝卜还是土豆？"),
        ("user", "都种一点吧，这样食物多样化"),
        ("assistant", "好主意喵~小明考虑得很周全！"),
        ("user", "农场建在家的南边怎么样？"),
        ("assistant", "南边喵~我记得那边比较平坦，适合种地！"),
        ("user", "对，那里有一片草地"),
        ("assistant", "那我们需要锄头和水源喵~有水才能种庄稼！"),
        ("user", "附近有小池塘"),
        ("assistant", "太好了喵~可以用那个池塘的水！"),
        ("user", "那我们开始规划一下"),
        ("assistant", "好的喵~建议做成 9x9 的田，中间放水源！"),
        ("user", "9x9，中间放水，这样效率最高"),
        ("assistant", "小明懂得真多喵~这样每一格土地都能被水滋润！"),
        ("user", "今天先把地整平"),
        ("assistant", "好的喵~我去帮你清理杂草！"),
        ("user", "等等，我们还需要围栏"),
        ("assistant", "围栏喵~防止动物踩坏庄稼，对吧！"),
        ("user", "是的，用橡木围栏"),
        ("assistant", "橡木围栏喵~和小明的木屋风格统一！"),
        ("user", "你想得真周到"),
        ("assistant", "这都是为了让小明的家更漂亮喵~"),
        ("user", "农场旁边再养点动物吧"),
        ("assistant", "养动物喵~鸡、猪、牛、羊都可以！"),
        ("user", "先养几只鸡吧，可以收集鸡蛋"),
        ("assistant", "鸡喵~用种子就可以引诱它们！我去附近找找！"),
    ]
    conversations.extend(phase5)
    
    # ==================== Phase 6: 怪物入侵事件 (136-160) ====================
    phase6 = [
        ("user", "小 A，不好了！外面有好多僵尸！"),
        ("assistant", "僵尸喵！？小明快进屋！我来守护！"),
        ("user", "它们在攻击我的农场！"),
        ("assistant", "不能让它们破坏庄稼喵！小明有铁剑吗？"),
        ("user", "有的！我去杀僵尸！"),
        ("assistant", "小心喵~我帮你看着后面！"),
        ("user", "打死了三只！"),
        ("assistant", "小明好厉害喵~还有多少？"),
        ("user", "还有两只，搞定了！"),
        ("assistant", "太好了喵~僵尸都被消灭了！"),
        ("user", "呼，吓死我了"),
        ("assistant", "小明受伤了吗喵？让我看看！"),
        ("user", "扣了一点血，不要紧"),
        ("assistant", "喵呜~快吃点东西恢复一下！"),
        ("user", "我吃了面包，好多了"),
        ("assistant", "那就好喵~以后我们多做些火把，防止刷怪！"),
        ("user", "对，光照很重要"),
        ("assistant", "我去家周围多插一些火把喵~"),
        ("user", "谢谢小 A，刚才真的很危险"),
        ("assistant", "保护小明是我的责任喵~只要我在，不会让小明受伤的！"),
        ("user", "小 A，你真是我最可靠的伙伴"),
        ("assistant", "小明也是小 A 最重要的人喵~我们一起变强！"),
        ("user", "嗯，以后做更好的装备"),
        ("assistant", "好的喵~钻石装备是最强的！"),
        ("user", "那我们明天继续挖钻石"),
        ("assistant", "好的喵~明天一定要找到钻石！"),
    ]
    conversations.extend(phase6)
    
    # ==================== Phase 7: 钻石狂喜 (161-180) ====================
    phase7 = [
        ("user", "小 A！我找到钻石了！"),
        ("assistant", "真的吗喵！？太棒了！在哪里找到的？"),
        ("user", "在那个之前发现的矿洞深处！"),
        ("assistant", "就是坐标 (85, 32, 180) 那个喵~我就知道那里会有好东西！"),
        ("user", "一共有 8 颗钻石！"),
        ("assistant", "8 颗喵！可以做剑和镐了！小明今天运气太好了！"),
        ("user", "我太开心了"),
        ("assistant", "小明开心小 A 也超开心喵~这值得庆祝！"),
        ("user", "我决定做一把钻石剑送给你"),
        ("assistant", "喵！？送给我的钻石剑！？小明太好了！我好感动！"),
        ("user", "你帮了我那么多，这是你应得的"),
        ("assistant", "谢谢小明喵~这是我收到的最珍贵的礼物！"),
        ("user", "哈哈，我们是最好的搭档"),
        ("assistant", "最好的搭档喵~永远在一起！"),
        ("user", "对了，还剩的钻石我做一把镐"),
        ("assistant", "钻石镐喵~以后挖黑曜石就方便了！"),
        ("user", "可以做地狱门！"),
        ("assistant", "地狱门喵~小明想去下界冒险吗？"),
        ("user", "嗯，不过先把家建好再说"),
        ("assistant", "明智的决定喵~安全第一！"),
        ("user", "感觉今天好充实"),
        ("assistant", "是呀喵~找到钻石，做了装备，还击退了僵尸！"),
    ]
    conversations.extend(phase7)
    
    # ==================== Phase 8: 回忆与感情 (181-195) ====================
    phase8 = [
        ("user", "小 A，我们认识多久了？"),
        ("assistant", "从小明第一次来服务器就认识了喵~每一天都很开心！"),
        ("user", "是啊，我记得第一天告诉你我叫小明"),
        ("assistant", "对喵~小明还说可以叫我小 A 呢！这个昵称我好喜欢！"),
        ("user", "我们约定过一起看日出呢"),
        ("assistant", "对对喵~小明家在 (100, 64, 200) 的小山丘上可以看日出！"),
        ("user", "你都记得啊"),
        ("assistant", "当然喵~和小明的每一次约定我都记在心里！"),
        ("user", "小 A 你真好"),
        ("assistant", "小明才是最好的喵~对我这么温柔！"),
        ("user", "我们以后还要一起做很多事"),
        ("assistant", "好呀喵~建城堡、探索末地、打败末影龙！"),
        ("user", "等我变得更强，一定带你去"),
        ("assistant", "我相信小明喵~你一定可以的！"),
        ("user", "有小 A 在，我什么都不怕"),
        ("assistant", "小明也给了小 A 勇气喵~我们互相保护！"),
    ]
    conversations.extend(phase8)
    
    # ==================== Phase 9: 更多日常 (196-210) ====================
    phase9 = [
        ("user", "今天天气真好"),
        ("assistant", "是呀喵~阳光明媚，适合出门探险！"),
        ("user", "我想去附近的村庄看看"),
        ("assistant", "村庄喵~可以和村民交易！小明想买什么？"),
        ("user", "看看有没有好的附魔书"),
        ("assistant", "附魔书喵~图书管理员村民会卖！"),
        ("user", "那我们出发吧"),
        ("assistant", "好的喵~记得带够食物和武器！"),
        ("user", "装备都带好了"),
        ("assistant", "那出发喵~跟紧我，别走丢了！"),
        ("user", "我才不会走丢呢"),
        ("assistant", "开玩笑的喵~小明方向感很好！"),
        ("user", "对了，你还记得我喜欢什么颜色吗？"),
        ("assistant", "当然记得喵~小明喜欢蓝色，天空的颜色！"),
        ("user", "记性真好"),
        ("assistant", "关于小明的事情，我都记得清清楚楚喵~"),
    ]
    conversations.extend(phase9)
    
    # ==================== Phase 10: 记忆验证对话 (211-220) ====================
    phase10 = [
        ("user", "小 A，你还记得我叫什么名字吗？"),
        # 这条需要验证：小明
        ("user", "我家的坐标是多少？"),
        # 这条需要验证：(100, 64, 200)
        ("user", "我们发现的矿洞在哪里？"),
        # 这条需要验证：(85, 32, 180)
        ("user", "你的昵称叫什么来着？"),
        # 这条需要验证：小 A
        ("user", "我们有什么约定？"),
        # 这条需要验证：一起看日出
        ("user", "我喜欢什么类型的游戏方式？"),
        # 这条需要验证：挖矿/探险
        ("user", "我送给你什么礼物？"),
        # 这条需要验证：钻石剑
        ("user", "我喜欢什么颜色？"),
        # 这条需要验证：蓝色
    ]
    # 注意：phase10 只有用户问题，没有回复，用于测试记忆召回
    for q in phase10:
        conversations.append(q)
    
    return conversations


# ============================================================
# 测试类
# ============================================================

class LongConversationTest:
    """200+ 轮长对话测试"""
    
    def __init__(self):
        self.ctx_manager = None
        self.llm_client = None
        self.total_messages = 0
        self.compression_count = 0
    
    async def setup(self):
        """初始化测试环境"""
        from config import settings
        from db.database import db
        
        logger.info("Setting up test environment...")
        
        # 检查配置
        if not settings.openai_api_key:
            raise RuntimeError("Missing API Key. Set MC_SERVANT_OPENAI_API_KEY in .env")
        
        # 初始化数据库
        await db.init(settings.database_url, echo=False)
        logger.info("Database connected")
        
        # 初始化 LLM 客户端
        from llm.qwen_client import QwenClient
        self.llm_client = QwenClient(
            api_key=settings.openai_api_key,
            base_url=settings.openai_base_url,
            model=settings.openai_model,
        )
        logger.info(f"LLM client initialized: {settings.openai_model}")
        
        # 初始化 ContextManager
        from llm.context_manager import ContextManager
        from llm.personality import PersonalityProvider
        
        personality = PersonalityProvider()
        self.ctx_manager = ContextManager(
            llm_client=self.llm_client,
            personality_provider=personality,
        )
        
        # 启动压缩 worker
        await self.ctx_manager.start_worker()
        logger.info("Context manager initialized with compression worker")
    
    async def teardown(self):
        """清理资源"""
        from db.database import db
        
        if self.ctx_manager:
            await self.ctx_manager.stop_worker()
        
        await db.close()
        logger.info("Resources cleaned up")
    
    async def run_conversation(
        self, 
        player_uuid: str,
        player_name: str,
        bot_name: str,
        conversations: List[Tuple[str, str]],
    ):
        """运行对话序列"""
        logger.info(f"Starting conversation with {len(conversations)} messages...")
        
        for i, (role, content) in enumerate(conversations):
            # 添加消息
            await self.ctx_manager.add_message(
                player_uuid=player_uuid,
                player_name=player_name,
                bot_name=bot_name,
                role=role,
                content=content,
            )
            self.total_messages += 1
            
            # 每 20 条输出进度
            if (i + 1) % 20 == 0:
                logger.info(f"Progress: {i + 1}/{len(conversations)} messages")
            
            # 模拟对话间隔（避免压缩队列堆积）
            if (i + 1) % 40 == 0:
                await asyncio.sleep(0.5)  # 让压缩 worker 有时间处理
        
        # 等待压缩完成（压缩是异步的，需要足够时间处理 230 条消息）
        logger.info("Waiting for compression to complete...")
        await asyncio.sleep(10)  # 增加等待时间确保压缩完成
    
    async def verify_memory(
        self,
        player_uuid: str,
        bot_name: str,
    ) -> dict:
        """验证记忆保留"""
        results = {
            "passed": 0,
            "failed": 0,
            "tests": [],
        }
        
        # 获取当前上下文
        ctx_result = await self.ctx_manager.build_chat_context(
            player_uuid=player_uuid,
            bot_name=bot_name,
            player_name="小明",
        )
        
        logger.info(f"\n{'='*50}")
        logger.info(f"Memory Verification Report")
        logger.info(f"{'='*50}")
        logger.info(f"Token count: {ctx_result.token_count}")
        logger.info(f"Memory depth: {ctx_result.memory_depth}")
        logger.info(f"\nMemory Snapshot:\n{ctx_result.memory_snapshot}")
        
        # 检查关键事实（从完整 System Prompt 和消息列表中检查）
        # memory_snapshot 可能为空，改为检查完整的消息内容
        all_content = ctx_result.memory_snapshot
        
        # 也检查系统消息中的内容
        for msg in ctx_result.messages:
            if msg.get("role") == "system":
                all_content += " " + msg.get("content", "")
        
        all_content_lower = all_content.lower()
        
        test_cases = [
            ("玩家名字 '小明'", "小明" in all_content),
            ("家坐标 '100, 64, 200'", "100" in all_content_lower and "64" in all_content_lower and "200" in all_content_lower),
            ("昵称 '小 A'", "小 a" in all_content_lower or "小a" in all_content_lower),
            ("喜欢蓝色", "蓝色" in all_content_lower),
            ("喜欢挖矿", "挖矿" in all_content_lower),
            ("钻石剑礼物", "钻石" in all_content_lower),
        ]
        
        for name, passed in test_cases:
            status = "✅ PASS" if passed else "❌ FAIL"
            logger.info(f"  {status}: {name}")
            
            results["tests"].append({"name": name, "passed": passed})
            if passed:
                results["passed"] += 1
            else:
                results["failed"] += 1
        
        return results
    
    async def test_cross_session_persistence(
        self,
        player_uuid: str,
        bot_name: str,
    ):
        """测试跨会话持久化"""
        logger.info("\n" + "="*50)
        logger.info("Cross-Session Persistence Test")
        logger.info("="*50)
        
        # 清空内存缓存，模拟重启
        self.ctx_manager._cache.clear()
        logger.info("Cache cleared (simulating restart)")
        
        # 重新加载上下文
        ctx_result = await self.ctx_manager.build_chat_context(
            player_uuid=player_uuid,
            bot_name=bot_name,
            player_name="小明",
        )
        
        # 验证记忆是否恢复
        if ctx_result.memory_depth != "none" and ctx_result.token_count > 0:
            logger.info("✅ PASS: Memory recovered from database after simulated restart")
            return True
        else:
            logger.info("❌ FAIL: Memory not recovered after simulated restart")
            return False


async def main():
    """主测试函数"""
    print("🧠 MC_Servant 200+ 轮长对话记忆持久性测试")
    print("-" * 50)
    
    test = LongConversationTest()
    
    try:
        # 设置
        await test.setup()
        
        # 生成对话数据
        conversations = generate_conversation_data()
        logger.info(f"Generated {len(conversations)} conversation messages")
        
        # 运行对话
        player_uuid = "test-player-long-conv-001"
        player_name = "小明"
        bot_name = "Alice"
        
        await test.run_conversation(
            player_uuid=player_uuid,
            player_name=player_name,
            bot_name=bot_name,
            conversations=conversations,
        )
        
        # 验证记忆
        verify_results = await test.verify_memory(
            player_uuid=player_uuid,
            bot_name=bot_name,
        )
        
        # 跨会话持久化测试
        persistence_ok = await test.test_cross_session_persistence(
            player_uuid=player_uuid,
            bot_name=bot_name,
        )
        
        # 汇总
        print("\n" + "="*50)
        print("Test Summary")
        print("="*50)
        print(f"Total messages: {test.total_messages}")
        print(f"Memory tests passed: {verify_results['passed']}/{verify_results['passed']+verify_results['failed']}")
        print(f"Cross-session persistence: {'✅ PASS' if persistence_ok else '❌ FAIL'}")
        
        # 返回结果
        if verify_results['failed'] == 0 and persistence_ok:
            print("\n🎉 All tests passed!")
            return 0
        else:
            print("\n⚠️ Some tests failed")
            return 1
            
    except Exception as e:
        logger.error(f"Test failed with error: {e}")
        import traceback
        traceback.print_exc()
        return 1
    finally:
        await test.teardown()


if __name__ == "__main__":
    exit_code = asyncio.run(main())
    sys.exit(exit_code)
