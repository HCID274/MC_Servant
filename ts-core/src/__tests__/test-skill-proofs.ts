import {
  type CollectSkillParams,
  type MineSkillParams,
  createCollectSkillExecutionResult,
  createMineSkillExecutionResult,
} from "../skills/index.js";

/**
 * 测试专用 mine 成功 proof 工厂。
 *
 * 调用方必须显式传入真实完成字段；这里不根据 blockName 猜掉落物，
 * 避免测试重新制造“缺 proof 也能成功”的宽松路径。
 */
export function createTestOnlyProvenMineResult(
  params: Readonly<MineSkillParams>,
  proof: {
    readonly collectedItemName: string;
    readonly collectedCount: number;
    readonly minedCount: number;
    readonly worldKey?: string | null;
    readonly diagnostics?: readonly string[];
    readonly totalSteps?: number;
  },
) {
  return createMineSkillExecutionResult(params, {
    world_key: proof.worldKey,
    collected_item_name: proof.collectedItemName,
    collected_count: proof.collectedCount,
    mined_count: proof.minedCount,
    diagnostics: proof.diagnostics,
    total_steps: proof.totalSteps,
  });
}

/** 测试专用 collect proof 工厂；collected 数组必须由调用方显式提供。 */
export function createTestOnlyProvenCollectResult(
  params: Readonly<CollectSkillParams>,
  proof: {
    readonly collected: readonly { readonly name: string; readonly count: number }[];
    readonly worldKey?: string | null;
    readonly totalSteps?: number;
    readonly diagnostics?: readonly string[];
  },
) {
  return createCollectSkillExecutionResult(params, {
    world_key: proof.worldKey,
    collected: proof.collected,
    total_steps: proof.totalSteps,
    diagnostics: proof.diagnostics,
  });
}
