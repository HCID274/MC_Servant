import type {
  BridgeObservationInput,
  EnvironmentSnapshot,
  MineflayerObservationInput,
  ObservationReadBoundary,
  ObservationSnapshotSource,
  ThreatAssessment,
} from "./contracts.js";
import {
  assessThreat,
  createEnvironmentSnapshot,
  createObservationReadBoundary,
  createThreatDetectorInput,
} from "./snapshot.js";

/** Mineflayer（Minecraft 协议客户端） 事件源最小接口；观测层只需要只读监听能力。 */
export interface MineflayerObservationEventSource {
  /** 注册持续事件监听器。 */
  on(eventName: string, listener: (...args: readonly unknown[]) => void): unknown;
  /** 移除事件监听器。 */
  off?(eventName: string, listener: (...args: readonly unknown[]) => void): unknown;
  /** 移除事件监听器。 */
  removeListener?(eventName: string, listener: (...args: readonly unknown[]) => void): unknown;
}

/** observation（观测） 默认监听的 Mineflayer（Minecraft 协议客户端） 事件清单。 */
export const OBSERVATION_MINEFLAYER_EVENT_NAMES = [
  "spawn",
  "physicsTick",
  "health",
  "entitySpawn",
  "entityMoved",
  "blockUpdate",
  "death",
  "respawn",
] as const;

/** observation（观测） 默认监听的 Mineflayer（Minecraft 协议客户端） 事件联合类型。 */
export type ObservationMineflayerEventName = (typeof OBSERVATION_MINEFLAYER_EVENT_NAMES)[number];

/** observation（观测） 运行时缓存的 Mineflayer（Minecraft 协议客户端） 事件绑定。 */
export interface ObservationMineflayerEventBinding {
  /** 事件源。 */
  readonly eventSource: MineflayerObservationEventSource;
  /** 读取当前 Mineflayer（Minecraft 协议客户端） 只读输入的函数。 */
  readonly readObservationInput: (
    eventName: ObservationMineflayerEventName,
    args: readonly unknown[],
  ) => MineflayerObservationInput | null;
  /** 可选事件清单，默认使用 observation（观测） 标准事件。 */
  readonly events?: readonly ObservationMineflayerEventName[];
}

/** observation（观测） 事件绑定句柄。 */
export interface ObservationEventSubscription {
  /** 已绑定事件清单。 */
  readonly events: readonly ObservationMineflayerEventName[];
  /** 解除事件绑定。 */
  close(): void;
}

/** observation（观测） 运行时缓存句柄。 */
export interface ObservationRuntimeCache {
  /** 只读观测边界。 */
  readonly readBoundary: ObservationReadBoundary;
  /** 刷新 Mineflayer（Minecraft 协议客户端） 当前输入并替换环境快照。 */
  refreshFromMineflayer(input: MineflayerObservationInput): EnvironmentSnapshot;
  /** 刷新 JAR Bridge（服务端桥接） 补充输入并替换环境快照。 */
  refreshFromBridge(input: BridgeObservationInput): EnvironmentSnapshot;
  /** 获取当前环境快照副本。 */
  getSnapshot(): EnvironmentSnapshot;
  /** 基于当前快照评估威胁。 */
  assessThreat(): ThreatAssessment | null;
  /** 绑定 Mineflayer（Minecraft 协议客户端） 事件驱动刷新。 */
  bindMineflayerEvents(input: ObservationMineflayerEventBinding): ObservationEventSubscription;
}

/**
 * 创建事件驱动的 observation 运行时缓存。
 *
 * 1. 观测物化视图（Materialized View）：作为 Mineflayer 与 JAR Bridge 原始输入的聚合点，维护最新的环境快照副本。
 * 2. 事件驱动刷新：通过监听 Mineflayer 物理事件（如 physicsTick, blockUpdate），自动刷新快照并重新评估威胁。
 * 3. 降低 IO 消耗：将高频的物理事件（Mineflayer 原生对象）映射为领域快照（Plain Object），供后续所有逻辑层以只读方式消费，避免频繁访问底层协议栈。
 *
 * @param input 可选初始快照
 * @returns observation 运行时缓存句柄
 */
export function createObservationRuntimeCache(
  input: {
    initialSnapshot?: EnvironmentSnapshot;
  } = {},
): ObservationRuntimeCache {
  let currentSnapshot = input.initialSnapshot;
  let latestMineflayerInput: MineflayerObservationInput | undefined;
  let latestBridgeInput: BridgeObservationInput | undefined;
  const snapshotSource: ObservationSnapshotSource = {
    getCurrentSnapshot() {
      if (currentSnapshot === undefined) {
        throw new Error("Observation runtime cache has no environment snapshot yet");
      }

      return currentSnapshot;
    },
  };
  const readBoundary = createObservationReadBoundary(snapshotSource);

  const refreshSnapshot = (): EnvironmentSnapshot => {
    currentSnapshot = createEnvironmentSnapshot({
      ...(latestMineflayerInput === undefined ? {} : { mineflayer: latestMineflayerInput }),
      ...(latestBridgeInput === undefined ? {} : { bridge: latestBridgeInput }),
    });

    return readBoundary.getSnapshot();
  };

  return Object.freeze({
    readBoundary,
    refreshFromMineflayer(input: MineflayerObservationInput): EnvironmentSnapshot {
      latestMineflayerInput = input;
      return refreshSnapshot();
    },
    refreshFromBridge(input: BridgeObservationInput): EnvironmentSnapshot {
      latestBridgeInput = input;
      return refreshSnapshot();
    },
    getSnapshot(): EnvironmentSnapshot {
      return readBoundary.getSnapshot();
    },
    assessThreat(): ThreatAssessment | null {
      return assessThreat(createThreatDetectorInput(snapshotSource.getCurrentSnapshot()));
    },
    bindMineflayerEvents(input: ObservationMineflayerEventBinding): ObservationEventSubscription {
      const events = Object.freeze([...(input.events ?? OBSERVATION_MINEFLAYER_EVENT_NAMES)]);
      const removeListeners = events.map((eventName) => {
        const listener = (...args: readonly unknown[]) => {
          const observationInput = input.readObservationInput(eventName, args);

          if (observationInput !== null) {
            latestMineflayerInput = observationInput;
            refreshSnapshot();
          }
        };

        input.eventSource.on(eventName, listener);

        return () => removeObservationListener(input.eventSource, eventName, listener);
      });

      return Object.freeze({
        events,
        close() {
          for (const removeListener of removeListeners) {
            removeListener();
          }
        },
      });
    },
  });
}

/**
 * 移除观测事件监听器。
 *
 * 驱动兼容性：兼容 Node.js 原生 EventEmitter 与某些自定义驱动的事件移除接口（off vs removeListener）。
 */
function removeObservationListener(
  source: MineflayerObservationEventSource,
  eventName: string,
  listener: (...args: readonly unknown[]) => void,
): void {
  if (source.off) {
    source.off(eventName, listener);
    return;
  }

  source.removeListener?.(eventName, listener);
}
