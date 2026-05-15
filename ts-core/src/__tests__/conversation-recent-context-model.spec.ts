import { describe, expect, it } from "vitest";

import {
  createChatSnapshotContext,
  createConversationRecentContextStore,
  createPlannerSnapshotContext,
} from "../conversation/index.js";
import type { EnvironmentSnapshot } from "../core-ports/observation.js";
import { TaskHistoryStatus } from "../core-ports/tasking.js";
import { createSandboxError, createSandboxExecutionFailure } from "../sandbox/index.js";
import { formatSandboxRecentEventLine } from "../sandbox/recent-event.js";
import {
  SKILL_DIRECTORY,
  assertSkillRecentEventFormatters,
  createCollectSkillExecutionResult,
  createGoToSkillExecutionResult,
  formatSkillRecentEventLine,
} from "../skills/index.js";

describe("conversation recent context（最近上下文）", () => {
  it("应按 message_id（消息标识）聚合并按 timestamp（时间戳）升序渲染同轮事件", () => {
    const store = createConversationRecentContextStore({ now: () => 0 });

    store.appendBotReply({ message_id: "msg-1", text: "马上去喵~", timestamp: 30 });
    store.appendOwnerMessage({ message_id: "msg-1", text: "去捡盾牌", timestamp: 10 });
    store.appendSandboxCode({
      message_id: "msg-1",
      code: "await collect('shield')",
      timestamp: 20,
    });

    const rendered = store.render({
      actorRecentEvents: [
        {
          message_id: "msg-1",
          line: "collect 成功,捡到 shield x1",
          timestamp: 40,
        },
      ],
    });

    expect(rendered).toBe(
      [
        "主人：去捡盾牌",
        "沙盒TS：",
        "```ts",
        "await collect('shield')",
        "```",
        "Bot：马上去喵~",
        "执行结果：collect 成功,捡到 shield x1",
      ].join("\n"),
    );
  });

  it("应按 10 整轮 LRU（最近最少使用） 淘汰且不渲染当前 user message（用户消息）", () => {
    const store = createConversationRecentContextStore({ now: () => 0 });

    for (let index = 1; index <= 11; index += 1) {
      store.appendOwnerMessage({
        message_id: `msg-${index}`,
        text: `第 ${index} 轮`,
        timestamp: index,
      });
      store.appendBotReply({
        message_id: `msg-${index}`,
        text: `回复 ${index}`,
        timestamp: index + 0.1,
      });
    }

    const rendered = store.render({
      currentMessageId: "msg-11",
      actorRecentEvents: [
        {
          message_id: "msg-1",
          line: "collect 成功,捡到 shield x1",
          timestamp: 100,
        },
      ],
    });

    expect(rendered).not.toContain("第 1 轮");
    expect(rendered).not.toContain("第 11 轮");
    expect(rendered).toContain("主人：第 2 轮");
    expect(rendered).toContain("Bot：回复 10");
    expect(rendered).not.toContain("shield x1");
  });

  it("应只截断超长 TS（TypeScript）代码块且保留同轮执行结果和报错", () => {
    const store = createConversationRecentContextStore({ now: () => 0 });
    const code = Array.from({ length: 201 }, (_, index) => `await step${index}()`).join("\n");

    store.appendOwnerMessage({ message_id: "msg-long", text: "执行长计划", timestamp: 1 });
    store.appendSandboxCode({ message_id: "msg-long", code, timestamp: 2 });
    store.appendSandboxError({
      message_id: "msg-long",
      text: "boom\nstack should disappear",
      timestamp: 3,
    });

    const rendered = store.render({
      actorRecentEvents: [
        {
          message_id: "msg-long",
          line: "sandbox 失败：boom",
          timestamp: 4,
        },
      ],
    });

    expect(rendered).toContain("code_ref=msg-long");
    expect(rendered).toContain("报错：boom stack should disappear");
    expect(rendered).toContain("执行结果：sandbox 失败：boom");
    expect(rendered).not.toContain("await step200()");
  });

  it("continuation（继续任务） 时应只渲染最近失败轮的 Failure Capsule（失败胶囊）", () => {
    const store = createConversationRecentContextStore({ now: () => 0 });

    store.appendOwnerMessage({ message_id: "msg-failed", text: "去挖铁", timestamp: 1 });
    store.appendSandboxCode({
      message_id: "msg-failed",
      code: 'await mine("iron_ore", 1); await report("done")',
      timestamp: 2,
    });
    store.appendSandboxError({
      message_id: "msg-failed",
      text: "resource_not_found:iron_ore",
      timestamp: 3,
    });
    store.appendFailureCapsule({
      message_id: "msg-failed",
      capsule: {
        goal: "挖 iron_ore x1",
        failed_action: "mine",
        failure_code: "resource_not_found",
        progress: "raw_iron 0/1",
        retry_guard: '不要原样重复 mine("iron_ore", 1)',
        hint: "可尝试 deepslate_iron_ore 或汇报附近无矿",
      },
      timestamp: 4,
    });

    const rendered = store.render({ latestFailureCapsuleOnly: true });

    expect(rendered).toBe(
      [
        "[上一轮失败]",
        "目标：挖 iron_ore x1",
        "失败：resource_not_found at mine；进度：raw_iron 0/1",
        '避免重复：不要原样重复 mine("iron_ore", 1)',
        "建议：可尝试 deepslate_iron_ore 或汇报附近无矿",
      ].join("\n"),
    );
    expect(rendered).not.toContain("沙盒TS");
    expect(rendered).not.toContain("resource_not_found:iron_ore");
    expect(store.getLatestFailureCapsule()).toMatchObject({
      failure_code: "resource_not_found",
      failed_action: "mine",
    });
  });

  it("Chat / Plan / Modify 三路快照模板应消费同一 recent context（最近上下文）槽位", () => {
    const snapshot = createEnvironmentSnapshotFixture();
    const recentContext = "主人：去捡盾牌\n执行结果：collect 成功,捡到 shield x1";

    expect(
      createChatSnapshotContext({
        snapshot,
        recentContext,
      }),
    ).toContain(`[最近上下文]\n${recentContext}\n[时间]`);
    expect(
      createPlannerSnapshotContext({
        snapshot,
        recentContext,
      }),
    ).toContain(`[最近上下文]\n${recentContext}\n[附近方块]`);
  });
});

function createEnvironmentSnapshotFixture(): EnvironmentSnapshot {
  return {
    timestamp: 1_712_000_000,
    snapshot_version: "recent-context-snapshot",
    bot: {
      position: { x: 0, y: 64, z: 0 },
      world_key: "minecraft:overworld",
      health: 20,
      food: 20,
      experience: 0,
      is_on_fire: false,
      is_in_water: false,
      y_velocity: 0,
    },
    inventory: { items: [], total_items: 0, occupied_slots: 0, free_slots: 36 },
    equipment: {
      head: null,
      chest: null,
      legs: null,
      feet: null,
      main_hand: null,
      off_hand: null,
      has_weapon_equipped: false,
    },
    nearby_blocks: [],
    nearby_entities: [],
    owner: {
      name: "Steve",
      online: true,
      position: { x: 3, y: 64, z: 4 },
    },
    time: {
      phase: "day",
      time_of_day: 6000,
    },
  };
}

describe("skill recent event formatter（技能最近事件格式化器）", () => {
  it("goTo / collect 成功、失败、中断、取消应输出确定性单行", () => {
    assertSkillRecentEventFormatters([SKILL_DIRECTORY.goTo, SKILL_DIRECTORY.collect]);

    expect(
      formatSkillRecentEventLine({
        skill: "goTo",
        status: "completed",
        result: createGoToSkillExecutionResult({ x: 1, y: 64, z: -3 }),
      }),
    ).toBe("goTo 成功,到达 (1,64,-3)");
    expect(
      formatSkillRecentEventLine({
        skill: "collect",
        status: "completed",
        result: createCollectSkillExecutionResult(
          { itemName: "shield" },
          { collected: [{ name: "shield", count: 1 }] },
        ),
      }),
    ).toBe("collect 成功,捡到 shield x1");
    expect(
      formatSkillRecentEventLine({ skill: "goTo", status: "failed", message: "bad path" }),
    ).toBe("goTo 失败：bad path");
    expect(
      formatSkillRecentEventLine({ skill: "collect", status: "interrupted", message: "cancel" }),
    ).toBe("collect 中断：cancel");
    expect(
      formatSkillRecentEventLine({ skill: "collect", status: "cancelled", message: "stop" }),
    ).toBe("collect 取消：stop");
  });

  it("sandbox（沙盒）失败 formatter（格式化器）只暴露 error.message（错误消息）", () => {
    const result = createSandboxExecutionFailure({
      job_id: "msg-sandbox",
      bot_id: "bot",
      intent_epoch: 1,
      log_ref: "sandbox/2026-05-03/msg-sandbox.jsonl",
      phase_logs: [{ t: 1, phase: "sandbox_done", steps: 0, ms: 1 }],
      step_results: [],
      summary: { total_steps: 0, duration_ms: 1 },
      error: createSandboxError({
        name: "UnhandledError",
        message: "Cannot read properties",
        recoverable: false,
        stack: "stack trace must not render",
      }),
    });

    expect(result.status).toBe(TaskHistoryStatus.Failed);
    expect(formatSandboxRecentEventLine(result)).toBe("sandbox 失败：Cannot read properties");
  });
});
