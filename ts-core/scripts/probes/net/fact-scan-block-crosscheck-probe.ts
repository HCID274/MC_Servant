import { createRequire } from "node:module";
import process from "node:process";
import {
  attachMineflayerBlockWorldCompatibility,
  parseWorldDimensionMap,
} from "../../../src/runtime/transport/block-world-compat.js";
import { attachMineflayerDimensionBoundsSync } from "../../../src/runtime/transport/runtime.js";
import type { MineflayerBotHandle } from "../../../src/runtime/transport/types.js";
import {
  appendEvidence,
  collectCommandFeedback,
  createBaseEvidence,
  createEvidencePath,
  findNearestPlayer,
  floorPoint,
  formatEvidenceSummary,
  parsePointText,
  readDimension,
} from "./fact-scan-common.js";
import {
  createProbeBot,
  fail,
  getPosition,
  prepareBot,
  readBaseConfig,
  readFlags,
  readOptionalStringFlag,
} from "./knockback-probe-common.js";

const require = createRequire(import.meta.url);
const vec3Module = require("vec3") as {
  Vec3: new (
    x: number,
    y: number,
    z: number,
  ) => { readonly x: number; readonly y: number; readonly z: number };
};
const { Vec3 } = vec3Module;

const probeId = "P3-1-block-state-crosscheck";
const flags = readFlags(process.argv.slice(2));
const config = readBaseConfig(process.argv.slice(2), process.env);
const bot = createProbeBot(config);
const adapterFixEnabled =
  readOptionalStringFlag(flags, process.env, "adapter-fix", "TNET003_ADAPTER_FIX") === "true";
const removeAdapterFix = adapterFixEnabled
  ? attachMineflayerBlockWorldCompatibility(bot as unknown as MineflayerBotHandle, {
      worldDimensionMap: parseWorldDimensionMap(process.env.MC_WORLD_DIMENSION_MAP),
    })
  : undefined;
const removeDimensionBoundsFix = adapterFixEnabled
  ? attachMineflayerDimensionBoundsSync(bot as unknown as MineflayerBotHandle)
  : undefined;
const rawLogPath = createEvidencePath(probeId);

try {
  console.log("[probe] 我在排除哪一环: P3 Mineflayer blockAt（方块查询） 与服务端真值不一致。");
  await prepareBot(bot, config);
  const botPosition = getPosition(bot);
  if (botPosition === undefined) {
    throw new Error("bot position unavailable");
  }

  const nearBlock =
    parsePointText(readOptionalStringFlag(flags, process.env, "block", "TNET002_BLOCK")) ??
    floorPoint({ x: botPosition.x, y: botPosition.y - 1, z: botPosition.z });
  const edgeBlock =
    parsePointText(
      readOptionalStringFlag(flags, process.env, "edge-block", "TNET002_EDGE_BLOCK"),
    ) ?? floorPoint({ x: botPosition.x + 8, y: botPosition.y - 1, z: botPosition.z });

  const commandControl = await sampleCommandControl();
  const near = await sampleBlock("near-vanilla", nearBlock);
  const edge = await sampleBlock("edge-case", edgeBlock);
  const serverAvailable = commandControl.available && commandControl.dimension_available;
  const nearPass = near.server_match === true;
  const edgePass = edge.server_match === true || edge.unloaded === true;
  const verdict = serverAvailable && nearPass && edgePass ? "PASS" : "FAIL";

  appendEvidence(
    rawLogPath,
    createBaseEvidence({
      axis: "P3",
      probeId,
      config,
      bot,
      rawLogPath,
      verdict,
      playerPosition: findNearestPlayer(bot)?.position ?? "none",
      targetPosition: "none",
      evidence: {
        command_control: commandControl,
        near,
        edge,
        server_truth_available: serverAvailable,
        pass_condition:
          "near block name matches server command and edge block either matches or is explicitly unloaded",
      },
    }),
  );

  formatEvidenceSummary({
    axis: "P3",
    verdict,
    worldLabel: config.worldLabel,
    details: `near_match=${String(near.server_match)} edge_match=${String(edge.server_match)} server_available=${String(serverAvailable)} raw=${rawLogPath}`,
  });
  process.exitCode = verdict === "PASS" ? 0 : 2;
} catch (error) {
  fail(error);
} finally {
  removeAdapterFix?.();
  removeDimensionBoundsFix?.();
  bot.quit("T-NET-002 P3 probe finished");
}

async function sampleBlock(
  sampleKind: "near-vanilla" | "edge-case",
  point: {
    readonly x: number;
    readonly y: number;
    readonly z: number;
  },
): Promise<Readonly<Record<string, unknown>>> {
  const position = new Vec3(point.x, point.y, point.z) as Parameters<typeof bot.blockAt>[0];
  const block = bot.blockAt(position);
  const blockName = block?.name === undefined ? "unknown" : `minecraft:${block.name}`;
  const marker = `TNET002_P3_${sampleKind}_MATCH_${Date.now()}`;
  const loadedMarker = `TNET002_P3_${sampleKind}_LOADED_${Date.now()}`;
  const loadedMessages = await collectCommandFeedback({
    bot,
    command: `/execute in ${readDimension(bot)} if loaded ${point.x} ${point.y} ${point.z} run tellraw @s {"text":"${loadedMarker}"}`,
  });
  const dataMessages = await collectCommandFeedback({
    bot,
    command: `/execute in ${readDimension(bot)} run data get block ${point.x} ${point.y} ${point.z}`,
  });
  const messages =
    block?.name === undefined
      ? []
      : await collectCommandFeedback({
          bot,
          command: `/execute in ${readDimension(bot)} if block ${point.x} ${point.y} ${point.z} ${blockName} run tellraw @s {"text":"${marker}"}`,
        });
  const chunkLoaded = loadedMessages.some((message) => message.includes(loadedMarker));
  const serverMatch = messages.some((message) => message.includes(marker));
  return {
    sample_kind: sampleKind,
    block_position: point,
    mineflayer_block: block === null ? "null" : (block ?? "undefined"),
    expected_server_block_name: blockName,
    loaded_messages: loadedMessages,
    data_messages: dataMessages,
    server_messages: messages,
    server_match: serverMatch,
    unloaded: !chunkLoaded,
  };
}

async function sampleCommandControl(): Promise<
  Readonly<Record<string, unknown>> & {
    readonly available: boolean;
    readonly dimension_available: boolean;
  }
> {
  const marker = `TNET002_P3_CONTROL_${Date.now()}`;
  const messages = await collectCommandFeedback({
    bot,
    command: `/tellraw @s {"text":"${marker}"}`,
  });
  const dimensionMarker = `TNET002_P3_DIMENSION_CONTROL_${Date.now()}`;
  const dimensionMessages = await collectCommandFeedback({
    bot,
    command: `/execute in ${readDimension(bot)} run tellraw @s {"text":"${dimensionMarker}"}`,
  });
  return {
    marker,
    messages,
    dimension: readDimension(bot),
    dimension_marker: dimensionMarker,
    dimension_messages: dimensionMessages,
    available: messages.some((message) => message.includes(marker)),
    dimension_available: dimensionMessages.some((message) => message.includes(dimensionMarker)),
  };
}
