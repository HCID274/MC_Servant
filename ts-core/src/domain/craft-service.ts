import type {
  CraftCapabilityParams,
  ToolchainCapabilityData,
  ToolchainCapabilityResult,
  ToolchainFailureCode,
} from "../core-ports/skills.js";

/** Phase 1（第一阶段） CraftService（合成服务） 允许的目标清单；只限制目标范围，不承载配方事实。 */
export const CRAFT_SERVICE_ALLOWED_TARGETS = Object.freeze([
  "planks",
  "stick",
  "sticks",
  "crafting_table",
  "wooden_pickaxe",
  "stone_pickaxe",
] as const);

export type CraftServiceAllowedTarget = (typeof CRAFT_SERVICE_ALLOWED_TARGETS)[number];

export type CraftServiceResult = ToolchainCapabilityResult<ToolchainCapabilityData>;

/** CraftService（合成服务） 依赖的 runtime（运行时） 执行端口。 */
export interface CraftServiceRuntimePort {
  /** 执行真实合成；配方、材料、工作台事实由 runtime（运行时）/Mineflayer 校验。 */
  craft(params: Readonly<CraftCapabilityParams>): Promise<CraftServiceResult>;
}

/** CraftService（合成服务） 最小接口。 */
export interface CraftService {
  /** 合成 allowlist（白名单） 内目标。 */
  craft(params: Readonly<CraftCapabilityParams>): Promise<CraftServiceResult>;
}

/** 创建 Phase 1（第一阶段） 最小 CraftService（合成服务）。 */
export function createCraftService(input: {
  readonly runtime: CraftServiceRuntimePort;
}): CraftService {
  return Object.freeze({
    async craft(params: Readonly<CraftCapabilityParams>): Promise<CraftServiceResult> {
      const normalized = normalizeCraftServiceTarget(params.itemName);

      if (!Number.isInteger(params.count) || params.count <= 0) {
        return createCraftServiceFailure({
          code: "unsupported_capability",
          message: "craft count must be a positive integer",
          worldKey: null,
          details: { item_name: params.itemName, count: params.count },
        });
      }

      if (!isCraftServiceAllowedTarget(normalized)) {
        return createCraftServiceFailure({
          code: "unsupported_capability",
          message: `craft target is not enabled in Phase 1: ${params.itemName}`,
          worldKey: null,
          details: { item_name: params.itemName },
        });
      }

      return input.runtime.craft({
        itemName: normalizeCraftServiceAlias(normalized),
        count: params.count,
      });
    },
  });
}

function isCraftServiceAllowedTarget(value: string): value is CraftServiceAllowedTarget {
  return (CRAFT_SERVICE_ALLOWED_TARGETS as readonly string[]).includes(value);
}

function normalizeCraftServiceTarget(value: string): string {
  return value.trim().toLowerCase().replaceAll(" ", "_").replaceAll("-", "_");
}

function normalizeCraftServiceAlias(value: CraftServiceAllowedTarget): string {
  return value === "sticks" ? "stick" : value;
}

function createCraftServiceFailure(input: {
  readonly code: ToolchainFailureCode;
  readonly message: string;
  readonly worldKey: string | null;
  readonly details?: Readonly<Record<string, unknown>>;
}): CraftServiceResult {
  return Object.freeze({
    ok: false as const,
    error: Object.freeze({
      code: input.code,
      message: input.message,
      world_key: input.worldKey,
      ...(input.details === undefined ? {} : { details: Object.freeze({ ...input.details }) }),
    }),
  });
}
