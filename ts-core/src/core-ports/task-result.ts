/**
 * 任务终态结果摘要契约。
 *
 * 该契约只描述 BotWorker（机器人工作线程） 已完成的事实，供 realtime（实时推送）、
 * game chat（游戏聊天） 与 task history（任务历史） 共享，不承载执行决策。
 */

import { assertNonEmptyString } from "../domain/invariants.js";
import type { ExecutionTaskKind } from "./foundation.js";

/** 任务终态中可展示的关键背包增量。 */
export interface TaskResultInventoryDelta {
  /** 物品标准名称。 */
  readonly item_name: string;
  /** 背包增长数量。 */
  readonly count: number;
}

/** 任务终态的最小结构化摘要。 */
export interface TaskResultSummary {
  /** 执行任务类型。 */
  readonly task_type: ExecutionTaskKind;
  /** 技能名、sandbox（沙箱）能力名或 sandbox_code（沙箱代码）。 */
  readonly operation: string;
  /** 关键目标物品 / 方块 / 坐标摘要。 */
  readonly target?: string;
  /** 用户或代码请求数量。 */
  readonly requested_count?: number;
  /** 已确认完成数量。 */
  readonly completed_count?: number;
  /** 关键背包增量。 */
  readonly inventory_delta?: readonly TaskResultInventoryDelta[];
  /** 当前世界键；必须由既有 world_key（世界键） 接口上游透传。 */
  readonly world_key?: string | null;
  /** 执行补充诊断。 */
  readonly details?: Readonly<Record<string, unknown>>;
}

/** 创建冻结的任务结果摘要。 */
export function createTaskResultSummary(input: TaskResultSummary): TaskResultSummary {
  assertNonEmptyString(input.operation, "operation");

  return Object.freeze({
    task_type: input.task_type,
    operation: input.operation,
    ...(input.target === undefined ? {} : { target: input.target }),
    ...(input.requested_count === undefined ? {} : { requested_count: input.requested_count }),
    ...(input.completed_count === undefined ? {} : { completed_count: input.completed_count }),
    ...(input.inventory_delta === undefined
      ? {}
      : {
          inventory_delta: Object.freeze(
            input.inventory_delta.map((delta) =>
              Object.freeze({
                item_name: delta.item_name,
                count: delta.count,
              }),
            ),
          ),
        }),
    ...(input.world_key === undefined ? {} : { world_key: input.world_key }),
    ...(input.details === undefined ? {} : { details: Object.freeze({ ...input.details }) }),
  });
}
