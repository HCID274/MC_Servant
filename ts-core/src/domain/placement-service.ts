import type {
  PlaceCapabilityParams,
  ToolchainCapabilityData,
  ToolchainCapabilityResult,
  ToolchainFailureCode,
} from "../core-ports/skills.js";

/** Phase 1（第一阶段） PlacementService（放置服务） 只允许工具链放置 crafting table（工作台）。 */
export const PLACEMENT_SERVICE_ALLOWED_BLOCKS = Object.freeze(["crafting_table"] as const);

export type PlacementServiceAllowedBlock = (typeof PLACEMENT_SERVICE_ALLOWED_BLOCKS)[number];

export type PlacementServiceResult = ToolchainCapabilityResult<ToolchainCapabilityData>;

/** PlacementService（放置服务） 依赖的 runtime（运行时） 执行端口。 */
export interface PlacementServiceRuntimePort {
  /** 执行真实放置；候选点、可点击性与世界事实由 runtime（运行时） 校验。 */
  place(params: Readonly<PlaceCapabilityParams>): Promise<PlacementServiceResult>;
}

/** PlacementService（放置服务） 最小接口。 */
export interface PlacementService {
  /** 放置 allowlist（白名单） 内方块。 */
  place(params: Readonly<PlaceCapabilityParams>): Promise<PlacementServiceResult>;
  /** 工具链快捷入口：确保 crafting table（工作台） 已放置。 */
  placeCraftingTable(): Promise<PlacementServiceResult>;
}

/** 创建 Phase 1（第一阶段） 最小 PlacementService（放置服务）。 */
export function createPlacementService(input: {
  readonly runtime: PlacementServiceRuntimePort;
}): PlacementService {
  return Object.freeze({
    async place(params: Readonly<PlaceCapabilityParams>): Promise<PlacementServiceResult> {
      const normalized = normalizePlacementServiceBlock(params.blockName);

      if (!isPlacementServiceAllowedBlock(normalized)) {
        return createPlacementServiceFailure({
          code: "unsupported_capability",
          message: `place target is not enabled in Phase 1: ${params.blockName}`,
          worldKey: null,
          details: { block_name: params.blockName },
        });
      }

      return input.runtime.place({
        blockName: normalized,
        ...(params.near === undefined ? {} : { near: params.near }),
      });
    },
    async placeCraftingTable(): Promise<PlacementServiceResult> {
      return input.runtime.place({ blockName: "crafting_table" });
    },
  });
}

function isPlacementServiceAllowedBlock(value: string): value is PlacementServiceAllowedBlock {
  return (PLACEMENT_SERVICE_ALLOWED_BLOCKS as readonly string[]).includes(value);
}

function normalizePlacementServiceBlock(value: string): string {
  return value.trim().toLowerCase().replaceAll(" ", "_").replaceAll("-", "_");
}

function createPlacementServiceFailure(input: {
  readonly code: ToolchainFailureCode;
  readonly message: string;
  readonly worldKey: string | null;
  readonly details?: Readonly<Record<string, unknown>>;
}): PlacementServiceResult {
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
