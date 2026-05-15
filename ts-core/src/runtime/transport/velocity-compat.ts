import type { MineflayerBotHandle, MineflayerEntityHandle, MineflayerVec3Like } from "./types.js";

const FROM_NOTCH_VELOCITY = 1 / 8000;

interface EntityVelocityPacket {
  readonly entityId?: number | string;
  readonly velocity?: {
    readonly x?: number;
    readonly y?: number;
    readonly z?: number;
  };
}

interface WritableVec3 {
  x: number;
  y: number;
  z: number;
  update?(value: MineflayerVec3Like): void;
  set?(x: number, y: number, z: number): void;
}

/**
 * 修正 Mineflayer（Minecraft 协议客户端） 对 1.20.3+ `entity_velocity`（实体速度） 包的兼容缺口。
 *
 * minecraft-data（协议数据） 已把该包解成 `velocity: vec3i16`，但当前 Mineflayer
 * feature（特性）表可能仍走旧字段 `velocityX/Y/Z`，导致实体速度被写成 NaN。这里在适配层
 * 监听同一 packet（数据包），只在新结构存在时把速度重新写回目标实体，不修改 Mineflayer 本体。
 */
export function attachMineflayerEntityVelocityCompatibility(bot: MineflayerBotHandle): () => void {
  const client = bot._client;
  if (client === undefined) {
    return () => undefined;
  }

  const onEntityVelocity = (packet: unknown): void => {
    const parsed = readEntityVelocityPacket(packet);
    if (parsed === null) {
      return;
    }

    const target = findEntityById(bot, parsed.entityId);
    if (target === undefined) {
      return;
    }

    writeEntityVelocity(target, parsed.velocity);
  };

  client.on("entity_velocity", onEntityVelocity);

  return () => {
    client.off?.("entity_velocity", onEntityVelocity);
    client.removeListener?.("entity_velocity", onEntityVelocity);
  };
}

/** 解析实体速度数据包，提取实体 ID 和速度分量（Notchian 单位转换为方块/秒）。 */
function readEntityVelocityPacket(
  packet: unknown,
): { readonly entityId: number | string; readonly velocity: MineflayerVec3Like } | null {
  if (typeof packet !== "object" || packet === null) {
    return null;
  }

  const record = packet as EntityVelocityPacket;
  if (record.entityId === undefined || record.velocity === undefined) {
    return null;
  }

  const { x, y, z } = record.velocity;
  if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(z)) {
    return null;
  }

  return {
    entityId: record.entityId,
    velocity: {
      x: x * FROM_NOTCH_VELOCITY,
      y: y * FROM_NOTCH_VELOCITY,
      z: z * FROM_NOTCH_VELOCITY,
    },
  };
}

/** 按实体 ID 查找实体对象（先检查 Bot 自身，再检查实体字典）。 */
function findEntityById(
  bot: MineflayerBotHandle,
  entityId: number | string,
): MineflayerEntityHandle | undefined {
  if (bot.entity?.id === entityId) {
    return bot.entity;
  }

  const key = String(entityId);
  return bot.entities?.[key];
}

/** 将速度写入实体对象（优先使用 update/set 方法，否则直接赋值）。 */
function writeEntityVelocity(entity: MineflayerEntityHandle, velocity: MineflayerVec3Like): void {
  const writableVelocity = entity.velocity as WritableVec3 | undefined;
  if (writableVelocity === undefined) {
    return;
  }

  if (typeof writableVelocity.update === "function") {
    writableVelocity.update(velocity);
    return;
  }

  if (typeof writableVelocity.set === "function") {
    writableVelocity.set(velocity.x, velocity.y, velocity.z);
    return;
  }

  writableVelocity.x = velocity.x;
  writableVelocity.y = velocity.y;
  writableVelocity.z = velocity.z;
}

/** 判断值是否为有限数字（排除 NaN 和 Infinity）。 */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
