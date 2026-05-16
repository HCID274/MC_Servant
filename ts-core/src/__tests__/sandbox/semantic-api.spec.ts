import {
  ExecPriority,
  ExecutionTaskKind,
  TaskHistoryStatus,
  createCodeJob,
  createRuntimeSandboxRequest,
  createSandboxError,
  createSandboxExecutionFailure,
  createSandboxExecutionInterrupted,
  createSandboxExecutionSuccess,
  createSandboxResourceLimits,
  createSatisfiedConditionFacade,
  createTaskResultSummaryFromSandboxResult,
  createTestConditionEvaluation,
  describe,
  executeCodeRequest,
  expect,
  invalidAbortRecoverable,
  invalidCraftParams,
  invalidGoToParams,
  invalidSandboxRequestType,
  invalidStepAction,
  it,
  validCraftParams,
} from "./diagnostics-and-execution.fixture.js";

void validCraftParams;
void invalidAbortRecoverable;
void invalidCraftParams;
void invalidGoToParams;
void invalidSandboxRequestType;
void invalidStepAction;

describe("sandbox semantic API 行为", () => {
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
});
