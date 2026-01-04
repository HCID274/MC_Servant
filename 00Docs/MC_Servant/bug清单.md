MC_Servant 代码审查报告
审查日期: 2026-01-04
审查状态: 完成 (第一轮)

发现的问题
🔴 严重问题
1. [recovery_coordinator.py] 成功时返回错误的 RecoveryLevel
位置: 
recovery_coordinator.py:86-91

问题: 当动作成功时，返回的 
RecoveryDecision
 的 level 是 L1_ACTION_RETRY，语义上不太正确。

if result.success:
    self._reset_counters()
    return RecoveryDecision(
        level=RecoveryLevel.L1_ACTION_RETRY,  # 问题：成功却返回 L1
        action_type=RecoveryActionType.NO_RECOVERY,
        ...
    )
建议: 虽然 action_type=NO_RECOVERY 表明无需恢复，但 level 应该有一个更合适的值（如新增 L0_SUCCESS 或直接用 None）。

2. [main.py:168] GatherRunner 未注入 RecoveryCoordinator
位置: 
main.py:168

问题: 新增的 
RecoveryCoordinator
 模块没有被注入到 
GatherRunner
，导致恢复逻辑不会生效。

gather_runner = GatherRunner(actor=actor, resolver=resolver)
# 缺少 recovery=RecoveryCoordinator(rules)
建议: 添加 RecoveryCoordinator 注入：

from task.recovery_coordinator import create_recovery_coordinator
recovery = create_recovery_coordinator(rules)
gather_runner = GatherRunner(actor=actor, resolver=resolver, recovery=recovery)
3. [gather_runner.py] RecoveryCoordinator 没有 
get_consecutive_failures()
 方法暴露
位置: 
gather_runner.py

问题: 在 
_handle_failure
 方法中调用 self._recovery.get_consecutive_failures()，但 
IRecoveryCoordinator
 接口没有定义这个方法。

当前状态: ✅ 已在 
RecoveryCoordinator
 中实现，但接口定义缺失。

建议: 在 
IRecoveryCoordinator
 接口中添加 
get_consecutive_failures()
 抽象方法。

🟠 中等问题
4. [executor.py] 重复的 Tick Loop 逻辑
位置: 
executor.py:498-759

问题: TaskExecutor._execute_task_tick_loop() 和 GatherRunner.run() 存在大量重复代码。新增的 RecoveryCoordinator 只集成到了 GatherRunner，但 executor 的旧 Tick Loop 没有更新。

建议:

删除 
executor.py
 中的 
_execute_task_tick_loop()
 方法
确保所有采集任务都通过 RunnerRegistry 路由到 
GatherRunner
5. [action_resolver.py] 
_resolve_give
 可能返回 "unknown" 玩家名
位置: 
action_resolver.py:305

问题: 当 context.owner_name 为空时，使用 "unknown" 作为玩家名，这会导致 give 动作失败。

player_name = context.owner_name or "unknown"
建议: 应该在上游检测并阻止，或返回 clarify 请求玩家名。

6. [action_resolver.py:256-261] 无 owner_position 时的错误处理
位置: 
action_resolver.py:256-261

问题: 当用户说 "goto owner" 但没有 owner_position 时，返回坐标 "0,64,0" 并继续执行。这可能导致 Bot 跑到世界原点。

if target.lower() in ["owner", "主人", "player", "me"]:
    if context.owner_position:
        # ...
    else:
        return GroundedAction(
            action="goto",
            params={"target": "0,64,0"},  # 危险的默认值
            description="无法获取主人位置"
        )
建议: 应该返回失败或 clarify，而不是默默导航到世界原点。

7. [actor.py] 未处理的 JSON 解析异常可能导致默认 scan
位置: 
actor.py:158-166

问题: 当 LLM 返回无效 JSON 时，异常被捕获并返回默认的 
scan
 动作。这可能掩盖 LLM 配置问题。

except Exception as e:
    logger.error(f"Actor decide failed: {e}")
    return ActorDecision(
        action=ActorActionType.SCAN,
        target="block",
        params={"radius": 32},
        reasoning=f"决策失败，执行默认扫描: {str(e)}"
    )
建议: 区分网络错误和解析错误，对持续失败添加熔断逻辑。

🟡 轻微问题
8. [recovery_logger.py] 日志文件可能增长过大
问题: 
JsonRecoveryLogger
 只追加日志，没有轮转机制。

建议: 添加日志轮转或大小限制。

9. [behavior_rules.py] 硬编码的默认路径
位置: 
behavior_rules.py:30-31

问题: 默认路径使用相对路径 Path(__file__).parent.parent / "data" / "behavior_rules.json"，可能在某些运行环境下失败。

建议: 使用更健壮的路径解析或配置注入。

10. [bot/actions.py:312-314] 后台线程采集可能导致资源泄漏
位置: 
actions.py:312-314

问题: 使用 daemon 线程执行 collectBlock，但如果主循环退出，线程可能仍在 JS 侧运行。

collect_thread = threading.Thread(target=do_collect, daemon=True)
collect_thread.start()
建议: 添加显式的线程清理逻辑或使用 ThreadPoolExecutor。

💡 建议改进
11. 添加更多单元测试
涉及文件:

action_resolver.py
 - 缺少单独的单元测试文件
gather_runner.py
 - Recovery 集成测试
12. 统一错误码定义
问题: 错误码分散在多个文件中 (
actions.py
, 
recovery_coordinator.py
, 
gather_runner.py
)。

建议: 创建 error_codes.py 集中管理所有错误码常量。

13. 添加 Metrics/Telemetry
问题: 缺少关键指标采集（如 LLM 调用次数、任务成功率、恢复触发次数）。

建议: 添加 Prometheus metrics 或结构化日志用于监控。

优先修复顺序
🔴 #2 - main.py 缺少 RecoveryCoordinator 注入（功能完全失效）
🔴 #3 - 接口定义缺失
🟠 #4 - 删除重复的 Tick Loop 代码
🟠 #6 - goto owner 的危险默认值
其他按优先级逐步修复
审查完成时间: 2026-01-04 01:35