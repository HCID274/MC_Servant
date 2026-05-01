import process from "node:process";
import {
  appendEvidence,
  collectCommandFeedback,
  createBaseEvidence,
  createEvidencePath,
  findNearestPlayer,
  formatEvidenceSummary,
  formatPositionForLog,
} from "./fact-scan-common.js";
import {
  createProbeBot,
  fail,
  formatWorld,
  getPosition,
  prepareBot,
  readBaseConfig,
} from "./knockback-probe-common.js";

const probeId = "P1-1-world-context-consistency";
const config = readBaseConfig(process.argv.slice(2), process.env);
const bot = createProbeBot(config);
const rawLogPath = createEvidencePath(probeId);

try {
  console.log("[probe] 我在排除哪一环: P1 多世界/维度/坐标标签错配。");
  await prepareBot(bot, config);

  const player = findNearestPlayer(bot);
  const botPosition = getPosition(bot);
  const serverBotPositionMessages = await collectCommandFeedback({
    bot,
    command: `/data get entity ${bot.username} Pos`,
  });
  const serverPlayerPositionMessages =
    player === undefined
      ? []
      : await collectCommandFeedback({
          bot,
          command: `/data get entity ${player.name} Pos`,
        });
  const serverBotDimensionMessages = await collectCommandFeedback({
    bot,
    command: `/data get entity ${bot.username} Dimension`,
  });
  const serverPlayerDimensionMessages =
    player === undefined
      ? []
      : await collectCommandFeedback({
          bot,
          command: `/data get entity ${player.name} Dimension`,
        });

  const serverTruthAvailable =
    hasCommandResponse(serverBotPositionMessages) &&
    (player === undefined || hasCommandResponse(serverPlayerPositionMessages));
  const playerNear =
    player?.position !== undefined && botPosition !== undefined
      ? distance(botPosition, player.position) <= 8
      : false;
  const verdict = serverTruthAvailable && playerNear ? "PASS" : "FAIL";

  appendEvidence(
    rawLogPath,
    createBaseEvidence({
      axis: "P1",
      probeId,
      config,
      bot,
      rawLogPath,
      verdict,
      playerPosition: player?.position ?? (player === undefined ? "none" : "unknown"),
      targetPosition: player?.position ?? "none",
      evidence: {
        mineflayer_world: formatWorld(bot, config),
        bot_position: botPosition ?? "unknown",
        nearest_player: player ?? "none",
        player_distance:
          player?.position === undefined ? "unavailable" : distance(botPosition, player.position),
        server_truth_available: serverTruthAvailable,
        server_bot_position_messages: serverBotPositionMessages,
        server_player_position_messages: serverPlayerPositionMessages,
        server_bot_dimension_messages: serverBotDimensionMessages,
        server_player_dimension_messages: serverPlayerDimensionMessages,
        pass_condition:
          "server position command available and nearest player is within 8 blocks in same world-label group",
      },
    }),
  );

  formatEvidenceSummary({
    axis: "P1",
    verdict,
    worldLabel: config.worldLabel,
    details: `bot=${formatPositionForLog(botPosition)} player=${formatPositionForLog(player?.position)} server_truth=${String(serverTruthAvailable)} player_near=${String(playerNear)} raw=${rawLogPath}`,
  });
  process.exitCode = verdict === "PASS" ? 0 : 2;
} catch (error) {
  fail(error);
} finally {
  bot.quit("T-NET-002 P1 probe finished");
}

function hasCommandResponse(messages: readonly string[]): boolean {
  return messages.some((message) =>
    /entity data|has the following entity data|Pos|Dimension/i.test(message),
  );
}

function distance(
  left: { readonly x: number; readonly y: number; readonly z: number } | undefined,
  right: {
    readonly x: number;
    readonly y: number;
    readonly z: number;
  },
): number {
  if (left === undefined) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.sqrt((left.x - right.x) ** 2 + (left.y - right.y) ** 2 + (left.z - right.z) ** 2);
}
