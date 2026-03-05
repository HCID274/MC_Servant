backend/
│
├──【全局核心】 
│   ├── main.py                          [接入总控] FastAPI/WS 总入口：路由分发与生命周期管理
│   └── schemas.py                       [全局状态] LangGraph 共享大字典 (MaidState) 与结构化输出模型
│
├──【L1 第一层：思考层】 (大模型/LangChain) 
│   └── llm_agent/
│       ├── prompts.py                   [角色设定] 存放系统提示词与 Few-Shot 样本
│       ├── router.py                    [意图路由] 判别 Chat/Task 意图，输出结构化动作
│       └── planner.py                   [任务拆解] 将复杂任务(如挖铁)拆解为原子动作序列
│
├──【L2 第二层：编排层】 (LangGraph 状态机)
│   └── graph/
│       ├── workflow.py                  [流程主干] StateGraph 节点注册、连线与图编译入口
│       └── conditions.py                [条件分流] 动态路由规则 (如：成功继续、失败重试/挂起)
│
├──【L3 第三层：翻译层】 (语义 -> 物理映射)
│   └── grounding/
│       ├── translator.py                [指令翻译] 抽象动作 (mine) -> 游戏具体 API (find_and_dig)
│       └── env_client.py                [环境感知] 获取游戏实时坐标、视线与周边方块快照
│
├──【L4 第四层：执行层】 (控制 Mineflayer)
│   └── bot/
│       ├── interfaces.py                [能力契约] 抽象动作接口类定义 (解耦底层实现)
│       └── mineflayer_adapter.py        [动作落地] 通过 Python-Node 通信桥驱动游戏角色移动/破坏
│
├──【基建层】 (下水道/脚手架)
│   ├── config.py                        [配置支撑] 环境变量读取 (LLM 密钥、端口配置)
│   ├── protocol.py                      [协议支撑] 跨语言通信的消息模型 (Pydantic/JSON 契约)
│   ├── text_utils.py                    [工具支撑] 文本切分、正则提取等纯函数库
│   ├── data/
│   │   └── __init__.py                  [数据支撑] 静态数据表 (如合成表配方) 目录
│   └── websocket/
│       └── connection_manager.py        [通信管理] WS 连接池、单播/广播、心跳保活清理
│
└──【测试与历史遗留区】 (游乐场/墓地)
    ├── tests/
    │   └── test_graph_offline.py        [单元测试] 脱机验证 LangGraph 状态流转与队列逻辑
    ├── test_ws_client.py                [联调脚本] WS 客户端模拟器 (手工发 JSON 看回包)
    ├── standalone_tag_test.py           [遗留脚本] 历史 Tag 逻辑独立测试代码 (待清理)
    └── quick_test_tag.py                [遗留脚本] 历史 Tag 逻辑集成快测代码 (待清理)