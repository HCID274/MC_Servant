import type {
  ResourceRefreshRadius,
  RuntimeResourceRefreshResult,
} from "../../core-ports/runtime.js";
import type {
  CollectSkillExecutionResult,
  CollectSkillParams,
  EquipSkillExecutionResult,
  EquipSkillParams,
  GoToSkillExecutionResult,
  GoToSkillParams,
  MineSkillExecutionResult,
  MineSkillParams,
} from "../../core-ports/skills.js";

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

/** Mineflayer（Minecraft 协议客户端） 底层协议事件源最小接口。 */
export interface MineflayerProtocolEventSource {
  /** 注册持续协议包监听器。 */
  on(eventName: string, listener: (packet: unknown) => void): unknown;
  /** 移除协议包监听器。 */
  off?(eventName: string, listener: (packet: unknown) => void): unknown;
  /** 移除协议包监听器。 */
  removeListener?(eventName: string, listener: (packet: unknown) => void): unknown;
}

/** Mineflayer（Minecraft 协议客户端） 当前游戏维度状态的可写最小结构。 */
export interface MineflayerGameState {
  /** 当前 worldName（世界名） 或 dimension（维度） 标识。 */
  dimension?: string;
  /** 当前维度最低 Y 坐标。 */
  minY?: number;
  /** 当前维度总高度。 */
  height?: number;
}

/** Mineflayer（Minecraft 协议客户端） 三维坐标最小结构。 */
export interface MineflayerVec3Like {
  /** X 坐标。 */
  readonly x: number;
  /** Y 坐标。 */
  readonly y: number;
  /** Z 坐标。 */
  readonly z: number;
}

/** Mineflayer（Minecraft 协议客户端） 可写三维坐标最小结构。 */
export interface MineflayerWritableVec3Like {
  /** X 坐标。 */
  x: number;
  /** Y 坐标。 */
  y: number;
  /** Z 坐标。 */
  z: number;
  /** 兼容 Vec3（向量） 的整体更新方法。 */
  update?(value: MineflayerVec3Like): void;
  /** 兼容 Vec3（向量） 的整体设置方法。 */
  set?(x: number, y: number, z: number): void;
}

/** Mineflayer（Minecraft 协议客户端） 方块句柄最小结构。 */
export interface MineflayerBlockHandle {
  /** 标准方块名称。 */
  readonly name?: string;
  /** 方块数字标识。 */
  readonly type?: number;
  /** 方块坐标。 */
  readonly position?: MineflayerVec3Like;
  /** runtime（运行时） 暴露的方块 tag（标签） 列表或索引。 */
  readonly tags?: readonly string[] | Readonly<Record<string, unknown>>;
}

/** Mineflayer（Minecraft 协议客户端） 物品句柄最小结构。 */
export interface MineflayerItemHandle {
  /** 标准物品名称。 */
  readonly name?: string;
  /** 可读展示名。 */
  readonly displayName?: string;
  /** 物品堆叠数量。 */
  readonly count?: number;
}

/** Mineflayer（Minecraft 协议客户端） 实体句柄最小结构。 */
export interface MineflayerEntityHandle {
  /** 实体标识。 */
  readonly id?: number | string;
  /** Mineflayer（Minecraft 协议客户端） 对象类型；掉落物常见值为 Item。 */
  readonly objectType?: string;
  /** 实体名。 */
  readonly name?: string;
  /** 实体展示名。 */
  readonly displayName?: string;
  /** 实体坐标。 */
  readonly position?: MineflayerVec3Like;
  /** 实体速度。 */
  readonly velocity?: MineflayerWritableVec3Like;
  /** 可能存在的掉落物信息。 */
  readonly item?: MineflayerItemHandle;
  /** 兼容字段：掉落物信息。 */
  readonly droppedItem?: MineflayerItemHandle;
  /** 兼容字段：对象数据。 */
  readonly objectData?: unknown;
  /** 元数据载荷。 */
  readonly metadata?: readonly unknown[];
}

/** Mineflayer（Minecraft 协议客户端） 事件能力端口。 */
export interface MineflayerEventPort extends MineflayerEventSource {}

/** Mineflayer（Minecraft 协议客户端） 生命周期能力端口。 */
export interface MineflayerLifecyclePort extends MineflayerEventPort {
  /** Mineflayer（Minecraft 协议客户端） 实际登录用户名。 */
  readonly username?: string;
  /** Mineflayer（Minecraft 协议客户端） 当前游戏状态；Multiworld（多世界模组） 下需修正维度高度边界。 */
  readonly game?: MineflayerGameState;
  /** Mineflayer（Minecraft 协议客户端） 底层协议客户端事件源。 */
  readonly _client?: MineflayerProtocolEventSource;
  /** Mineflayer（Minecraft 协议客户端） 当前实体快照；spawn（生成） 前可能不存在。 */
  readonly entity?: MineflayerEntityHandle;
  /** 断开连接的优先方法。 */
  quit?(reason?: string): void;
  /** 断开连接的兼容方法。 */
  end?(reason?: string): void;
}

/** Mineflayer（Minecraft 协议客户端） 聊天能力端口。 */
export interface MineflayerChatPort {
  /** 向 Minecraft（我的世界） 游戏聊天频道写入文本。 */
  chat?(text: string): void | Promise<void>;
}

/** Mineflayer（Minecraft 协议客户端） 插件与寻路能力端口。 */
export interface MineflayerPluginPort {
  /** Mineflayer（Minecraft 协议客户端） 方块 / 物品注册表。 */
  readonly registry?: unknown;
  /** Mineflayer（Minecraft 协议客户端） 插件加载入口。 */
  loadPlugin?(plugin: unknown): void;
  /** mineflayer-pathfinder（Mineflayer 寻路插件） 注入后的最小 API（应用程序接口）。 */
  readonly pathfinder?: MineflayerPathfinderApi;
}

/** Mineflayer（Minecraft 协议客户端） 挖掘能力端口。 */
export interface MineflayerMiningPort {
  /** 查找附近方块。 */
  findBlocks?(input: {
    matching: (block: MineflayerBlockHandle) => boolean;
    maxDistance: number;
    count: number;
  }): readonly MineflayerVec3Like[] | Promise<readonly MineflayerVec3Like[]>;
  /** 读取指定坐标的方块。 */
  blockAt?(position: MineflayerVec3Like): MineflayerBlockHandle | null | undefined;
  /** 挖掘指定方块。 */
  dig?(block: MineflayerBlockHandle): void | Promise<void>;
}

/** Mineflayer（Minecraft 协议客户端） 实体查询能力端口。 */
export interface MineflayerEntityPort {
  /** 当前世界实体索引。 */
  readonly entities?: Readonly<Record<string, MineflayerEntityHandle>>;
  /** 查找最近的实体。 */
  nearestEntity?(
    matcher: (entity: MineflayerEntityHandle) => boolean,
  ): MineflayerEntityHandle | null;
}

/** Mineflayer（Minecraft 协议客户端） 背包与装备能力端口。 */
export interface MineflayerInventoryPort {
  /** 当前背包快照。 */
  readonly inventory?: {
    /** 背包内所有非空物品栈。 */
    items(): readonly MineflayerItemHandle[];
    /** 可选空槽数量。 */
    emptySlotCount?(): number;
  };
  /** 装备物品到目标槽位。 */
  equip?(item: MineflayerItemHandle, destination: string): void | Promise<void>;
}

/** Mineflayer（Minecraft 协议客户端） 移动能力端口。 */
export interface MineflayerMovementPort extends MineflayerLifecyclePort, MineflayerPluginPort {}

/** Mineflayer（Minecraft 协议客户端） Bot 句柄的能力组合。 */
export interface MineflayerBotHandle
  extends MineflayerLifecyclePort,
    MineflayerChatPort,
    MineflayerMovementPort,
    MineflayerMiningPort,
    MineflayerEntityPort,
    MineflayerInventoryPort {}

/** Mineflayer 寻路插件内部接口声明。 */
export interface MineflayerPathfinderApi {
  /** 设置 pathfinder（寻路器） 移动配置。 */
  setMovements?(movements: unknown): void;
  /** 执行寻路目标。 */
  goto(goal: unknown): Promise<void> | void;
}

/** Mineflayer 寻路插件模块结构。 */
export interface MineflayerPathfinderModule {
  /** Mineflayer（Minecraft 协议客户端） pathfinder（寻路器） 插件函数。 */
  readonly pathfinder: unknown;
  /** pathfinder（寻路器） 移动配置构造器。 */
  readonly Movements: new (
    bot: MineflayerMovementPort,
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
    /** 近距离目标。 */
    readonly GoalNear: new (
      x: number,
      y: number,
      z: number,
      range: number,
    ) => unknown;
  };
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
  /** 当前是否已满足世界交互 ready（就绪）；spawn（生成） 前必须为 false。 */
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
  /** 建立 Mineflayer（Minecraft 协议客户端） 连接。 */
  connect(): Promise<MineflayerTransportSnapshot<TBotId>>;
  /** 断开 Mineflayer（Minecraft 协议客户端） 连接。 */
  disconnect(reason?: string): Promise<MineflayerTransportSnapshot<TBotId>>;
  /** 通过当前 Mineflayer（Minecraft 协议客户端） 连接发送聊天文本。 */
  chat(text: string): Promise<void>;
  /** 通过受控移动能力执行 goTo（前往坐标）。 */
  goTo(params: Readonly<GoToSkillParams>): Promise<GoToSkillExecutionResult>;
  /** 通过受控挖掘能力执行 mine（挖掘）。 */
  mine(params: Readonly<MineSkillParams>): Promise<MineSkillExecutionResult>;
  /** 通过受控实体与移动能力执行 collect（捡拾）。 */
  collect(params: Readonly<CollectSkillParams>): Promise<CollectSkillExecutionResult>;
  /** 通过受控背包能力执行 equip（装备）。 */
  equip(params: Readonly<EquipSkillParams>): Promise<EquipSkillExecutionResult>;
  /** 围绕 Bot（机器人） 当前位置执行只读资源刷新。 */
  refreshAroundBot(
    resourceKey: string,
    radius: ResourceRefreshRadius,
  ): Promise<RuntimeResourceRefreshResult>;
  /** 获取当前连接描述快照。 */
  getSnapshot(): MineflayerTransportSnapshot<TBotId>;
  /** 获取当前只读事件源；未连接或已回收时为 null。 */
  getEventSource(): MineflayerEventSource | null;
}
