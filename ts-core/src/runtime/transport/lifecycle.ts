import { assertNonEmptyString } from "../../domain/invariants.js";
import type {
  MineflayerBotHandle,
  MineflayerCreateBotOptions,
  MineflayerEventSource,
  MineflayerTransportDescriptor,
} from "./types.js";

/** 创建 Mineflayer 运行时传输描述。 */
export function createMineflayerTransportDescriptor<TBotId extends string>(input: {
  botId: TBotId;
  username?: string;
  host?: string;
  port?: number;
  version?: string | null;
  auth?: string | null;
  worldDimensionMap?: Readonly<Record<string, string>>;
}): MineflayerTransportDescriptor<TBotId> {
  assertNonEmptyString(input.botId, "botId");

  const username = input.username?.trim() || input.botId;
  const host = input.host?.trim() || "localhost";
  const port = input.port ?? 25565;

  assertNonEmptyString(username, "username");
  assertNonEmptyString(host, "host");

  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error("mineflayer port must be an integer between 1 and 65535");
  }

  return Object.freeze({
    bot_id: input.botId,
    username,
    host,
    port,
    version: input.version ?? null,
    auth: input.auth ?? null,
    world_dimension_map: Object.freeze({ ...(input.worldDimensionMap ?? {}) }),
  });
}

/** 创建真实 Mineflayer Bot 实例。 */
export async function createDefaultMineflayerBot(
  options: MineflayerCreateBotOptions,
): Promise<MineflayerBotHandle> {
  const mineflayer = (await import("mineflayer")) as {
    createBot(input: MineflayerCreateBotOptions): MineflayerBotHandle;
  };

  return mineflayer.createBot(options);
}

/** 创建只读的 Mineflayer 事件源。 */
export function createReadonlyMineflayerEventSource(
  bot: MineflayerBotHandle,
): MineflayerEventSource {
  return Object.freeze({
    on(eventName: string, listener: (...args: readonly unknown[]) => void): unknown {
      return bot.on(eventName, listener);
    },
    once(eventName: string, listener: (...args: readonly unknown[]) => void): unknown {
      return bot.once?.(eventName, listener);
    },
    off(eventName: string, listener: (...args: readonly unknown[]) => void): unknown {
      return bot.off?.(eventName, listener);
    },
    removeListener(eventName: string, listener: (...args: readonly unknown[]) => void): unknown {
      return bot.removeListener?.(eventName, listener);
    },
  });
}

/** 创建 Mineflayer 驱动所需的选项对象。 */
export function createMineflayerCreateBotOptions(
  descriptor: MineflayerTransportDescriptor,
): MineflayerCreateBotOptions {
  return {
    username: descriptor.username,
    host: descriptor.host,
    port: descriptor.port,
    ...(descriptor.version === null ? {} : { version: descriptor.version }),
    ...(descriptor.auth === null ? {} : { auth: descriptor.auth }),
  };
}

/** 绑定运行时状态监听器。 */
export function attachRuntimeStateListeners(
  bot: MineflayerBotHandle,
  handlers: {
    markSpawned(): void;
    markDisconnected(): void;
    markFailed(error: unknown): void;
  },
): () => void {
  const onSpawn = () => handlers.markSpawned();
  const onEnd = () => handlers.markDisconnected();
  const onKicked = (reason: unknown) => handlers.markFailed(reason);
  const onError = (error: unknown) => handlers.markFailed(error);
  const removeSpawn = addEventListener(bot, "spawn", onSpawn);
  const removeEnd = addEventListener(bot, "end", onEnd);
  const removeKicked = addEventListener(bot, "kicked", onKicked);
  const removeError = addEventListener(bot, "error", onError);

  return () => {
    removeSpawn();
    removeEnd();
    removeKicked();
    removeError();
  };
}

/** 等待 Mineflayer 登录或生成。 */
export function waitForMineflayerSpawn(bot: MineflayerBotHandle, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const removeListeners: Array<() => void> = [];
    const timeout = setTimeout(() => {
      settle(() =>
        reject(new Error("Mineflayer transport connect timed out before login or spawn")),
      );
    }, timeoutMs);

    const settle = (finish: () => void) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      for (const removeListener of removeListeners) {
        removeListener();
      }
      finish();
    };

    removeListeners.push(
      // EasyAuth（离线服认证模组） 可能在 spawn（生成） 前先要求聊天注册/登录；login（协议登录） 只代表聊天可写，不代表世界交互 ready（就绪）。
      addOnceListener(bot, "login", () => settle(resolve)),
      addOnceListener(bot, "spawn", () => settle(resolve)),
      addOnceListener(bot, "end", () =>
        settle(() => reject(new Error("Mineflayer transport ended before login or spawn"))),
      ),
      addOnceListener(bot, "kicked", (reason) =>
        settle(() =>
          reject(new Error(`Mineflayer transport kicked before login or spawn: ${String(reason)}`)),
        ),
      ),
      addOnceListener(bot, "error", (error) => settle(() => reject(error))),
    );
  });
}

/** 将 Mineflayer 错误转换为字符串。 */
export function stringifyMineflayerError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

/** 注册一次性事件监听。 */
function addOnceListener(
  source: MineflayerEventSource,
  eventName: string,
  listener: (...args: readonly unknown[]) => void,
): () => void {
  if (source.once) {
    source.once(eventName, listener);
    return () => removeEventListener(source, eventName, listener);
  }

  const wrappedListener = (...args: readonly unknown[]) => {
    removeEventListener(source, eventName, wrappedListener);
    listener(...args);
  };
  source.on(eventName, wrappedListener);

  return () => removeEventListener(source, eventName, wrappedListener);
}

/** 注册事件监听并返回移除函数。 */
function addEventListener(
  source: MineflayerEventSource,
  eventName: string,
  listener: (...args: readonly unknown[]) => void,
): () => void {
  source.on(eventName, listener);

  return () => removeEventListener(source, eventName, listener);
}

/** 移除事件监听器。 */
function removeEventListener(
  source: MineflayerEventSource,
  eventName: string,
  listener: (...args: readonly unknown[]) => void,
): void {
  if (source.off) {
    source.off(eventName, listener);
    return;
  }

  source.removeListener?.(eventName, listener);
}
