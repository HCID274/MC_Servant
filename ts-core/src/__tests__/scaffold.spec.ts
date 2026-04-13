import { describe, expect, it } from "vitest";

import {
  BotStatus,
  CORE_MODULE_NAMES,
  ConversationPriority,
  ExecutionTaskKind,
  MessageSource,
  RUNTIME_EVENT_TYPES,
  coreModuleBoundaries,
  createEnvironmentSnapshot,
  createHealthResponse,
  createRuntimeScaffold,
  createSessionRecord,
  createStatusResponse,
  createWorldModelQueryBoundary,
  toExecPriority,
} from "../index.js";

describe("TS Core 工程骨架", () => {
  it("应导出八个模块边界并与模块名清单一致", () => {
    const moduleNames = coreModuleBoundaries.map((boundary) => boundary.moduleName);

    expect(moduleNames).toEqual([...CORE_MODULE_NAMES]);
  });

  it("应保留基础状态枚举与任务类型枚举", () => {
    expect(BotStatus.IDLE).toBe("idle");
    expect(ExecutionTaskKind.SkillCall).toBe("skill_call");
    expect(MessageSource.Web).toBe("web");
    expect(toExecPriority(ConversationPriority.Interrupt)).toBeNull();
  });

  it("应能创建最小运行时骨架对象", () => {
    const runtimeScaffold = createRuntimeScaffold();

    expect(runtimeScaffold.defaultStatus).toBe(BotStatus.IDLE);
    expect(runtimeScaffold.supportedTaskKinds).toContain(ExecutionTaskKind.SkillCall);
    expect(runtimeScaffold.supportedTaskKinds).not.toContain("conversation");
    expect(runtimeScaffold.interruptTemplate.source.type).toBe("system");
    expect(RUNTIME_EVENT_TYPES).toContain("task.started");
  });

  it("应从根入口导出 observation 与 world-model 的真实契约构造器", () => {
    const snapshot = createEnvironmentSnapshot({
      mineflayer: {
        timestamp: 1,
        snapshot_version: "root-export",
        bot: {
          position: { x: 0, y: 64, z: 0 },
          health: 20,
          food: 20,
          experience: 0,
          is_on_fire: false,
          is_in_water: false,
          y_velocity: 0,
        },
        inventory: {
          items: [],
          total_items: 0,
          occupied_slots: 0,
          free_slots: 36,
        },
        equipment: {
          head: null,
          chest: null,
          legs: null,
          feet: null,
          main_hand: null,
          off_hand: null,
          has_weapon_equipped: false,
        },
        nearby_entities: [],
        nearby_blocks: [],
      },
    });
    const worldModel = createWorldModelQueryBoundary({
      anchor: snapshot.bot.position,
      snapshot_version: snapshot.snapshot_version,
      clusters: [],
    });

    expect(snapshot.snapshot_version).toBe("root-export");
    expect(worldModel.queryClusters("oak_log")).toEqual([]);
  });

  it("应从根入口导出 interfaces（接口层） 的最小纯契约", () => {
    const session = createSessionRecord({
      id: "session-root",
      owner_id: "owner-root",
      bot_id: "bot-root",
      token: "token-root",
      expires_at: "2026-04-20T00:00:00.000Z",
      created_at: "2026-04-13T00:00:00.000Z",
    });
    const health = createHealthResponse("2026-04-13T00:00:00.000Z");
    const status = createStatusResponse({
      bot: {
        bot_id: session.bot_id,
        status: BotStatus.IDLE,
        intent_epoch: 3,
        last_event_seq: 9,
        updated_at: "2026-04-13T00:00:00.000Z",
      },
    });

    expect(session.bot_id).toBe("bot-root");
    expect(health.status).toBe("ok");
    expect(status.bot.status).toBe(BotStatus.IDLE);
  });
});
