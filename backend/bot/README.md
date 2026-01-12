# Bot Action System (Bot 动作系统)

`backend/bot/` 模块负责 Bot 的具体物理交互。它封装了 Mineflayer 的 API，向上层提供语义化的动作接口。

## 🌟 核心架构

### 1. Meta-Action (元动作)
位于 `meta_actions/` 目录。
元动作是 Bot 行为的基本单元。它们比 Mineflayer 的原子 API 更高级，但比完整的任务更低级。

**特点:**
-   **原子性**: 一个元动作完成一个具体的物理交互（如 `mine_block`, `craft_item`, `goto`）。
-   **无状态**: 元动作不持有任务状态，只负责执行。
-   **接口**: 必须实现 `IMetaAction` 接口。

**常用元动作:**
-   `navigate`: 智能寻路。
-   `mine_block`: 挖掘指定方块。
-   `place_block`: 放置方块。
-   `attack`: 攻击实体。
-   `craft`: 合成物品。
-   `hand_over`: 递送物品。

### 2. MetaActionRegistry (注册表)
负责动态管理所有的 Meta-Action。
-   **自动发现**: 自动加载 `meta_actions/` 下的动作类。
-   **过滤**: 支持根据当前环境或 Bot 状态过滤可用的动作。

### 3. MineflayerAdapter (适配器)
位于 `mineflayer_adapter.py`。
这是 Python 与 JavaScript (Mineflayer) 交互的底层桥梁。
-   **封装**: 将 WebSocket 收到的指令转换为 Mineflayer 的 API 调用。
-   **状态同步**: 定时推送 Bot 的位置、生命值、背包等信息到后端。
-   **安全**: 处理 AuthMe 登录，自动隐藏密码日志。

### 4. Lifecycle Manager (生命周期管理)
位于 `lifecycle_manager.py`。
管理 Bot 的启动、重生、重连和销毁。确保在断线时能自动恢复。

## 🛠️ 扩展指南

**如何添加一个新的动作？**

1.  在 `backend/bot/meta_actions/` 下创建一个新的 Python 文件。
2.  定义一个类，继承自 `IMetaAction`。
3.  实现 `execute` 方法，编写具体的 Mineflayer 逻辑。
4.  实现 `validate` 方法，定义动作执行的前置条件。
5.  在 `MetaActionRegistry` 中注册（或利用自动发现机制）。

示例：
```python
class JumpAction(IMetaAction):
    def execute(self, bot, **kwargs):
        bot.setControlState('jump', True)
        # ...
```
