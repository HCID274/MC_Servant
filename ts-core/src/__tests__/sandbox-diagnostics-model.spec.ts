import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  type AbortError,
  ExecPriority,
  ExecutionTaskKind,
  TaskHistoryStatus,
  type TaskLifecycleEvent,
  createAsyncDiagnosticSink,
  createCodeJob,
  createDiagnosticsCatalog,
  createLlmDiagnosticSummary,
  createLlmLogLine,
  createLlmLogRef,
  createLocalConversationReplyLogSink,
  createSandboxCodeRef,
  createSandboxError,
  createSandboxExecutionFailure,
  createSandboxExecutionInterrupted,
  createSandboxExecutionRequest,
  createSandboxExecutionSuccess,
  createSandboxExperienceDraft,
  createSandboxLogLine,
  createSandboxLogRef,
  createSandboxResourceLimits,
  createSandboxStepResult,
  createTaskLifecycleSummaryJsonlLine,
  createTaskLogLine,
  createTaskLogRef,
  createTaskStartedLifecycleEvent,
  createTaskTerminalLifecycleEvent,
  executeCodeRequest,
} from "../index.js";
import {
  SANDBOX_BOT_METHOD_NAMES,
  SANDBOX_FACADE_SECTIONS,
  SANDBOX_FORBIDDEN_DEMO_METHOD_NAMES,
  SANDBOX_READONLY_SECTIONS,
  type SANDBOX_STEP_ACTION_NAMES,
  SANDBOX_TOOLCHAIN_CAPABILITY_NAMES,
  SANDBOX_TOOLCHAIN_FAILURE_CODES,
  type SandboxExecutionRequest,
  type SandboxStepParamsByAction,
  type SandboxToolchainCapabilityParamsByName,
} from "../sandbox/contracts.js";
import {
  SANDBOX_BOT_SKILL_BINDINGS,
  createSandboxFacadeContract,
  createSandboxFacadePromptIndex,
  describeFacadeNamespace,
  updateSandboxFacadeHotNamespaceQueue,
} from "../sandbox/legacy/index.js";
import { createTaskResultSummaryFromSandboxResult } from "../workers/task-result-summary/index.js";

const validBindings: typeof SANDBOX_BOT_SKILL_BINDINGS = SANDBOX_BOT_SKILL_BINDINGS;
void validBindings;

// @ts-expect-error `dig`（挖掘） 不是 Phase 1（第一阶段） 可记录动作。
const invalidStepAction: (typeof SANDBOX_STEP_ACTION_NAMES)[number] = "dig";
void invalidStepAction;

// @ts-expect-error `goTo`（移动） 的参数必须是坐标结构。
const invalidGoToParams: SandboxStepParamsByAction["goTo"] = { blockName: "oak_log", count: 1 };
void invalidGoToParams;

// @ts-expect-error `goTo`（移动） 不能映射到 `mine`（挖掘） 技能。
const invalidGoToBinding: typeof SANDBOX_BOT_SKILL_BINDINGS.goTo = "mine";
void invalidGoToBinding;

// @ts-expect-error `SandboxExecutionRequest.type` 固定为 `code`（沙箱代码）。
const invalidSandboxRequestType: SandboxExecutionRequest["type"] = ExecutionTaskKind.Code;
void invalidSandboxRequestType;

// @ts-expect-error `AbortError`（中断错误） 固定不可恢复。
const invalidAbortRecoverable: AbortError["recoverable"] = true;
void invalidAbortRecoverable;

const validCraftParams: SandboxToolchainCapabilityParamsByName["craft"] = {
  itemName: "stone_pickaxe",
  count: 1,
};

function createSatisfiedConditionFacade() {
  const state = Object.freeze({
    world_key: "minecraft:overworld",
    inventory: Object.freeze([]),
    main_hand_item_name: null,
    nearby_block_names: Object.freeze(["crafting_table"]),
  });

  return Object.freeze({
    captureConditionState() {
      return state;
    },
    evaluateCondition(input: {
      readonly condition: Readonly<Record<string, unknown>>;
      readonly baseline: typeof state;
      readonly current: typeof state;
    }) {
      const targetCount = typeof input.condition.count === "number" ? input.condition.count : 1;
      const resolvedTarget =
        readTestConditionTarget(input.condition) ??
        readTestConditionBlock(input.condition) ??
        "target";
      return Object.freeze({
        ok: true,
        condition: input.condition,
        completed_count: targetCount,
        target_count: targetCount,
        missing_count: 0,
        resolved_targets: Object.freeze([resolvedTarget]),
        baseline: input.baseline,
        current: input.current,
      });
    },
  });
}

function readTestConditionTarget(condition: Readonly<Record<string, unknown>>): string | null {
  return typeof condition.itemName === "string"
    ? condition.itemName
    : typeof condition.tagName === "string"
      ? condition.tagName
      : null;
}

function readTestConditionBlock(condition: Readonly<Record<string, unknown>>): string | null {
  return typeof condition.blockName === "string" ? condition.blockName : null;
}

function createTestConditionEvaluation(
  input: {
    readonly condition: Readonly<Record<string, unknown>>;
    readonly baseline: Readonly<Record<string, unknown>>;
    readonly current: Readonly<Record<string, unknown>>;
  },
  completed: number,
  target: number,
) {
  const resolvedTarget =
    readTestConditionTarget(input.condition) ?? readTestConditionBlock(input.condition) ?? "target";
  return Object.freeze({
    ok: completed >= target,
    condition: input.condition,
    completed_count: completed,
    target_count: target,
    missing_count: Math.max(0, target - completed),
    resolved_targets: Object.freeze([resolvedTarget]),
    baseline: input.baseline,
    current: input.current,
  });
}
void validCraftParams;

// @ts-expect-error `craft`（合成） 参数不接受坐标；放置坐标属于 `place`（放置） 能力。
const invalidCraftParams: SandboxToolchainCapabilityParamsByName["craft"] = { x: 1 };
void invalidCraftParams;

describe("sandbox（沙箱） 与 diagnostics（诊断） 契约", () => {
  it("AsyncDiagnosticSink（异步诊断汇点） 应投递后立即返回并由 flush（刷盘） 等待慢写", async () => {
    const scheduled: Array<() => void> = [];
    let releaseWrite: (() => void) | undefined;
    const writes: string[] = [];
    const sink = createAsyncDiagnosticSink({
      maxQueueSize: 4,
      schedule: (run) => {
        scheduled.push(run);
      },
      write: async (record: string) => {
        writes.push(record);
        await new Promise<void>((resolve) => {
          releaseWrite = resolve;
        });
      },
    });

    const stats = sink.enqueue("triage-ok");

    expect(stats).toMatchObject({ queued: 1, dropped_count: 0, error_count: 0 });
    expect(writes).toEqual([]);
    expect(scheduled).toHaveLength(1);

    scheduled.shift()?.();
    await Promise.resolve();

    expect(sink.getStats()).toMatchObject({ queued: 0, in_flight: true });
    expect(writes).toEqual(["triage-ok"]);

    const flushPromise = sink.flush();
    releaseWrite?.();

    await expect(flushPromise).resolves.toMatchObject({
      queued: 0,
      in_flight: false,
      dropped_count: 0,
      error_count: 0,
    });
  });

  it("AsyncDiagnosticSink（异步诊断汇点） 队列满时应优先保留高价值失败诊断", async () => {
    const scheduled: Array<() => void> = [];
    const writes: Array<{ id: string; ok: boolean }> = [];
    const sink = createAsyncDiagnosticSink({
      maxQueueSize: 2,
      schedule: (run) => {
        scheduled.push(run);
      },
      getDropPriority: (record: { readonly ok: boolean }) => (record.ok ? 1 : 3),
      write: async (record: { id: string; ok: boolean }) => {
        writes.push(record);
      },
    });

    sink.enqueue({ id: "chat-ok-1", ok: true });
    sink.enqueue({ id: "chat-ok-2", ok: true });
    const stats = sink.enqueue({ id: "plan-failed", ok: false });

    expect(stats).toMatchObject({ queued: 2, dropped_count: 1, error_count: 0 });

    scheduled.shift()?.();
    await sink.flush();

    expect(writes.map((record) => record.id)).toEqual(["chat-ok-2", "plan-failed"]);
  });

  it("AsyncDiagnosticSink（异步诊断汇点） 写入失败不应阻塞 flush（刷盘），但要记录 error_count（错误数）", async () => {
    const sink = createAsyncDiagnosticSink({
      maxQueueSize: 2,
      write: async () => {
        throw new Error("disk unavailable");
      },
    });

    sink.enqueue("chat-ok");

    await expect(sink.flush()).resolves.toMatchObject({
      queued: 0,
      in_flight: false,
      dropped_count: 0,
      error_count: 1,
    });
  });

  const createRuntimeSandboxRequest = (input: {
    code: string;
    messageId?: string;
    resourceLimits?: Parameters<typeof createSandboxResourceLimits>[0];
  }) =>
    createSandboxExecutionRequest({
      job_id: input.messageId ?? "T-027",
      bot_id: "bot-027",
      intent_epoch: 1,
      snapshot_ts: 1_712_930_001,
      code: input.code,
      log_ref: createSandboxLogRef({
        date: "2026-04-13",
        job_id: input.messageId ?? "T-027",
      }),
      resource_limits: input.resourceLimits,
    });

  it("legacy/test-only：应让旧 Facade API 写动作覆盖已启用技能与放置工具链", () => {
    const facadeContract = createSandboxFacadeContract();

    expect(Object.keys(facadeContract)).toEqual([...SANDBOX_FACADE_SECTIONS]);
    expect(Object.keys(facadeContract.bot)).toEqual([...SANDBOX_BOT_METHOD_NAMES]);
    expect(SANDBOX_BOT_SKILL_BINDINGS.goTo).toBe("goTo");
    expect(facadeContract.bot.mine.aligned_skill).toBe("mine");
    expect(facadeContract.bot.place.aligned_skill).toBeUndefined();
    expect(facadeContract.chat.report.emits_step).toBe(true);
    expect(SANDBOX_READONLY_SECTIONS).toEqual(["world", "knowledge", "memory", "owner", "task"]);
  });

  it("legacy/test-only：应声明旧 Facade 工具链能力契约", () => {
    const facadeContract = createSandboxFacadeContract();

    expect(SANDBOX_TOOLCHAIN_CAPABILITY_NAMES).toEqual([
      "craft",
      "place",
      "equip",
      "mine",
      "ensure",
    ]);
    expect(SANDBOX_FORBIDDEN_DEMO_METHOD_NAMES).toEqual(["demoMineIron"]);
    expect(SANDBOX_TOOLCHAIN_CAPABILITY_NAMES).not.toContain("demoMineIron");
    expect(SANDBOX_TOOLCHAIN_FAILURE_CODES).toEqual(
      expect.arrayContaining(["missing_materials", "cannot_place", "unsafe_path"]),
    );
    expect(Object.keys(facadeContract.bot)).toEqual([...SANDBOX_BOT_METHOD_NAMES]);
    expect(facadeContract.bot).toHaveProperty("craft");
    expect(facadeContract.bot).toHaveProperty("place");
    expect(facadeContract.bot).toHaveProperty("ensure");
  });

  it("legacy/test-only：应提供旧 Facade 渐进披露索引", () => {
    const index = createSandboxFacadePromptIndex();
    const botDescription = describeFacadeNamespace("bot");

    expect(index).toContain("Facade namespaces");
    expect(index).toContain("describe(namespace)");
    expect(index).not.toContain("goTo(x,y,z)");
    expect(botDescription).toContain("goTo");
    expect(describeFacadeNamespace("task")).toContain("userMessage");
  });

  it("legacy/test-only：应按 token 预算维护旧 Facade LRU 热队列", () => {
    const botBudget = Math.ceil(describeFacadeNamespace("bot").length / 4) + 1;
    const chatBudget = Math.ceil(describeFacadeNamespace("chat").length / 4) + 1;
    const bothBudget = botBudget + chatBudget + 4;
    const withBot = updateSandboxFacadeHotNamespaceQueue({
      namespace: "bot",
      budget_tokens: bothBudget,
    });
    const withChat = updateSandboxFacadeHotNamespaceQueue({
      queue: withBot,
      namespace: "chat",
      budget_tokens: bothBudget,
    });
    const refreshedBot = updateSandboxFacadeHotNamespaceQueue({
      queue: withChat,
      namespace: "bot",
      budget_tokens: bothBudget,
    });
    const trimmed = updateSandboxFacadeHotNamespaceQueue({
      queue: refreshedBot,
      namespace: "task",
      budget_tokens: chatBudget,
    });

    expect(withChat.entries.map((entry) => entry.namespace)).toEqual(["bot", "chat"]);
    expect(refreshedBot.entries.map((entry) => entry.namespace)).toEqual(["chat", "bot"]);
    expect(trimmed.total_tokens).toBeLessThanOrEqual(chatBudget);
    expect(trimmed.entries.at(-1)?.namespace).toBe("task");
    expect(() =>
      updateSandboxFacadeHotNamespaceQueue({
        namespace: "bot",
        budget_tokens: 0,
      }),
    ).toThrow(/budget_tokens/);
  });

  it("应在 isolated-vm（隔离虚拟机） 内执行 chat.say（聊天输出） 并记录步骤", async () => {
    const messages: string[] = [];
    const result = await executeCodeRequest({
      request: createRuntimeSandboxRequest({
        code: "await reply('hello sandbox')",
      }),
      hostBridge: {
        async executeBotSkill() {
          throw new Error("skill should not run");
        },
        async writeChat(_method, params) {
          messages.push(params.message);

          return { delivered: true };
        },
      },
    });

    expect(result.status).toBe(TaskHistoryStatus.Completed);
    expect(messages).toEqual(["hello sandbox"]);
    expect(result.step_results).toMatchObject([
      {
        action: "say",
        status: "ok",
        params: { message: "hello sandbox" },
      },
    ]);
  });

  it("应只暴露顶层语义对象且不泄漏旧 api 或 host bridge", async () => {
    const result = await executeCodeRequest({
      request: createRuntimeSandboxRequest({
        code: [
          "if (typeof api !== 'undefined') { throw new Error('legacy api leaked') }",
          "(function () {",
          "  const hostName = '__' + 'sandbox' + 'HostCall'",
          "  if (typeof this[hostName] !== 'undefined') { throw new Error('host leaked') }",
          "})()",
          "if (typeof owner !== 'object') { throw new Error('owner missing') }",
        ].join("\n"),
        messageId: "task-readonly",
      }),
      task: {
        id: "task-readonly",
        userMessage: "读任务上下文",
        intent: "code",
      },
      hostBridge: {
        async executeBotSkill() {
          throw new Error("skill should not run");
        },
        async writeChat() {
          throw new Error("chat should not run");
        },
      },
    });

    expect(result.status).toBe(TaskHistoryStatus.Completed);
    expect(result.step_results).toEqual([]);
  });

  it("应注入顶层 Semantic API（语义接口） 并桥接 owner（主人） 与 search（检索） 只读能力", async () => {
    const botCalls: unknown[] = [];
    const chatCalls: unknown[] = [];
    const searchCalls: unknown[] = [];
    const result = await executeCodeRequest({
      request: createRuntimeSandboxRequest({
        code: `
          await reply('收到，我按语义 API 执行喵~');
          try { owner.position.x = 99 } catch {}
          try { owner = { position: { x: 99, y: 1, z: 1 } } } catch {}
          if (owner.position.x !== 8) { throw new Error('owner mutated') }
          const memory = await search('基地坐标', 2);
          if (memory.hits[0].task_id !== 'task-base') { throw new Error('bad search') }
          const mined = await ensure(async () => mine('iron_ore', 1), until.gained('raw_iron', 1));
          if (!mined.ok) { await report('挖铁失败喵~'); throw new Error('mine failed') }
          await report('语义 API 执行完成喵~');
        `,
        messageId: "T-068-semantic-api",
      }),
      task: {
        id: "T-068-semantic-api",
        userMessage: "挖铁矿",
        intent: "code",
        owner: {
          online: true,
          position: { x: 8, y: 64, z: 2 },
        },
      },
      hostBridge: {
        ...createSatisfiedConditionFacade(),
        async executeBotSkill(skill, params) {
          botCalls.push({ skill, params });

          return { ok: true, data: { completed_count: 1, world_key: "minecraft:overworld" } };
        },
        async executeToolchainCapability(capability, params) {
          botCalls.push({ capability, params });

          return {
            ok: true,
            data: {
              item_name: "stone_pickaxe",
              completed_count: 1,
              world_key: "minecraft:overworld",
            },
          };
        },
        async writeChat(method, params) {
          chatCalls.push({ method, params });

          return { delivered: true };
        },
        async searchMemory(input) {
          searchCalls.push(input);

          return {
            hits: [
              {
                task_id: "task-base",
                owner_text: "这里是基地",
              },
            ],
          };
        },
      },
    });

    expect(result.status).toBe(TaskHistoryStatus.Completed);
    expect(chatCalls).toEqual([
      { method: "say", params: { message: "收到，我按语义 API 执行喵~" } },
      { method: "report", params: { message: "语义 API 执行完成喵~" } },
    ]);
    expect(searchCalls).toEqual([{ bot_id: "bot-027", query: "基地坐标", limit: 2 }]);
    expect(botCalls).toEqual([{ skill: "mine", params: { blockName: "iron_ore", count: 1 } }]);
    expect(result.step_results).toMatchObject([
      { action: "say", status: "ok" },
      { action: "mine", status: "ok" },
      { action: "report", status: "ok" },
    ]);
  });

  it("应通过 runGoal + report(task) 记录目标终态事实且不直接发送最终聊天", async () => {
    const chatCalls: unknown[] = [];
    const result = await executeCodeRequest({
      request: createRuntimeSandboxRequest({
        code: `
          await reply('收到，我去挖石头喵~');
          const task = await runGoal('挖 2 个石头', async () => {
            const mined = await ensure(
              async () => mine('stone', 2),
              until.gained('cobblestone', 2),
            );
            if (mined.ok === false) { throw new Error(mined.error.code) }
          });
          await report(task);
        `,
        messageId: "T-070-goal-report",
      }),
      hostBridge: {
        ...createSatisfiedConditionFacade(),
        async executeBotSkill(skill, params) {
          return {
            skill,
            block_name: "stone",
            collected_item_name: "cobblestone",
            collected_count: params.count,
            world_key: "minecraft:overworld",
          };
        },
        async executeToolchainCapability() {
          throw new Error("ensure recovery should not run");
        },
        async writeChat(method, params) {
          chatCalls.push({ method, params });

          return { delivered: true };
        },
      },
    });

    expect(result.status).toBe(TaskHistoryStatus.Completed);
    expect(chatCalls).toEqual([{ method: "say", params: { message: "收到，我去挖石头喵~" } }]);
    expect(result.step_results.at(-1)).toMatchObject({
      action: "report",
      status: "ok",
      params: {
        message: "",
        goal_result: {
          kind: "goal_result",
          ok: true,
          name: "挖 2 个石头",
          condition: { kind: "gained", itemName: "cobblestone", count: 2 },
          summary: {
            target: "cobblestone",
            requested_count: 2,
            completed_count: 2,
            inventory_delta: [{ item_name: "cobblestone", count: 2 }],
            world_key: "minecraft:overworld",
          },
        },
      },
    });

    const summary = createTaskResultSummaryFromSandboxResult(
      createCodeJob({
        message_id: "T-070-goal-report",
        intent_epoch: 1,
        snapshot_ts: 1,
        priority: ExecPriority.Normal,
        code: "code",
      }),
      result,
    );
    expect(summary).toMatchObject({
      operation: "挖 2 个石头",
      status: "completed",
      target: "cobblestone",
      requested_count: 2,
      completed_count: 2,
      inventory_delta: [{ item_name: "cobblestone", count: 2 }],
      world_key: "minecraft:overworld",
    });
  });

  it("report(task) 应拒绝缺 completed_count 的成功 GoalResult", async () => {
    const result = await executeCodeRequest({
      request: createRuntimeSandboxRequest({
        code: `
          await report({
            kind: 'goal_result',
            ok: true,
            name: '空成功摘要',
            duration_ms: 1,
            summary: {},
          });
        `,
        messageId: "T-098-report-empty-success-summary",
      }),
      hostBridge: {
        async executeBotSkill() {
          throw new Error("skill should not run");
        },
        async writeChat() {
          throw new Error("chat should not run");
        },
      },
    });

    expect(result.status).toBe(TaskHistoryStatus.Failed);
    expect(result.step_results).toEqual([]);
    expect(result.error).toMatchObject({
      name: "UnhandledError",
      message: "GoalResult.summary.completed_count must be finite",
    });
  });

  it("runGoal 应聚合多动作目标里的背包增量并保留最终世界事实", async () => {
    const result = await executeCodeRequest({
      request: createRuntimeSandboxRequest({
        code: `
          await reply('收到，我去砍木头、挖石头并回来喵~');
          const task = await runGoal('砍木头、挖石头并返回主人身边', async () => {
            const wood = await cutTree(20);
            if (wood.ok === false) { throw new Error(wood.error.code) }
            const stone = await ensure(
              async () => mine('stone', 5),
              until.gained('cobblestone', 5),
            );
            if (stone.ok === false) { throw new Error(stone.error.code) }
            const p = owner.position;
            if (!p) { throw new Error('owner_position_missing') }
            await goTo(p.x, p.y, p.z);
          });
          await report(task);
        `,
        messageId: "T-070-multi-goal-report",
      }),
      task: {
        id: "T-070-multi-goal-report",
        userMessage: "砍20个木头，然后去挖5个石头，最后回到我这",
        intent: "code",
        owner: {
          online: true,
          position: { x: 1, y: 64, z: 2 },
        },
      },
      hostBridge: {
        ...createSatisfiedConditionFacade(),
        async executeBotSkill(skill, params) {
          if (skill === "cutTree") {
            return {
              skill: "cutTree",
              requested_count: params.count,
              collected_count: params.count,
              clusters: [{ log_block_name: "oak_log", collected_count: params.count }],
              world_key: "multiworld:resource",
            };
          }
          if (skill === "mine") {
            return {
              skill: "mine",
              block_name: "stone",
              collected_item_name: "cobblestone",
              collected_count: params.count,
              world_key: "multiworld:resource",
            };
          }
          if (skill === "goTo") {
            return {
              skill: "goTo",
              target: params,
              reached: true,
              world_key: "multiworld:resource",
            };
          }

          throw new Error(`unexpected skill ${skill}`);
        },
        async executeToolchainCapability() {
          throw new Error("ensure recovery should not run");
        },
        async writeChat() {
          return { delivered: true };
        },
      },
    });

    expect(result.status).toBe(TaskHistoryStatus.Completed);
    expect(result.step_results.at(-1)).toMatchObject({
      action: "report",
      params: {
        goal_result: {
          kind: "goal_result",
          ok: true,
          name: "砍木头、挖石头并返回主人身边",
          summary: {
            completed_count: 25,
            inventory_delta: [
              { item_name: "oak_log", count: 20 },
              { item_name: "cobblestone", count: 5 },
            ],
            world_key: "multiworld:resource",
          },
        },
      },
    });

    const summary = createTaskResultSummaryFromSandboxResult(
      createCodeJob({
        message_id: "T-070-multi-goal-report",
        intent_epoch: 1,
        snapshot_ts: 1,
        priority: ExecPriority.Normal,
        code: "code",
      }),
      result,
    );
    expect(summary).toMatchObject({
      operation: "砍木头、挖石头并返回主人身边",
      completed_count: 25,
      inventory_delta: [
        { item_name: "oak_log", count: 20 },
        { item_name: "cobblestone", count: 5 },
      ],
      world_key: "multiworld:resource",
    });
  });

  it("应让 report(task) 记录失败 GoalResult 后使任务进入 failed 终态", async () => {
    const result = await executeCodeRequest({
      request: createRuntimeSandboxRequest({
        code: `
          const task = await runGoal('挖铁矿', async () => {
            const mined = await ensure(
              async () => mine('iron_ore', 1),
              until.gained('raw_iron', 1),
            );
            if (mined.ok === false) { throw new Error(mined.error.code) }
          });
          await report(task);
        `,
        messageId: "T-070-goal-failed",
      }),
      hostBridge: {
        ...createSatisfiedConditionFacade(),
        async executeBotSkill() {
          const error = new Error("not_equipped");
          throw Object.assign(error, {
            error_code: "not_equipped",
            details: {
              failure_stage: "mine",
              world_key: "minecraft:overworld",
              target_progress: {
                action: "mine",
                target: "raw_iron",
                requested_count: 1,
                completed_count: 0,
              },
            },
          });
        },
        async executeToolchainCapability() {
          return {
            ok: false,
            error: {
              code: "not_equipped",
              message: "not_equipped",
              details: {
                failure_stage: "mine",
                world_key: "minecraft:overworld",
                target_progress: {
                  action: "mine",
                  target: "raw_iron",
                  requested_count: 1,
                  completed_count: 0,
                },
              },
            },
          };
        },
        async writeChat() {
          throw new Error("goal report should not chat");
        },
      },
    });

    expect(result.status).toBe(TaskHistoryStatus.Failed);
    expect(result.step_results.at(-1)).toMatchObject({
      action: "report",
      status: "ok",
      params: {
        goal_result: {
          ok: false,
          failure: {
            failure_code: "not_equipped",
            failure_stage: "mine",
          },
        },
      },
    });

    const summary = createTaskResultSummaryFromSandboxResult(
      createCodeJob({
        message_id: "T-070-goal-failed",
        intent_epoch: 1,
        snapshot_ts: 1,
        priority: ExecPriority.Normal,
        code: "code",
      }),
      result,
    );
    expect(summary).toMatchObject({
      operation: "挖铁矿",
      status: "failed",
      target: "raw_iron",
      requested_count: 1,
      completed_count: 0,
      world_key: "minecraft:overworld",
      failure: {
        failure_code: "not_equipped",
        recoverable: true,
      },
    });
  });

  it("应让 code（沙箱代码） 调用 place（放置） 工作台工具链能力", async () => {
    const calls: unknown[] = [];
    const result = await executeCodeRequest({
      request: createRuntimeSandboxRequest({
        code: "await place('crafting_table')",
        messageId: "T-056-place",
      }),
      hostBridge: {
        async executeBotSkill() {
          throw new Error("unexpected skill call");
        },
        async executeToolchainCapability(capability, params) {
          calls.push({ capability, params });

          return {
            ok: true,
            data: {
              block_name: "crafting_table",
              completed_count: 1,
              world_key: "minecraft:overworld",
            },
          };
        },
        async writeChat() {
          throw new Error("unexpected chat call");
        },
      },
    });

    expect(result.status).toBe(TaskHistoryStatus.Completed);
    expect(calls).toEqual([{ capability: "place", params: { blockName: "crafting_table" } }]);
    expect(result.step_results).toMatchObject([
      {
        action: "place",
        status: "ok",
      },
    ]);
  });

  it("应让 code（沙箱代码） 通过 place('crafting_table') 放置工作台", async () => {
    const calls: unknown[] = [];
    const result = await executeCodeRequest({
      request: createRuntimeSandboxRequest({
        code: "await place('crafting_table')",
        messageId: "T-061-place-table",
      }),
      hostBridge: {
        async executeBotSkill() {
          throw new Error("unexpected skill call");
        },
        async executeToolchainCapability(capability, params) {
          calls.push({ capability, params });

          return {
            ok: true,
            data: {
              block_name: "crafting_table",
              completed_count: 1,
              world_key: "minecraft:overworld",
            },
          };
        },
        async writeChat() {
          throw new Error("unexpected chat call");
        },
      },
    });

    expect(result.status).toBe(TaskHistoryStatus.Completed);
    expect(calls).toEqual([{ capability: "place", params: { blockName: "crafting_table" } }]);
    expect(result.step_results).toMatchObject([
      {
        action: "place",
        status: "ok",
      },
    ]);
  });

  it("应拒绝旧 api.bot / api.chat 执行面", async () => {
    const facade = {
      async executeBotSkill() {
        throw new Error("skill should not run");
      },
      async writeChat() {
        throw new Error("chat should not run");
      },
    };
    const apiVisibility = await executeCodeRequest({
      request: createRuntimeSandboxRequest({
        code: "if (typeof api !== 'undefined') { throw new Error('legacy api leaked') }",
        messageId: "T-083-api-undefined",
      }),
      facade,
    });
    const botApi = await executeCodeRequest({
      request: createRuntimeSandboxRequest({
        code: "await api.bot.mine('stone', 1)",
        messageId: "T-083-api-bot",
      }),
      facade,
    });
    const chatApi = await executeCodeRequest({
      request: createRuntimeSandboxRequest({
        code: "await api.chat.report('done')",
        messageId: "T-083-api-chat",
      }),
      facade,
    });

    expect(apiVisibility.status).toBe(TaskHistoryStatus.Completed);
    expect(botApi.status).toBe(TaskHistoryStatus.Failed);
    expect(botApi.error.name).toBe("UnhandledError");
    expect(chatApi.status).toBe(TaskHistoryStatus.Failed);
    expect(chatApi.error.name).toBe("UnhandledError");
  });

  it("应让 code（沙箱代码） 调用 craft（合成） 工具链能力", async () => {
    const calls: unknown[] = [];
    const result = await executeCodeRequest({
      request: createRuntimeSandboxRequest({
        code: "await craft('wooden_pickaxe', 1)",
        messageId: "T-055-craft",
      }),
      hostBridge: {
        async executeBotSkill() {
          throw new Error("unexpected skill call");
        },
        async executeToolchainCapability(capability, params) {
          calls.push({ capability, params });

          return {
            ok: true,
            data: {
              item_name: "wooden_pickaxe",
              completed_count: 1,
              world_key: "minecraft:overworld",
            },
          };
        },
        async writeChat() {
          throw new Error("unexpected chat call");
        },
      },
    });

    expect(result.status).toBe(TaskHistoryStatus.Completed);
    expect(calls).toEqual([
      { capability: "craft", params: { itemName: "wooden_pickaxe", count: 1 } },
    ]);
    expect(result.step_results).toMatchObject([
      {
        action: "craft",
        status: "ok",
      },
    ]);
  });

  it("应让 code（沙箱代码） 调用 ensure（确保） 工具链能力", async () => {
    const calls: unknown[] = [];
    let mineCalls = 0;
    const result = await executeCodeRequest({
      request: createRuntimeSandboxRequest({
        code: "await ensure(async () => mine('iron_ore', 1), until.gained('raw_iron', 1))",
        messageId: "T-060-ensure",
      }),
      hostBridge: {
        captureConditionState: createSatisfiedConditionFacade().captureConditionState,
        evaluateCondition(input) {
          const targetCount = typeof input.condition.count === "number" ? input.condition.count : 1;
          return {
            ok: mineCalls > 1,
            condition: input.condition,
            completed_count: mineCalls > 1 ? targetCount : 0,
            target_count: targetCount,
            missing_count: mineCalls > 1 ? 0 : targetCount,
            resolved_targets: ["raw_iron"],
            baseline: input.baseline,
            current: input.current,
          };
        },
        async executeBotSkill() {
          mineCalls += 1;
          if (mineCalls === 1) {
            throw Object.assign(new Error("not_equipped:iron_ore:requires_stone_pickaxe"), {
              error_code: "not_equipped",
            });
          }

          return { skill: "mine", total_steps: 1, collected_count: 1 };
        },
        async executeToolchainCapability(capability, params) {
          calls.push({ capability, params });

          return {
            ok: true,
            data: {
              item_name: "stone_pickaxe",
              completed_count: 1,
              target_count: 1,
              world_key: "minecraft:overworld",
              actions: [],
            },
          };
        },
        async writeChat() {
          throw new Error("unexpected chat call");
        },
      },
    });

    expect(result.status).toBe(TaskHistoryStatus.Completed);
    expect(calls).toEqual([
      {
        capability: "ensure",
        params: {
          failure: expect.objectContaining({
            action: "mine",
            code: "not_equipped",
          }),
          condition: { kind: "gained", itemName: "raw_iron", count: 1 },
        },
      },
    ]);
    expect(result.step_results).toMatchObject([
      {
        action: "mine",
        status: "err",
      },
      {
        action: "ensure",
        status: "ok",
      },
      {
        action: "mine",
        status: "ok",
      },
    ]);
  });

  it("ensure（确保） 应在 gainedDropOf action 前先触发采掘工具预检", async () => {
    const calls: string[] = [];
    const result = await executeCodeRequest({
      request: createRuntimeSandboxRequest({
        code: `
          const task = await runGoal('预检后挖石头', async () => {
            await ensure(async () => { await mine('stone', 5); }, until.gainedDropOf('stone', 5));
          });
          await report(task);
        `,
        messageId: "T-081-preflight-mine-equipment",
      }),
      hostBridge: {
        captureConditionState: createSatisfiedConditionFacade().captureConditionState,
        evaluateCondition: createSatisfiedConditionFacade().evaluateCondition,
        async executeBotSkill(skill) {
          calls.push(`skill:${skill}`);
          return { skill, total_steps: 1, collected_count: 5 };
        },
        async executeToolchainCapability(capability, params) {
          calls.push(`toolchain:${capability}`);
          return {
            ok: true,
            data: {
              item_name: "wooden_pickaxe",
              completed_count: 1,
              target_count: 1,
              world_key: "minecraft:overworld",
              params,
              actions: [],
            },
          };
        },
        async writeChat() {
          throw new Error("goal report should not chat");
        },
      },
    });

    expect(result.status).toBe(TaskHistoryStatus.Completed);
    expect(calls).toEqual(["toolchain:ensure", "skill:mine"]);
    expect(result.step_results.slice(0, 2)).toMatchObject([
      {
        action: "ensure",
        params: {
          failure: expect.objectContaining({
            code: "preflight_mine_equipment",
            params: { blockName: "stone", count: 5 },
          }),
          condition: { kind: "gainedDropOf", blockName: "stone", count: 5 },
        },
        status: "ok",
      },
      {
        action: "mine",
        status: "ok",
      },
    ]);
  });

  it("直接 mine（挖掘） 少拿到目标掉落物时不得汇报成功", async () => {
    const result = await executeCodeRequest({
      request: createRuntimeSandboxRequest({
        code: `
          const task = await runGoal('强语义挖掘', async () => {
            await mine('target_block', 5);
          });
          await report(task);
        `,
        messageId: "T-085-mine-direct-insufficient",
      }),
      hostBridge: {
        async executeBotSkill() {
          return {
            skill: "mine",
            block_name: "target_block",
            collected_item_name: "runtime_drop",
            collected_count: 3,
            mined_count: 3,
            total_steps: 1,
            world_key: "minecraft:overworld",
            diagnostics: ["test_runtime_drop_shortfall"],
          };
        },
        async writeChat() {
          throw new Error("goal report should not chat");
        },
      },
    });

    expect(result.status).toBe(TaskHistoryStatus.Failed);
    expect(result.step_results.at(-1)).toMatchObject({
      action: "report",
      params: {
        goal_result: {
          ok: false,
          failure: {
            failure_code: "condition_not_met",
            details: {
              target_progress: {
                action: "mine",
                target: "target_block",
                requested_count: 5,
                completed_count: 3,
              },
            },
          },
        },
      },
    });
  });

  it("直接 mine（挖掘） 返回 ok 但缺少完成证明时应转为 unknown_completion", async () => {
    const result = await executeCodeRequest({
      request: createRuntimeSandboxRequest({
        code: `
          const task = await runGoal('缺证明挖掘', async () => {
            await mine('target_block', 2);
          });
          await report(task);
        `,
        messageId: "T-085-mine-unknown-completion",
      }),
      hostBridge: {
        async executeBotSkill() {
          return {
            ok: true,
            data: {
              skill: "mine",
              block_name: "target_block",
              world_key: "minecraft:overworld",
            },
          };
        },
        async writeChat() {
          throw new Error("goal report should not chat");
        },
      },
    });

    expect(result.status).toBe(TaskHistoryStatus.Failed);
    expect(result.step_results.at(-1)).toMatchObject({
      action: "report",
      params: {
        goal_result: {
          ok: false,
          failure: {
            failure_code: "unknown_completion",
            details: {
              reason: "mine result lacks inventory completion proof",
            },
          },
        },
      },
    });
    const summary = createTaskResultSummaryFromSandboxResult(
      createCodeJob({
        message_id: "T-085-mine-unknown-completion",
        intent_epoch: 1,
        snapshot_ts: 1,
        priority: ExecPriority.Normal,
        code: "code",
      }),
      result,
    );
    expect(summary).toMatchObject({
      status: "failed",
      failure: {
        failure_code: "unknown_completion",
      },
    });
  });

  it("sandbox skill 兼容摘要路径不得把缺 proof 的 mine / collect 包装成完成", () => {
    const sandboxJob = createCodeJob({
      message_id: "T-088-summary-proof",
      intent_epoch: 1,
      snapshot_ts: 1,
      priority: ExecPriority.Normal,
      code: "code",
    });
    const createCompletedSandboxResult = (resultRecord: Readonly<Record<string, unknown>>) =>
      ({
        status: TaskHistoryStatus.Completed,
        summary: { total_steps: 1, duration_ms: 1 },
        step_results: [
          {
            action: resultRecord.skill,
            status: "ok",
            params: {},
            result: resultRecord,
          },
        ],
      }) as unknown as Parameters<typeof createTaskResultSummaryFromSandboxResult>[1];

    expect(
      createTaskResultSummaryFromSandboxResult(
        sandboxJob,
        createCompletedSandboxResult({ skill: "mine", block_name: "stone" }),
      ),
    ).toMatchObject({
      status: "failed",
      failure: { failure_code: "unknown_completion" },
      details: { missing_fields: ["collected_item_name", "collected_count", "mined_count"] },
    });
    expect(
      createTaskResultSummaryFromSandboxResult(
        sandboxJob,
        createCompletedSandboxResult({
          skill: "mine",
          block_name: "stone",
          collected_item_name: "cobblestone",
          collected_count: 5,
          mined_count: 5,
          world_key: "minecraft:overworld",
        }),
      ),
    ).toMatchObject({
      status: "completed",
      operation: "mine",
      target: "stone",
      completed_count: 5,
      inventory_delta: [{ item_name: "cobblestone", count: 5 }],
      world_key: "minecraft:overworld",
    });
    expect(
      createTaskResultSummaryFromSandboxResult(
        sandboxJob,
        createCompletedSandboxResult({
          skill: "collect",
          item_name: null,
          collected: [{ name: "oak_log", count: 2 }],
        }),
      ),
    ).toMatchObject({
      status: "completed",
      operation: "collect",
      target: "all_items",
      completed_count: 2,
      inventory_delta: [{ item_name: "oak_log", count: 2 }],
    });
    expect(
      createTaskResultSummaryFromSandboxResult(
        sandboxJob,
        createCompletedSandboxResult({ skill: "collect", item_name: null }),
      ),
    ).toMatchObject({
      status: "failed",
      failure: { failure_code: "unknown_completion" },
      details: { missing_fields: ["collected"] },
    });
  });

  it("sandbox code 正常结束但没有 report/toolchain/skill proof 时不得包装成完成", () => {
    const sandboxJob = createCodeJob({
      message_id: "T-100-summary-no-completion-proof",
      intent_epoch: 1,
      snapshot_ts: 1,
      priority: ExecPriority.Normal,
      code: "await sleep(1)",
    });
    const result = {
      status: TaskHistoryStatus.Completed,
      summary: { total_steps: 1, duration_ms: 1 },
      step_results: [
        {
          action: "sleep",
          status: "ok",
          params: {},
          result: { ok: true },
        },
      ],
    } as unknown as Parameters<typeof createTaskResultSummaryFromSandboxResult>[1];

    expect(createTaskResultSummaryFromSandboxResult(sandboxJob, result)).toMatchObject({
      status: "failed",
      operation: "sleep",
      completed_count: 0,
      failure: {
        failure_code: "unknown_completion",
        failure_stage: "sleep",
        message: "sandbox result lacks completion proof",
        recoverable: false,
      },
      details: {
        reason: "completed sandbox result lacks report/toolchain/skill completion proof",
        total_steps: 1,
      },
    });
  });

  it("sandbox terminal failure 缺显式 recoverable 时应使用统一失败分类口径", () => {
    const sandboxJob = createCodeJob({
      message_id: "T-093-terminal-recoverable",
      intent_epoch: 1,
      snapshot_ts: 1,
      priority: ExecPriority.Normal,
      code: "code",
    });
    const createFailedSandboxResult = (errorCode: string) =>
      ({
        status: TaskHistoryStatus.Failed,
        summary: { total_steps: 1, duration_ms: 1 },
        step_results: [
          {
            action: "mine",
            status: "error",
            params: { blockName: "stone", count: 1 },
            error: {
              error_code: errorCode,
              message: `${errorCode}:stone`,
              details: {
                failure_stage: "mine",
                target_progress: {
                  action: "mine",
                  target: "stone",
                  requested_count: 1,
                  completed_count: 0,
                },
              },
            },
          },
        ],
        error: {
          error_code: errorCode,
          message: `${errorCode}:stone`,
          details: {
            failure_stage: "mine",
            target_progress: {
              action: "mine",
              target: "stone",
              requested_count: 1,
              completed_count: 0,
            },
          },
        },
      }) as unknown as Parameters<typeof createTaskResultSummaryFromSandboxResult>[1];

    expect(
      createTaskResultSummaryFromSandboxResult(
        sandboxJob,
        createFailedSandboxResult("not_equipped"),
      ),
    ).toMatchObject({
      status: "failed",
      failure: {
        failure_code: "not_equipped",
        recoverable: true,
      },
    });
    expect(
      createTaskResultSummaryFromSandboxResult(
        sandboxJob,
        createFailedSandboxResult("unknown_completion"),
      ),
    ).toMatchObject({
      status: "failed",
      failure: {
        failure_code: "unknown_completion",
        recoverable: false,
      },
    });
  });

  it("cutTree（砍树） count 以原木获得数量为准，少拿到原木必须失败", async () => {
    const result = await executeCodeRequest({
      request: createRuntimeSandboxRequest({
        code: `
          const task = await runGoal('强语义砍树', async () => {
            await cutTree(5);
          });
          await report(task);
        `,
        messageId: "T-085-cut-tree-insufficient",
      }),
      hostBridge: {
        async executeBotSkill() {
          return {
            skill: "cutTree",
            requested_count: 5,
            collected_count: 4,
            completed: false,
            status: "insufficient",
            world_key: "minecraft:overworld",
            clusters: [{ cluster_id: "tree-1", log_block_name: "runtime_log", collected_count: 4 }],
            diagnostics: ["test_cut_tree_shortfall"],
            total_steps: 1,
          };
        },
        async writeChat() {
          throw new Error("goal report should not chat");
        },
      },
    });

    expect(result.status).toBe(TaskHistoryStatus.Failed);
    expect(result.step_results.at(-1)).toMatchObject({
      action: "report",
      params: {
        goal_result: {
          ok: false,
          failure: {
            failure_code: "condition_not_met",
            details: {
              target_progress: {
                action: "cutTree",
                target: "runtime_log",
                requested_count: 5,
                completed_count: 4,
              },
            },
          },
        },
      },
    });
  });

  it("ensure（确保） 应在 action 成功但 condition 不满足时返回结构化失败", async () => {
    const result = await executeCodeRequest({
      request: createRuntimeSandboxRequest({
        code: `
          const task = await runGoal('检查条件', async () => {
            await ensure(async () => { await collect(); }, until.has('cobblestone', 1));
          });
          await report(task);
        `,
        messageId: "T-081-condition-not-met",
      }),
      hostBridge: {
        captureConditionState: createSatisfiedConditionFacade().captureConditionState,
        evaluateCondition(input) {
          return createTestConditionEvaluation(input, 0, 1);
        },
        async executeBotSkill() {
          return { skill: "collect", collected: [], skipped: [], total_steps: 1 };
        },
        async executeToolchainCapability() {
          return {
            ok: false,
            error: {
              code: "condition_not_met",
              message: "condition_not_met",
              world_key: "minecraft:overworld",
            },
          };
        },
        async writeChat() {
          throw new Error("goal report should not chat");
        },
      },
    });

    expect(result.status).toBe(TaskHistoryStatus.Failed);
    expect(result.step_results.at(-1)).toMatchObject({
      action: "report",
      params: {
        goal_result: {
          ok: false,
          failure: {
            failure_code: "condition_not_met",
          },
        },
      },
    });
  });

  it("ensure（确保） 应在恢复后重新检查 condition 并成功", async () => {
    const calls: unknown[] = [];
    let evaluations = 0;
    const result = await executeCodeRequest({
      request: createRuntimeSandboxRequest({
        code: "const task = await runGoal('恢复后满足', async () => { await ensure(async () => { await collect(); }, until.has('cobblestone', 1)); }); await report(task);",
        messageId: "T-081-condition-recovered",
      }),
      hostBridge: {
        captureConditionState: createSatisfiedConditionFacade().captureConditionState,
        evaluateCondition(input) {
          evaluations += 1;
          return createTestConditionEvaluation(input, evaluations >= 2 ? 1 : 0, 1);
        },
        async executeBotSkill() {
          return { skill: "collect", collected: [], skipped: [], total_steps: 1 };
        },
        async executeToolchainCapability(capability, params) {
          calls.push({ capability, params });
          return {
            ok: true,
            data: { completed_count: 1, world_key: "minecraft:overworld", actions: [] },
          };
        },
        async writeChat() {
          throw new Error("goal report should not chat");
        },
      },
    });

    expect(result.status).toBe(TaskHistoryStatus.Completed);
    expect(calls).toEqual([
      {
        capability: "ensure",
        params: expect.objectContaining({
          failure: expect.objectContaining({ code: "condition_not_met" }),
        }),
      },
    ]);
  });

  it("runGoal 应保留 ensure 的最终资源条件证明，不被后续 goTo 动作稀释", async () => {
    const result = await executeCodeRequest({
      request: createRuntimeSandboxRequest({
        code: `
          const task = await runGoal('砍 5 个木头并返回主人身边', async () => {
            await ensure(async () => { await cutTree(5); }, until.gainedTag('logs', 5));
            await goTo(owner.position.x, owner.position.y, owner.position.z);
          });
          await report(task);
        `,
        messageId: "T-087-ensure-then-goto-summary",
      }),
      task: {
        id: "T-087-ensure-then-goto-summary",
        userMessage: "砍5个木头回来",
        intent: "code",
        owner: {
          online: true,
          position: { x: 8, y: 64, z: 2 },
        },
      },
      hostBridge: {
        captureConditionState: createSatisfiedConditionFacade().captureConditionState,
        evaluateCondition(input) {
          return createTestConditionEvaluation(input, 5, 5);
        },
        async executeBotSkill(skill) {
          if (skill === "cutTree") {
            return {
              skill: "cutTree",
              requested_count: 5,
              collected_count: 1,
              completed: true,
              status: "partial_action_summary",
              world_key: "minecraft:overworld",
              clusters: [
                { cluster_id: "tree-1", log_block_name: "runtime_log", collected_count: 1 },
              ],
              total_steps: 1,
            };
          }

          return {
            skill: "goTo",
            target: { x: 8, y: 64, z: 2 },
            reached: true,
            world_key: "minecraft:overworld",
            total_steps: 3,
            diagnostics: ["test_returned_to_owner"],
          };
        },
        async writeChat() {
          throw new Error("goal report should not chat");
        },
      },
    });

    expect(result.status).toBe(TaskHistoryStatus.Completed);
    expect(result.step_results.at(-1)).toMatchObject({
      action: "report",
      params: {
        goal_result: {
          ok: true,
          condition: {
            kind: "gainedTag",
            tagName: "logs",
            count: 5,
          },
          summary: {
            target: "logs",
            requested_count: 5,
            completed_count: 5,
            inventory_delta: [{ item_name: "logs", count: 5 }],
          },
        },
      },
    });
  });

  it("ensure（确保） 应在恢复后仍不满足 condition 时保留 condition_not_met 失败", async () => {
    const result = await executeCodeRequest({
      request: createRuntimeSandboxRequest({
        code: "const task = await runGoal('恢复后仍不满足', async () => { await ensure(async () => { await collect(); }, until.has('cobblestone', 1)); }); await report(task);",
        messageId: "T-081-condition-still-missing",
      }),
      hostBridge: {
        captureConditionState: createSatisfiedConditionFacade().captureConditionState,
        evaluateCondition(input) {
          return createTestConditionEvaluation(input, 0, 1);
        },
        async executeBotSkill() {
          return { skill: "collect", collected: [], skipped: [], total_steps: 1 };
        },
        async executeToolchainCapability() {
          return {
            ok: true,
            data: { completed_count: 1, world_key: "minecraft:overworld", actions: [] },
          };
        },
        async writeChat() {
          throw new Error("goal report should not chat");
        },
      },
    });

    expect(result.status).toBe(TaskHistoryStatus.Failed);
    expect(result.step_results.at(-1)).toMatchObject({
      action: "report",
      params: {
        goal_result: {
          ok: false,
          failure: {
            failure_code: "condition_not_met",
          },
        },
      },
    });
  });

  it("应把 place（放置） 工具链结构化失败升级为沙箱失败", async () => {
    const result = await executeCodeRequest({
      request: createRuntimeSandboxRequest({
        code: "await place('crafting_table')",
        messageId: "T-056-place-failed",
      }),
      hostBridge: {
        async executeBotSkill() {
          throw new Error("unexpected skill call");
        },
        async executeToolchainCapability() {
          return {
            ok: false,
            error: {
              code: "missing_materials",
              message: "Inventory does not contain enough recipe ingredients",
              world_key: "minecraft:overworld",
            },
          };
        },
        async writeChat() {
          throw new Error("unexpected chat call");
        },
      },
    });

    expect(result.status).toBe(TaskHistoryStatus.Failed);
    expect(result.error).toMatchObject({
      name: "FacadeCallError",
      error_code: "missing_materials",
    });
    expect(result.step_results[0]).toMatchObject({
      action: "place",
      status: "err",
    });
  });

  it("应拒绝 process / require / import / fetch 等沙箱逃逸入口", async () => {
    const forbiddenCases = [
      { code: "process.env", violation: "process" },
      { code: "require('fs')", violation: "require" },
      { code: "import('node:fs')", violation: "import" },
      { code: "globalThis.process", violation: "process" },
      { code: "await fetch('https://example.com')", violation: "network" },
      {
        code: "await __sandboxTryCall('bot.place', [{ blockName: 'crafting_table' }])",
        violation: "sandbox_internal_bridge",
      },
      {
        code: "await __sandboxHostCall('bot.mine', ['stone', 1])",
        violation: "sandbox_internal_bridge",
      },
      {
        code: "await __sandboxRead('memory.search', ['stone'])",
        violation: "sandbox_internal_bridge",
      },
    ] as const;

    for (const forbiddenCase of forbiddenCases) {
      const result = await executeCodeRequest({
        request: createRuntimeSandboxRequest({
          code: forbiddenCase.code,
          messageId: `forbidden-${forbiddenCase.violation}`,
        }),
        hostBridge: {
          async executeBotSkill() {
            throw new Error("skill should not run");
          },
          async writeChat() {
            throw new Error("chat should not run");
          },
        },
      });

      expect(result.status).toBe(TaskHistoryStatus.Failed);
      expect(result.error.name).toBe("StaticCheckError");
      expect(result.phase_logs[0]).toMatchObject({
        phase: "precheck",
        ok: false,
        violation: forbiddenCase.violation,
      });
    }
  });

  it("应把转译失败、脚本超时与 Facade（门面接口） 失败收口为结构化错误", async () => {
    const facade = {
      async executeBotSkill() {
        throw new Error("facade boom");
      },
      async writeChat() {
        throw new Error("chat boom");
      },
    };
    const transpileFailure = await executeCodeRequest({
      request: createRuntimeSandboxRequest({
        code: "const value: = 1",
        messageId: "T-027-transpile",
      }),
      facade,
    });
    const timeoutFailure = await executeCodeRequest({
      request: createRuntimeSandboxRequest({
        code: "while (true) {}",
        messageId: "T-027-timeout",
        resourceLimits: {
          timeout_ms: 30,
          script_timeout_ms: 10,
        },
      }),
      facade,
    });
    const facadeFailure = await executeCodeRequest({
      request: createRuntimeSandboxRequest({
        code: "await goTo(1, 64, 1)",
        messageId: "T-027-facade",
      }),
      facade,
    });

    expect(transpileFailure.status).toBe(TaskHistoryStatus.Failed);
    expect(transpileFailure.error.name).toBe("TranspileError");
    expect(timeoutFailure.status).toBe(TaskHistoryStatus.Failed);
    expect(timeoutFailure.error.name).toBe("SandboxTimeoutError");
    expect(facadeFailure.status).toBe(TaskHistoryStatus.Failed);
    expect(facadeFailure.error.name).toBe("FacadeCallError");
    expect(facadeFailure.step_results[0]?.error?.name).toBe("FacadeCallError");
  });

  it("应禁止沙箱代码吞掉 FacadeCallError（门面调用错误） 后伪装成功", async () => {
    const messages: string[] = [];
    const result = await executeCodeRequest({
      request: createRuntimeSandboxRequest({
        code: "try { await goTo(1, 64, 1) } catch { await reply('handled') }",
        messageId: "T-027-facade-catch",
      }),
      hostBridge: {
        async executeBotSkill() {
          throw new Error("goTo failed");
        },
        async writeChat(_method, params) {
          messages.push(params.message);

          return { delivered: true };
        },
      },
    });

    expect(result.status).toBe(TaskHistoryStatus.Failed);
    expect(result.error.name).toBe("FacadeCallError");
    expect(messages).toEqual([]);
    expect(result.step_results).toHaveLength(1);
    expect(result.step_results[0]).toMatchObject({
      action: "goTo",
      status: "err",
    });
  });

  it("应在总超时后阻止 Facade（门面接口） 调用继续产生聊天副作用", async () => {
    const messages: string[] = [];
    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    const result = await executeCodeRequest({
      request: createRuntimeSandboxRequest({
        code: "await reply('late side effect')",
        messageId: "T-027-timeout-side-effect",
        resourceLimits: {
          timeout_ms: 30,
          script_timeout_ms: 20,
          abort_cleanup_timeout_ms: 120,
        },
      }),
      hostBridge: {
        async executeBotSkill() {
          throw new Error("skill should not run");
        },
        async writeChat(_method, params, control) {
          await sleep(60);

          if (control?.signal.aborted !== true) {
            messages.push(params.message);
          }

          return { delivered: true };
        },
      },
    });

    expect(result.status).toBe(TaskHistoryStatus.Failed);
    expect(result.error.name).toBe("SandboxTimeoutError");
    expect(messages).toEqual([]);

    await sleep(80);

    expect(messages).toEqual([]);
  });

  it("应让 cutTree（砍树） 语义调用桥接到底层技能", async () => {
    const calls: unknown[] = [];
    const result = await executeCodeRequest({
      request: createRuntimeSandboxRequest({
        code: "await cutTree(1)",
        messageId: "T-027-cut-tree",
      }),
      hostBridge: {
        async executeBotSkill(skill, params) {
          calls.push({ skill, params });

          return {
            skill: "cutTree",
            requested_count: 1,
            collected_count: 1,
            completed: true,
            status: "completed",
            clusters: [{ cluster_id: "tree-1", log_block_name: "oak_log", collected_count: 1 }],
            diagnostics: [],
            total_steps: 1,
            world_key: "minecraft:overworld",
          };
        },
        async writeChat() {
          throw new Error("chat should not run");
        },
      },
    });

    expect(result.status).toBe(TaskHistoryStatus.Completed);
    expect(calls).toEqual([{ skill: "cutTree", params: { count: 1 } }]);
    expect(result.step_results[0]).toMatchObject({
      action: "cutTree",
      status: "ok",
    });
  });

  it("应集中表达 diagnostics（诊断） 通道目录、保留期与引用规则", () => {
    const diagnosticsCatalog = createDiagnosticsCatalog();
    const taskLogRef = createTaskLogRef({
      date: "2026-04-13",
      job_id: "T-007",
    });
    const sandboxLogRef = createSandboxLogRef({
      date: "2026-04-13",
      job_id: "T-007",
    });
    const sandboxCodeRef = createSandboxCodeRef({
      date: "2026-04-13",
      job_id: "T-007",
    });
    const llmLogRef = createLlmLogRef({
      date: "2026-04-13",
      stage: "triage",
      message_id: "msg-001",
    });

    expect(diagnosticsCatalog.channels.map((channel) => channel.channel)).toEqual([
      "tasks",
      "sandbox",
      "llm",
      "metrics",
    ]);
    expect(taskLogRef).toBe("tasks/2026-04-13/T-007.jsonl");
    expect(sandboxLogRef).toBe("sandbox/2026-04-13/T-007.jsonl");
    expect(sandboxCodeRef).toBe("sandbox/2026-04-13/T-007.code.ts");
    expect(llmLogRef).toBe("llm/2026-04-13/triage-msg-001.jsonl");

    expect(() =>
      createSandboxExecutionRequest({
        job_id: "T-007",
        bot_id: "bot-007",
        intent_epoch: 2,
        snapshot_ts: 1,
        code: "await reply('hello')",
        log_ref: taskLogRef,
      }),
    ).toThrow(/sandbox/);
  });

  it("应把每次 conversation reply（对话回复） 与上下文写入本地 JSONL（结构化日志）", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "ts-core-conversation-log-"));
    const logSink = createLocalConversationReplyLogSink({
      baseDir,
      sensitiveValues: ["sk-local-dev"],
    });

    try {
      await logSink({
        bot_id: "bot-log",
        message_id: "msg/log:1",
        created_at: "2026-05-03T01:46:56.000Z",
        owner_message: "你在哪",
        route_kind: "chat_reply",
        reply_mode: "llm",
        reply: "我在这里喵~",
        contexts: {
          state_context: "当前状态：idle",
          memory_context: "api_key=sk-local-dev",
        },
        llm_diagnostics: {
          lines: [
            {
              role: "system",
              content: "[Bot] 位置:(0,64,0)\n[世界] minecraft:overworld",
            },
          ],
        },
      });

      const content = await readFile(
        join(baseDir, "conversation", "2026-05-03", "msg_log_1.jsonl"),
        "utf8",
      );
      const line = JSON.parse(content.trim()) as {
        reply?: string;
        contexts?: { memory_context?: string };
        llm_diagnostics?: { lines?: Array<{ content?: string }> };
      };

      expect(line.reply).toBe("我在这里喵~");
      expect(line.contexts?.memory_context).toBe(`api_key=${"<redacted>"}`);
      expect(line.llm_diagnostics?.lines?.[0]?.content).toContain("[世界] minecraft:overworld");
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  it("应创建只读的 tasks（任务执行） / sandbox（沙箱执行） / llm（大语言模型） 日志行", () => {
    const taskStep = createTaskLogLine({
      t: 1_712_930_001,
      e: "step",
      i: 0,
      act: "goTo",
      p: { x: 1, y: 64, z: 2 },
      s: "ok",
      ms: 5200,
    });
    const sandboxLine = createSandboxLogLine({
      t: 1_712_930_001,
      phase: "facade_result",
      m: "goTo",
      s: "ok",
      r: { arrived: true },
      ms: 5200,
    });
    const llmLine = createLlmLogLine({
      t: 1_712_930_001,
      meta: {
        input_tokens: 120,
        output_tokens: 35,
        ms: 800,
        ok: true,
      },
    });

    expect(Object.isFrozen(taskStep)).toBe(true);
    expect(Object.isFrozen(taskStep.p ?? {})).toBe(true);
    expect(Object.isFrozen(sandboxLine.r ?? {})).toBe(true);
    expect(Object.isFrozen(llmLine.meta)).toBe(true);

    const llmSummary = createLlmDiagnosticSummary({
      stage: "triage",
      message_id: "msg-001",
      status: "error",
      model: "bl-auto",
      log_ref: "llm/2026-04-13/triage-msg-001.jsonl",
      created_at: "2026-04-13T12:00:00.000Z",
      error_summary: "upstream timeout",
      metrics: {
        queue_wait_ms: 4,
        prompt_build_ms: 2,
        request_total_ms: 80,
        response_parse_ms: 1,
        tool_round_count: 0,
        tool_round_ms: [],
        diagnostics_write_ms: 3,
        input_tokens: 30,
        output_tokens: 10,
        tokens_per_second: 125,
        ttft_ms: null,
        ttft_unavailable: "non_streaming",
      },
    });

    expect(llmSummary).toEqual({
      stage: "triage",
      message_id: "msg-001",
      status: "error",
      model: "bl-auto",
      log_ref: "llm/2026-04-13/triage-msg-001.jsonl",
      created_at: "2026-04-13T12:00:00.000Z",
      error_summary: "upstream timeout",
      metrics: {
        queue_wait_ms: 4,
        prompt_build_ms: 2,
        request_total_ms: 80,
        response_parse_ms: 1,
        tool_round_count: 0,
        tool_round_ms: [],
        diagnostics_write_ms: 3,
        input_tokens: 30,
        output_tokens: 10,
        tokens_per_second: 125,
        ttft_ms: null,
        ttft_unavailable: "non_streaming",
      },
    });
    expect(Object.isFrozen(llmSummary)).toBe(true);

    const redactedLlmSummary = createLlmDiagnosticSummary(
      {
        stage: "chat",
        message_id: "msg-002",
        status: "error",
        model: "bl-auto",
        log_ref: "llm/2026-04-13/chat-msg-002.jsonl",
        created_at: "2026-04-13T12:00:01.000Z",
        error_summary:
          "LLM_API_KEY=sk-local-dev failed postgres://user:pg-pass@localhost/db redis://:redis-pass@localhost EasyAuth密码=hunter2",
      },
      { sensitiveValues: ["hunter2"] },
    );

    expect(redactedLlmSummary.error_summary).toContain("<redacted>");
    expect(redactedLlmSummary.error_summary).not.toContain("sk-local-dev");
    expect(redactedLlmSummary.error_summary).not.toContain("pg-pass");
    expect(redactedLlmSummary.error_summary).not.toContain("redis-pass");
    expect(redactedLlmSummary.error_summary).not.toContain("hunter2");
  });

  it("应让 tasks（任务执行） 摘要与运行时 started / terminal（已开始 / 终态） 生命周期对齐", () => {
    const job = createCodeJob({
      message_id: "T-008",
      intent_epoch: 6,
      snapshot_ts: 1_712_940_000,
      priority: ExecPriority.Normal,
      code: "await reply('ok')",
    });
    const startedSummary = createTaskLifecycleSummaryJsonlLine({
      t: 1_712_940_001,
      lifecycle: createTaskStartedLifecycleEvent(job),
    });
    const failedLifecycle = createTaskTerminalLifecycleEvent({
      job,
      status: TaskHistoryStatus.Failed,
      total_steps: 2,
      duration_ms: 9800,
      error: {
        name: "StaticCheckError",
        message: "Forbidden import detected",
      },
      last_step: "goTo",
    });
    if (failedLifecycle.status !== TaskHistoryStatus.Failed) {
      throw new Error("expected failed terminal lifecycle");
    }
    const failedSummary = createTaskLifecycleSummaryJsonlLine({
      t: 1_712_940_099,
      lifecycle: failedLifecycle as TaskLifecycleEvent<TaskHistoryStatus.Failed>,
    });

    expect(startedSummary.status).toBe(TaskHistoryStatus.Started);
    expect(startedSummary.e).toBe("task.started");
    expect(failedSummary.status).toBe(TaskHistoryStatus.Failed);
    expect(failedSummary.e).toBe("task.failed");
    expect(failedSummary.err.message).toBe("Forbidden import detected");
    expect(Object.isFrozen(failedSummary.err)).toBe(true);
  });

  it("应创建携带阶段日志与终态摘要的 sandbox（沙箱执行） 请求和结果", () => {
    const resourceLimits = createSandboxResourceLimits();
    const logRef = createSandboxLogRef({
      date: "2026-04-13",
      job_id: "T-007",
    });
    const codeRef = createSandboxCodeRef({
      date: "2026-04-13",
      job_id: "T-007",
    });
    const request = createSandboxExecutionRequest({
      job_id: "T-007",
      bot_id: "bot-007",
      intent_epoch: 4,
      snapshot_ts: 1712930000,
      code: "await goTo({ x: 1, y: 64, z: 2 });",
      log_ref: logRef,
      code_ref: codeRef,
      resource_limits: resourceLimits,
    });
    const phaseLogs = [
      createSandboxLogLine({
        t: 1_712_930_000,
        phase: "precheck",
        ok: true,
      }),
      createSandboxLogLine({
        t: 1_712_930_022,
        phase: "sandbox_complete",
        steps: 1,
        ms: 22000,
      }),
    ] as const;
    const stepResults = [
      createSandboxStepResult({
        step_index: 0,
        action: "goTo",
        params: { x: 1, y: 64, z: 2 },
        status: "ok",
        duration_ms: 5200,
        result: { x: 1, y: 64, z: 2 },
      }),
    ] as const;
    const success = createSandboxExecutionSuccess({
      job_id: request.job_id,
      bot_id: request.bot_id,
      intent_epoch: request.intent_epoch,
      log_ref: request.log_ref,
      ...(request.code_ref !== undefined ? { code_ref: request.code_ref } : {}),
      phase_logs: phaseLogs,
      step_results: stepResults,
      summary: {
        total_steps: 1,
        duration_ms: 22000,
      },
    });

    expect(request.type).toBe(ExecutionTaskKind.Code);
    expect(success.status).toBe(TaskHistoryStatus.Completed);
    expect(success.summary.terminal_status).toBe(TaskHistoryStatus.Completed);
    expect(Object.isFrozen(success.phase_logs)).toBe(true);
    expect(success.step_results).toHaveLength(1);
    expect(Object.isFrozen(success.step_results[0]?.params ?? {})).toBe(true);
  });

  it("应覆盖文档要求的错误分类并区分失败与中断终态", () => {
    const logRef = createSandboxLogRef({
      date: "2026-04-13",
      job_id: "T-007",
    });
    const phaseLogs = [
      createSandboxLogLine({
        t: 1_712_930_000,
        phase: "precheck",
        ok: false,
        violation: "\\bimport\\s",
      }),
    ] as const;
    const staticCheckError = createSandboxError({
      name: "StaticCheckError",
      message: "Forbidden import detected",
      recoverable: false,
      violation: "\\bimport\\s",
    });
    const abortError = createSandboxError({
      name: "AbortError",
      message: "Sandbox aborted",
      recoverable: false,
      reason: "owner_interrupt",
    });
    const failure = createSandboxExecutionFailure({
      job_id: "T-007",
      bot_id: "bot-007",
      intent_epoch: 4,
      log_ref: logRef,
      phase_logs: phaseLogs,
      step_results: [],
      summary: {
        total_steps: 0,
        duration_ms: 10,
      },
      error: staticCheckError,
    });
    const interrupted = createSandboxExecutionInterrupted({
      job_id: "T-007",
      bot_id: "bot-007",
      intent_epoch: 4,
      log_ref: logRef,
      phase_logs: phaseLogs,
      step_results: [],
      summary: {
        total_steps: 0,
        duration_ms: 10,
      },
      error: abortError,
    });

    expect(failure.status).toBe(TaskHistoryStatus.Failed);
    expect(failure.error.name).toBe("StaticCheckError");
    expect(interrupted.status).toBe(TaskHistoryStatus.Interrupted);
    expect(interrupted.error.name).toBe("AbortError");
    expect(interrupted.error.recoverable).toBe(false);
  });

  it("应拒绝被类型断言伪装成可恢复的 AbortError（中断错误）", () => {
    expect(() =>
      createSandboxError({
        name: "AbortError",
        message: "Sandbox aborted",
        recoverable: true,
        reason: "owner_interrupt",
      } as unknown as AbortError),
    ).toThrow(/recoverable must be false/);
  });

  it("应创建已脱敏、限长且只读的 sandbox experience（沙箱经验）草案", () => {
    const draft = createSandboxExperienceDraft({
      bot_id: "bot-035",
      message_id: "msg-sandbox-exp",
      intent_epoch: 7,
      status: TaskHistoryStatus.Failed,
      total_steps: 2,
      duration_ms: 3456,
      log_ref: "sandbox/2026-04-26/msg-sandbox-exp.jsonl",
      code_ref: "sandbox/2026-04-26/msg-sandbox-exp.code.ts",
      code: String.raw`await reply('LLM_API_KEY=sk-local-dev password=hunter2 file=/home/hcid274/code/MC_WSL_servant/.env win=C:\Users\hcid274\.ts-core\.env')`,
      error: {
        name: "FacadeCallError",
        message: String.raw`failed with sk-local-dev postgres://user:pg-pass@localhost/db EasyAuth密码=hunter2 at /Users/dev/MC_WSL_servant/.env and C:\Users\dev\AppData\Local\ts-core\.env`,
        error_code: "path_not_found",
        recoverable: false,
      },
      sensitiveValues: ["hunter2"],
    });

    expect(draft.status).toBe(TaskHistoryStatus.Failed);
    expect(draft.code_hash).toMatch(/^sha256:/);
    expect(draft.code_preview?.length ?? 0).toBeLessThanOrEqual(240);
    expect(draft.summary.length).toBeLessThanOrEqual(240);
    expect(JSON.stringify(draft)).not.toContain("sk-local-dev");
    expect(JSON.stringify(draft)).not.toContain("pg-pass");
    expect(JSON.stringify(draft)).not.toContain("hunter2");
    expect(JSON.stringify(draft)).not.toContain("/home/hcid274/code/MC_WSL_servant/.env");
    expect(JSON.stringify(draft)).not.toContain("/Users/dev/MC_WSL_servant/.env");
    expect(JSON.stringify(draft)).not.toContain(String.raw`C:\Users\hcid274\.ts-core\.env`);
    expect(JSON.stringify(draft)).not.toContain(
      String.raw`C:\Users\dev\AppData\Local\ts-core\.env`,
    );
    expect(JSON.stringify(draft)).toContain("<redacted-path>");
    expect(Object.isFrozen(draft)).toBe(true);
    expect(Object.isFrozen(draft.error ?? {})).toBe(true);

    expect(() =>
      createSandboxExperienceDraft({
        bot_id: "bot-035",
        message_id: "msg-sandbox-exp-bad",
        intent_epoch: 7,
        status: TaskHistoryStatus.Failed,
        total_steps: 0,
        duration_ms: 1,
      }),
    ).toThrow(/requires error/);
  });
});
