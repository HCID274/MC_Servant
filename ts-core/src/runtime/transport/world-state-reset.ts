import { readMineflayerWorldKey } from "./naming.js";
import type { MineflayerBotHandle, MineflayerEntityHandle } from "./types.js";

interface RespawnWorldPacket {
  readonly dimension?: string;
  readonly worldName?: string;
  readonly worldState?: {
    readonly dimension?: string;
    readonly name?: string;
  };
}

interface MutableMineflayerBotState {
  entities?: Record<string, MineflayerEntityHandle | undefined>;
  players?: Record<string, { entity?: MineflayerEntityHandle | null } | undefined>;
  clearControlStates?(): void;
  readonly entity?: MineflayerEntityHandle;
  readonly username?: string;
}

/** 在世界切换后清理 Mineflayer（Minecraft 协议客户端） 未自动隔离的移动与实体状态。 */
export function attachMineflayerWorldStateReset(bot: MineflayerBotHandle): () => void {
  const client = bot._client;
  if (client === undefined || typeof client.on !== "function") {
    return () => undefined;
  }

  let currentWorldKey = readCurrentWorldKey(bot);
  const onLogin = (packet: unknown): void => {
    currentWorldKey = readPacketWorldKey(packet) ?? readCurrentWorldKey(bot);
  };
  const onRespawn = (packet: unknown): void => {
    const nextWorldKey = readPacketWorldKey(packet);
    if (nextWorldKey === undefined || isSameWorldKey(nextWorldKey, currentWorldKey)) {
      return;
    }

    currentWorldKey = nextWorldKey;
    queueMicrotask(() => {
      resetMineflayerWorldState(bot);
    });
  };

  client.on("login", onLogin);
  client.on("respawn", onRespawn);

  return () => {
    client.off?.("login", onLogin);
    client.off?.("respawn", onRespawn);
    client.removeListener?.("login", onLogin);
    client.removeListener?.("respawn", onRespawn);
  };
}

function resetMineflayerWorldState(bot: MineflayerBotHandle): void {
  stopMineflayerActiveControl(bot);
  const mutableBot = bot as MutableMineflayerBotState;
  resetPlayerEntityLinks(mutableBot.players);
  resetEntityIndex(mutableBot);
}

/** 停止 Mineflayer（Minecraft 协议客户端） 当前移动/控制状态，用于 cancel（取消） 与世界切换清理。 */
export function stopMineflayerActiveControl(bot: MineflayerBotHandle): void {
  bot.pathfinder?.setGoal?.(null);
  bot.pathfinder?.stop?.();

  const mutableBot = bot as MutableMineflayerBotState;
  mutableBot.clearControlStates?.();
}

function resetPlayerEntityLinks(players: MutableMineflayerBotState["players"] | undefined): void {
  if (players === undefined) {
    return;
  }

  for (const player of Object.values(players)) {
    if (player !== undefined) {
      player.entity = null;
    }
  }
}

function resetEntityIndex(bot: MutableMineflayerBotState): void {
  const self = bot.entity;
  if (self === undefined) {
    bot.entities = {};
    return;
  }

  bot.entities = {
    [String(self.id ?? bot.username ?? "self")]: self,
  };
}

function readPacketWorldKey(packet: unknown): string | undefined {
  const record = packet as RespawnWorldPacket;
  return (
    record.worldState?.name ?? record.worldName ?? record.worldState?.dimension ?? record.dimension
  );
}

function readCurrentWorldKey(bot: MineflayerBotHandle): string {
  return readMineflayerWorldKey(bot);
}

function isSameWorldKey(left: string, right: string): boolean {
  return left === right || stripMinecraftNamespace(left) === stripMinecraftNamespace(right);
}

function stripMinecraftNamespace(value: string): string {
  return value.startsWith("minecraft:") ? value.slice("minecraft:".length) : value;
}
