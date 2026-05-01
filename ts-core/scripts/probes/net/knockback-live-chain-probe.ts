import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { attachMineflayerEntityVelocityCompatibility } from "../../../src/runtime/transport/velocity-compat.js";
import {
  type ProbePoint,
  type ProbeSignal,
  clonePoint,
  createProbeBot,
  createSignal,
  fail,
  formatPacketKeys,
  formatPoint,
  formatWorld,
  getBotEntityId,
  getEventSource,
  getPacketSource,
  getPosition,
  getVelocity,
  horizontalDistance,
  horizontalSpeed,
  markSignal,
  prepareBot,
  readBaseConfig,
  readPacketEntityId,
  readPacketPosition,
  readPacketStatus,
  readPacketVelocity,
} from "./knockback-probe-common.js";

const config = readBaseConfig(process.argv.slice(2), process.env);
const bot = createProbeBot(config);

const signals = {
  hurt: createSignal("entityHurt（实体受击）"),
  healthChanged: createSignal("health changed（生命值变化）"),
  velocityPacket: createSignal("entity_velocity packet（实体速度数据包）"),
  targetVelocityPacket: createSignal("target entity_velocity packet（目标实体速度数据包）"),
  velocityChanged: createSignal("velocity write（速度写入）"),
  positionMoved: createSignal("position movement（位置推进）"),
  serverCorrection: createSignal("server correction（服务端位置修正）"),
};

const samples: ProbeSample[] = [];
const disposers: Array<() => void> = [];
let serverCorrectionLogs = 0;

try {
  printScope();
  await prepareBot(bot, config);
  disposers.push(
    attachMineflayerEntityVelocityCompatibility(
      bot as unknown as Parameters<typeof attachMineflayerEntityVelocityCompatibility>[0],
    ),
  );
  installLiveChainLogging();

  const startedAt = Date.now();
  const startPosition = getPosition(bot);
  const startVelocity = getVelocity(bot);
  console.log(
    `[probe] ready for attack（等待攻击） ${formatWorld(bot, config)} bot_entity_id=${String(getBotEntityId(bot) ?? "unknown")} pos=${formatPoint(startPosition)} vel=${formatPoint(startVelocity)}`,
  );
  console.log("[probe] 请让玩家或怪物攻击 bot（机器人）；脚本会持续记录因果链。");

  while (Date.now() - startedAt < config.durationMs) {
    recordSample(startedAt);
    await delay(100);
  }

  const endPosition = getPosition(bot);
  const maxHorizontalSpeed = samples.reduce(
    (max, sample) => Math.max(max, horizontalSpeed(sample.velocity)),
    0,
  );
  const movedDistance = horizontalDistance(startPosition, endPosition);
  if (movedDistance > 0.05) {
    markSignal(signals.positionMoved);
  }

  printSummary(startPosition, endPosition, maxHorizontalSpeed, movedDistance);
  process.exitCode = 0;
} catch (error) {
  fail(error);
} finally {
  for (const dispose of disposers) {
    dispose();
  }
  if (typeof bot.quit === "function") {
    bot.quit("knockback live chain probe finished");
  } else {
    bot.end("knockback live chain probe finished");
  }
}

interface ProbeSample {
  readonly elapsedMs: number;
  readonly position?: ProbePoint;
  readonly velocity?: ProbePoint;
}

function printScope(): void {
  console.log("[probe] 我在排除哪一环: A 伤害判定 -> H 服务端确认的完整 live chain（实服链路）。");
  console.log(
    "[probe] PASS（通过）/FAIL（失败） 必须结合 world_label（世界标签） 与 dimension（维度） 分组。",
  );
}

function installLiveChainLogging(): void {
  const eventSource = getEventSource(bot);
  const packetSource = getPacketSource(bot);

  onBot(eventSource, "entityHurt", (...args) => {
    const first = args[0] as
      | { readonly id?: number | string; readonly username?: string; readonly name?: string }
      | undefined;
    markSignal(signals.hurt);
    console.log(
      `[probe] event entityHurt（实体受击） ${formatWorld(bot, config)} entity_id=${String(first?.id ?? "unknown")} name=${first?.username ?? first?.name ?? "unknown"} bot_entity_id=${String(getBotEntityId(bot) ?? "unknown")}`,
    );
  });

  onBot(eventSource, "health", () => {
    markSignal(signals.healthChanged);
    console.log(
      `[probe] event health（生命值） ${formatWorld(bot, config)} health=${String(readBotHealth())} food=${String(readBotFood())} pos=${formatPoint(getPosition(bot))} vel=${formatPoint(getVelocity(bot))}`,
    );
  });

  onBot(eventSource, "physicsTick", () => {
    const previous = samples.at(-1);
    const currentPosition = getPosition(bot);
    const currentVelocity = getVelocity(bot);
    if (horizontalSpeed(currentVelocity) > 0.02) {
      markSignal(signals.velocityChanged);
    }
    if (horizontalDistance(previous?.position, currentPosition) > 0.01) {
      markSignal(signals.positionMoved);
    }
  });

  onBot(eventSource, "forcedMove", () => {
    markSignal(signals.serverCorrection);
    logServerCorrection(
      `[probe] event forcedMove（强制移动） ${formatWorld(bot, config)} pos=${formatPoint(getPosition(bot))} vel=${formatPoint(getVelocity(bot))}`,
    );
  });

  if (packetSource === undefined) {
    console.log("[probe] raw packet（原始数据包） probe unavailable: no bot._client");
    return;
  }

  onPacket(packetSource, "entity_velocity", (packet) => {
    markSignal(signals.velocityPacket);
    const packetEntityId = readPacketEntityId(packet);
    const velocity = readPacketVelocity(packet);
    const matchesBot = packetEntityId !== undefined && packetEntityId === getBotEntityId(bot);
    if (matchesBot) {
      markSignal(signals.targetVelocityPacket);
    }
    console.log(
      `[probe] packet entity_velocity（实体速度数据包） ${formatWorld(bot, config)} packet_entity_id=${String(packetEntityId ?? "unknown")} bot_entity_id=${String(getBotEntityId(bot) ?? "unknown")} matches_bot=${String(matchesBot)} packet_vel=${formatPoint(velocity)} bot_vel=${formatPoint(getVelocity(bot))} keys=${formatPacketKeys(packet)}`,
    );
  });

  for (const packetName of ["entity_status", "entity_metadata", "entity_teleport"]) {
    onPacket(packetSource, packetName, (packet) => {
      const packetEntityId = readPacketEntityId(packet);
      const matchesBot = packetEntityId !== undefined && packetEntityId === getBotEntityId(bot);
      if (!matchesBot) {
        return;
      }
      if (packetName === "entity_status" && readPacketStatus(packet) === 2) {
        markSignal(signals.hurt);
      }
      console.log(
        `[probe] packet ${packetName}（实体相关数据包） ${formatWorld(bot, config)} matches_bot=true status=${String(readPacketStatus(packet) ?? "unknown")} keys=${formatPacketKeys(packet)}`,
      );
    });
  }

  onPacket(packetSource, "position", (packet) => {
    markSignal(signals.serverCorrection);
    logServerCorrection(
      `[probe] packet position（位置修正数据包） ${formatWorld(bot, config)} packet_pos=${formatPoint(readPacketPosition(packet))} bot_pos=${formatPoint(getPosition(bot))}`,
    );
  });
}

function recordSample(startedAt: number): void {
  const sample = {
    elapsedMs: Date.now() - startedAt,
    position: clonePoint(getPosition(bot)),
    velocity: clonePoint(getVelocity(bot)),
  };
  samples.push(sample);
  if (sample.elapsedMs % 1000 < 100) {
    console.log(
      `[probe] sample（采样） t=${sample.elapsedMs}ms ${formatWorld(bot, config)} pos=${formatPoint(sample.position)} vel=${formatPoint(sample.velocity)}`,
    );
  }
}

function printSummary(
  startPosition: ProbePoint | undefined,
  endPosition: ProbePoint | undefined,
  maxHorizontalSpeed: number,
  movedDistance: number,
): void {
  console.log("[probe] summary（摘要）");
  console.log(
    `[probe] movement（位移） start=${formatPoint(startPosition)} end=${formatPoint(endPosition)} horizontal_distance=${movedDistance.toFixed(3)} max_horizontal_speed=${maxHorizontalSpeed.toFixed(3)}`,
  );
  for (const signal of Object.values(signals)) {
    console.log(
      `[probe] signal（信号） ${signal.name} count=${signal.count} last_at=${signal.lastAtMs ?? "none"}`,
    );
  }
  printPassFail(
    "A 伤害判定",
    signals.hurt.count > 0 || signals.healthChanged.count > 0,
    signals.hurt.count > 0 ? signals.hurt : signals.healthChanged,
  );
  printPassFail(
    "B/C/D/E 服务端击退发包到目标匹配",
    signals.targetVelocityPacket.count > 0,
    signals.targetVelocityPacket,
  );
  printPassFail(
    "F velocity（速度）写入",
    signals.velocityChanged.count > 0,
    signals.velocityChanged,
  );
  printPassFail("G physics tick（物理帧）推进", movedDistance > 0.05, signals.positionMoved);
  console.log(
    "[probe] H 服务端确认需人工结合 position（位置） packet（数据包） 与视频判断是否橡皮筋回滚。",
  );
}

function logServerCorrection(message: string): void {
  serverCorrectionLogs += 1;
  if (serverCorrectionLogs <= 3 || serverCorrectionLogs % 40 === 0) {
    console.log(message);
  }
}

function readBotHealth(): number | undefined {
  const withHealth = bot as unknown as { readonly health?: number };
  return withHealth.health;
}

function readBotFood(): number | undefined {
  const withFood = bot as unknown as { readonly food?: number };
  return withFood.food;
}

function printPassFail(label: string, passed: boolean, signal: ProbeSignal): void {
  console.log(
    `[probe] verdict（判定） ${label}: ${passed ? "PASS（通过）" : "FAIL（失败）"} evidence_count=${signal.count}`,
  );
}

function onBot(
  eventSource: ReturnType<typeof getEventSource>,
  eventName: string,
  listener: (...args: readonly unknown[]) => void,
): void {
  eventSource.on(eventName, listener);
  disposers.push(() => {
    eventSource.off?.(eventName, listener);
    eventSource.removeListener?.(eventName, listener);
  });
}

function onPacket(
  packetSource: NonNullable<ReturnType<typeof getPacketSource>>,
  packetName: string,
  listener: (packet: unknown) => void,
): void {
  packetSource.on(packetName, listener);
  disposers.push(() => {
    packetSource.off?.(packetName, listener);
    packetSource.removeListener?.(packetName, listener);
  });
}
