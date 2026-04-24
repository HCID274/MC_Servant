import { assertNonEmptyString, cloneReadonlyValue } from "../domain/invariants.js";
import {
  type GoToSkillExecutionResult,
  type GoToSkillParams,
  createGoToSkillExecutionResult,
} from "../skills/index.js";

/** Mineflayer（Minecraft 协议客户端） 传输连接状态清单。 */
export const MINEFLAYER_TRANSPORT_STATES = [
  "idle",
  "connecting",
  "connected",
  "disconnecting",
  "disconnected",
  "failed",
] as const;

/** Mineflayer（Minecraft 协议客户端） 传输连接状态联合类型。 */
export type MineflayerTransportState = (typeof MINEFLAYER_TRANSPORT_STATES)[number];

/** Mineflayer（Minecraft 协议客户端） 创建参数的最小可控子集。 */
export interface MineflayerCreateBotOptions {
  /** Bot 登录用户名。 */
  readonly username: string;
  /** Minecraft（游戏） 服务器地址。 */
  readonly host: string;
  /** Minecraft（游戏） 服务器端口。 */
  readonly port: number;
  /** 可选协议版本。 */
  readonly version?: string;
  /** 可选认证模式，默认由 Mineflayer（Minecraft 协议客户端） 处理。 */
  readonly auth?: string;
}

/** Mineflayer（Minecraft 协议客户端） 事件源最小接口。 */
export interface MineflayerEventSource {
  /** 注册持续事件监听器。 */
  on(eventName: string, listener: (...args: readonly unknown[]) => void): unknown;
  /** 注册一次性事件监听器。 */
  once?(eventName: string, listener: (...args: readonly unknown[]) => void): unknown;
  /** 移除事件监听器。 */
  off?(eventName: string, listener: (...args: readonly unknown[]) => void): unknown;
  /** 移除事件监听器。 */
  removeListener?(eventName: string, listener: (...args: readonly unknown[]) => void): unknown;
}

/** Mineflayer（Minecraft 协议客户端） Bot 句柄的最小生命周期接口。 */
export interface MineflayerBotHandle extends MineflayerEventSource {
  /** Mineflayer（Minecraft 协议客户端） 实际登录用户名。 */
  readonly username?: string;
  /** Mineflayer（Minecraft 协议客户端） 当前实体快照；spawn（生成） 前可能不存在。 */
  readonly entity?: {
    /** 当前实体坐标。 */
    readonly position?: {
      /** X 坐标。 */
      readonly x: number;
      /** Y 坐标。 */
      readonly y: number;
      /** Z 坐标。 */
      readonly z: number;
    };
  };
  /** Mineflayer（Minecraft 协议客户端） 方块 / 物品注册表，pathfinder（寻路器） 构造 Movements 时使用。 */
  readonly registry?: unknown;
  /** Mineflayer（Minecraft 协议客户端） 插件加载入口。 */
  loadPlugin?(plugin: unknown): void;
  /** mineflayer-pathfinder（Mineflayer 寻路插件） 注入后的最小 API（应用程序接口）。 */
  readonly pathfinder?: MineflayerPathfinderApi;
  /** 向 Minecraft（我的世界） 游戏聊天频道写入文本。 */
  chat?(text: string): void | Promise<void>;
  /** 断开连接的优先方法。 */
  quit?(reason?: string): void;
  /** 断开连接的兼容方法。 */
  end?(reason?: string): void;
}

/** Mineflayer（Minecraft 协议客户端） Bot 创建函数。 */
export type MineflayerCreateBot = (
  options: MineflayerCreateBotOptions,
) => MineflayerBotHandle | Promise<MineflayerBotHandle>;

/** Mineflayer（Minecraft 协议客户端） 运行时传输依赖。 */
export interface MineflayerRuntimeTransportDependencies {
  /** 可注入的 Bot 创建函数，测试环境用假 Bot 替代真实连接。 */
  readonly createBot?: MineflayerCreateBot;
  /** 连接超时毫秒数。 */
  readonly connectTimeoutMs?: number;
}

/** Mineflayer（Minecraft 协议客户端） 运行时传输描述。 */
export interface MineflayerTransportDescriptor<TBotId extends string = string> {
  /** 目标 Bot 标识。 */
  readonly bot_id: TBotId;
  /** Mineflayer（Minecraft 协议客户端） 登录用户名。 */
  readonly username: string;
  /** Minecraft（游戏） 服务器地址。 */
  readonly host: string;
  /** Minecraft（游戏） 服务器端口。 */
  readonly port: number;
  /** 可选协议版本。 */
  readonly version: string | null;
  /** 可选认证模式。 */
  readonly auth: string | null;
}

/** Mineflayer（Minecraft 协议客户端） 运行时传输快照。 */
export interface MineflayerTransportSnapshot<TBotId extends string = string> {
  /** 目标 Bot 标识。 */
  readonly bot_id: TBotId;
  /** 当前连接状态。 */
  readonly state: MineflayerTransportState;
  /** 是否已连接。 */
  readonly connected: boolean;
  /** 当前是否已满足世界交互 ready（就绪）；`spawn`（生成） 前必须为 false。 */
  readonly world_ready: boolean;
  /** 传输描述。 */
  readonly descriptor: MineflayerTransportDescriptor<TBotId>;
  /** 当前 Mineflayer（Minecraft 协议客户端） 用户名。 */
  readonly username: string;
  /** 最近一次错误消息。 */
  readonly last_error: string | null;
}

/** Mineflayer（Minecraft 协议客户端） 运行时传输句柄。 */
export interface MineflayerRuntimeTransport<TBotId extends string = string> {
  /** 传输描述。 */
  readonly descriptor: MineflayerTransportDescriptor<TBotId>;
  /** 建立 Mineflayer（Minecraft 协议客户端） 连接；`login`（协议登录） 后可聊天，`spawn`（生成） 后 world_ready（世界就绪） 才打开。 */
  connect(): Promise<MineflayerTransportSnapshot<TBotId>>;
  /** 断开 Mineflayer（Minecraft 协议客户端） 连接。 */
  disconnect(reason?: string): Promise<MineflayerTransportSnapshot<TBotId>>;
  /** 通过当前 Mineflayer（Minecraft 协议客户端） 连接发送聊天文本。 */
  chat(text: string): Promise<void>;
  /** 通过受控 Mineflayer（Minecraft 协议客户端） 移动能力执行 `goTo`（前往坐标）。 */
  goTo(params: Readonly<GoToSkillParams>): Promise<GoToSkillExecutionResult>;
  /** 获取当前连接描述快照。 */
  getSnapshot(): MineflayerTransportSnapshot<TBotId>;
  /** 获取当前只读事件源；未连接或已回收时为 null。 */
  getEventSource(): MineflayerEventSource | null;
}

const DEFAULT_MINEFLAYER_CONNECT_TIMEOUT_MS = 30_000;
/** Mineflayer 寻路插件内部接口声明。 */

interface MineflayerPathfinderApi {
  /** 设置 pathfinder（寻路器） 移动配置。 */
  setMovements?(movements: unknown): void;
  /** 执行寻路目标。 */
  goto(goal: unknown): Promise<void> | void;
}
/** Mineflayer 寻路插件模块结构。 */

interface MineflayerPathfinderModule {
  /** Mineflayer（Minecraft 协议客户端） pathfinder（寻路器） 插件函数。 */
  readonly pathfinder: unknown;
  /** pathfinder（寻路器） 移动配置构造器。 */
  readonly Movements: new (
    bot: MineflayerBotHandle,
    registry: unknown,
  ) => unknown;
  /** pathfinder（寻路器） 目标构造器集合。 */
  readonly goals: {
    /** 方块坐标目标。 */
    readonly GoalBlock: new (
      x: number,
      y: number,
      z: number,
    ) => unknown;
  };
}

/** 创建 Mineflayer 运行时传输描述。 */
export function createMineflayerTransportDescriptor<TBotId extends string>(input: {
  botId: TBotId;
  username?: string;
  host?: string;
  port?: number;
  version?: string | null;
  auth?: string | null;
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

/**
 * 创建 Mineflayer 运行时传输工厂。
 *
 * 1. 协议栈隔离：作为物理 Mineflayer 协议栈与系统逻辑层之间的网关，管理真实的 TCP 连接与事件流。
 * 2. 交互状态管理：维护连接的精细状态（Connecting, Connected, Spawned），并提供标准化的 chat 和 goTo 能力。
 * 3. 稳压清理：内置清理逻辑，确保连接在失败或关闭时能被平滑回收。
 *
 * @param descriptor 传输连接描述符
 * @param dependencies 可注入的驱动与配置
 * @returns 运行时传输句柄
 */
export function createMineflayerRuntimeTransport<TBotId extends string>(
  descriptor: MineflayerTransportDescriptor<TBotId>,
  dependencies: MineflayerRuntimeTransportDependencies = {},
): MineflayerRuntimeTransport<TBotId> {
  let state: MineflayerTransportState = "idle";
  let bot: MineflayerBotHandle | null = null;
  let eventSource: MineflayerEventSource | null = null;
  let lastError: string | null = null;
  let removeRuntimeListeners: (() => void) | null = null;
  let spawned = false;
  let pathfinderLoaded = false;
  const createBot = dependencies.createBot ?? createDefaultMineflayerBot;
  const connectTimeoutMs = dependencies.connectTimeoutMs ?? DEFAULT_MINEFLAYER_CONNECT_TIMEOUT_MS;

  const createSnapshot = (): MineflayerTransportSnapshot<TBotId> =>
    cloneReadonlyValue({
      bot_id: descriptor.bot_id,
      state,
      connected: state === "connected",
      world_ready: spawned || bot?.entity?.position !== undefined,
      descriptor,
      username: bot?.username ?? descriptor.username,
      last_error: lastError,
    });

  return Object.freeze({
    descriptor,
    async connect(): Promise<MineflayerTransportSnapshot<TBotId>> {
      if (state === "connected") {
        return createSnapshot();
      }

      if (state === "connecting") {
        throw new Error("Mineflayer transport is already connecting");
      }

      state = "connecting";
      lastError = null;

      try {
        bot = await createBot(createMineflayerCreateBotOptions(descriptor));
        removeRuntimeListeners = attachRuntimeStateListeners(bot, {
          markSpawned() {
            spawned = true;
          },
          markDisconnected() {
            if (state !== "disconnecting") {
              state = "disconnected";
            }
          },
          markFailed(error) {
            state = "failed";
            lastError = stringifyMineflayerError(error);
          },
        });
        await waitForMineflayerSpawn(bot, connectTimeoutMs);
        state = "connected";
        eventSource = createReadonlyMineflayerEventSource(bot);

        return createSnapshot();
      } catch (error) {
        state = "failed";
        lastError = stringifyMineflayerError(error);
        cleanupMineflayerBot("ts-core connect failed before spawn");
        throw error;
      }
    },
    async disconnect(reason = "ts-core shutdown"): Promise<MineflayerTransportSnapshot<TBotId>> {
      if (state === "idle" || state === "disconnected") {
        state = "disconnected";
        return createSnapshot();
      }

      state = "disconnecting";

      try {
        cleanupMineflayerBot(reason);
      } finally {
        state = "disconnected";
      }

      return createSnapshot();
    },
    async chat(text: string): Promise<void> {
      assertNonEmptyString(text, "chat.text");

      if (state !== "connected" || bot === null) {
        throw new Error("Mineflayer transport must be connected before chat");
      }

      if (typeof bot.chat !== "function") {
        throw new Error("Mineflayer bot handle does not expose chat");
      }

      await bot.chat(text);
    },
    async goTo(params: Readonly<GoToSkillParams>): Promise<GoToSkillExecutionResult> {
      if (state !== "connected" || bot === null) {
        throw new Error("Mineflayer transport must be connected before goTo");
      }

      if (!spawned && bot.entity?.position === undefined) {
        throw new Error("Mineflayer transport must reach spawn before goTo");
      }

      const currentBot = bot;
      const pathfinderModule = await loadMineflayerPathfinder();

      if (!pathfinderLoaded) {
        if (typeof currentBot.loadPlugin !== "function") {
          throw new Error("Mineflayer bot handle does not expose loadPlugin for pathfinder");
        }

        currentBot.loadPlugin(pathfinderModule.pathfinder);
        pathfinderLoaded = true;
      }

      if (currentBot.pathfinder === undefined) {
        throw new Error("Mineflayer bot handle does not expose pathfinder after plugin load");
      }

      const movements = new pathfinderModule.Movements(currentBot, currentBot.registry);
      currentBot.pathfinder.setMovements?.(movements);
      await currentBot.pathfinder.goto(
        new pathfinderModule.goals.GoalBlock(params.x, params.y, params.z),
      );

      return createGoToSkillExecutionResult(params);
    },
    getSnapshot(): MineflayerTransportSnapshot<TBotId> {
      return createSnapshot();
    },
    getEventSource(): MineflayerEventSource | null {
      return eventSource;
    },
  });
  /** 清理 Mineflayer 机器人实例与底层连接。 */

  function cleanupMineflayerBot(reason: string): void {
    const currentBot = bot;
    removeRuntimeListeners?.();
    removeRuntimeListeners = null;
    bot = null;
    eventSource = null;
    spawned = false;
    pathfinderLoaded = false;

    try {
      currentBot?.quit?.(reason);
      if (!currentBot?.quit) {
        currentBot?.end?.(reason);
      }
    } catch {
      // 清理路径不能覆盖连接失败或上层关闭的真实原因。
    }
  }
}

/**
 * 创建只读的 Mineflayer 事件源。
 */
function createReadonlyMineflayerEventSource(bot: MineflayerBotHandle): MineflayerEventSource {
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

/**
 * 创建 Mineflayer 驱动所需的选项对象。
 */
function createMineflayerCreateBotOptions(
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

/**
 * 绑定运行时状态监听器。
 */
function attachRuntimeStateListeners(
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

/**
 * 等待 Mineflayer 生成。
 */
function waitForMineflayerSpawn(bot: MineflayerBotHandle, timeoutMs: number): Promise<void> {
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
      // EasyAuth（离线服认证模组） 可能在 spawn（生成） 前先要求聊天注册/登录；
      // 对最小聊天闭环而言 login（协议登录） 后已经具备 chat（聊天） 写能力。
      // 这不是世界交互 ready（就绪），只能服务本任务的聊天与认证命令写入。
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

/**
 * 注册一次性事件监听。
 */
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

/**
 * 注册事件监听并返回移除函数。
 */
function addEventListener(
  source: MineflayerEventSource,
  eventName: string,
  listener: (...args: readonly unknown[]) => void,
): () => void {
  source.on(eventName, listener);

  return () => removeEventListener(source, eventName, listener);
}

/**
 * 移除事件监听器。
 */
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

/**
 * 将 Mineflayer 错误转换为字符串。
 */
function stringifyMineflayerError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

/**
 * 动态加载 Mineflayer 寻路插件。
 */
async function loadMineflayerPathfinder(): Promise<MineflayerPathfinderModule> {
  return (await import("mineflayer-pathfinder")) as unknown as MineflayerPathfinderModule;
}
