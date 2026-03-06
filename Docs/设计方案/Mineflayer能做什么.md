### 第二步：Mineflayer 到底能实现什么？（能力映射表）

你 Prompt 里定义的所有 Action，Mineflayer **全部都能完美实现**！并且有现成的 API 和插件生态。我们来一一对应：

#### 1. 聊天类 (Chat Choreographer)
*   `move_to("master")` ➔ **Mineflayer 能力**：借助 `mineflayer-pathfinder` 插件，设置 `GoalFollow(player, 2)`，女仆会自动绕开岩浆、跳过沟壑，走到主人身边两格处停下。
*   `look_at("master_eyes")` ➔ **Mineflayer 能力**：使用 `bot.lookAt(xyz)`。获取主人的坐标并加上主人的身高（y+1.62），女仆就会抬头看着你的眼睛。
*   `animate("sneak" / "jump" / "swing_arm")` ➔ **Mineflayer 能力**：
    *   潜行卖萌：`bot.setControlState('sneak', true)`，延迟0.5秒后再 `false`。
    *   跳跃：`bot.setControlState('jump', true)`。
    *   挥手：`bot.swingArm('right')`。
*   `speak(...)` ➔ **Mineflayer 能力**：`bot.chat("主人辛苦了喵！")`。

#### 2. 任务类 (Task Planner)
*   `mine("any_log" / "stone")` ➔ **Mineflayer 能力**：
    *   使用 `bot.findBlocks({ matching: [所有木头ID], maxDistance: 32 })` 扫描周围。
    *   走到木头前。
    *   判断背包是否有斧头并拿在手上（`bot.equip`）。
    *   执行 `bot.dig(block)`。
*   `pick_up("porkchop")` ➔ **Mineflayer 能力**：扫描地上的掉落物实体 (`bot.entities`)，找出猪排，走到它身上完成拾取。
*   `craft("wooden_pickaxe")` ➔ **Mineflayer 能力**：使用内置的合成 API `bot.craft(recipe, count, craftingTable)`。Mineflayer 会自动把木板和木棍摆进工作台UI里并取回成品。
*   `place("crafting_table")` ➔ **Mineflayer 能力**：手里拿着工作台，调用 `bot.placeBlock(referenceBlock, faceVector)` 放在地上。

