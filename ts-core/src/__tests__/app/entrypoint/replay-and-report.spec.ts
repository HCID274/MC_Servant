import {
  type AppRuntimeCoreResources,
  BotStatus,
  type BotWorkerTask,
  type BrainWorkerRuntimeDependencies,
  type BrainWorkerTask,
  ConversationLlmPlanError,
  ConversationPriority,
  EventEmitter,
  ExecPriority,
  ExecutionTaskKind,
  FakeEntrypointMineflayerBot,
  Fastify,
  type MineflayerBotHandle,
  SERVER_BRIDGE_PROTOCOL_VERSION,
  TaskHistoryStatus,
  WebSocket,
  bindOnlineResourceServiceBlockUpdates,
  createAppBootstrapContract,
  createAppExternalAuthSecretFromEnvironment,
  createAppServerBridgeConfigFromEnvironment,
  createAppStartupSummary,
  createBotWorkerActions,
  createBotWorkerTask,
  createBrainTaskCard,
  createBrainWorkerTask,
  createCodeJob,
  createCodeJobForSkill,
  createCollectSkillExecutionResult,
  createConversationCompositeTriage,
  createConversationWorkerTask,
  createCutTreeSkillExecutionResult,
  createEquipSkillExecutionResult,
  createExternalAuthExecutionPlan,
  createExternalAuthState,
  createFakeIntentEpochRedisClient,
  createGoToSkillExecutionResult,
  createMineSkillExecutionResult,
  createMineflayerTransportDescriptor,
  createNoopBrainWorkerDependencies,
  createObservationRuntimeCache,
  createOnlineConversationActorStateProjectionProvider,
  createRealtimeEventFromBotWorkerAction,
  createRealtimeEventFromConversationReply,
  createResourceService,
  createRuntimeReadyGate,
  createTaskFailureResultSummary,
  createTaskResultReporter,
  createTaskResultSummaryFromSandboxResult,
  createTaskResultSummaryFromSkillResult,
  describe,
  expect,
  it,
  join,
  mkdtemp,
  readFile,
  readFileSync,
  readNextWsText,
  renderAppStartupSummary,
  resolve,
  rm,
  runAppEntrypoint,
  startAppOnlineRuntime,
  tmpdir,
  waitForWsClose,
  waitForWsOpen,
} from "./fixture.js";

describe("app/entrypoint replay 与 report 汇报", () => {
  it("应把 worker（工作线程） 输出动作转换为只读 replay（补拉）事件", () => {
    const task = createBotWorkerTask({
      bot_id: "bot-realtime-action",
      exec_job: createCodeJob({
        message_id: "msg-realtime-action",
        intent_epoch: 1,
        snapshot_ts: 100,
        priority: ExecPriority.Normal,
        code: "return true",
      }),
    });
    const startedAction = createBotWorkerActions({ task, phase: "started" })[0];
    const discardedAction = createBotWorkerActions({
      task,
      phase: "discarded",
      discard_reason: "intent_epoch_stale",
      current_epoch: 2,
    })[0];
    const completedActions = createBotWorkerActions({
      task,
      phase: "terminal",
      status: TaskHistoryStatus.Completed,
      total_steps: 1,
      duration_ms: 10,
    });
    const failedAction = createBotWorkerActions({
      task,
      phase: "terminal",
      status: TaskHistoryStatus.Failed,
      total_steps: 1,
      duration_ms: 12,
      error: {
        name: "Error",
        message: "boom",
      },
    })[0];
    const interruptedAction = createBotWorkerActions({
      task,
      phase: "terminal",
      status: TaskHistoryStatus.Interrupted,
      total_steps: 1,
      duration_ms: 13,
      interrupt_source: {
        type: "triage",
        intent_epoch: 3,
      },
      reason: "cancel",
    })[0];
    const replyEvent = createRealtimeEventFromConversationReply({
      botId: "bot-realtime-action",
      messageId: "msg-realtime-action",
      content: "收到喵~",
      createdAt: "2026-04-25T00:00:00.000Z",
    });

    const converted = [
      startedAction,
      discardedAction,
      completedActions[0],
      failedAction,
      interruptedAction,
    ].map((action) =>
      createRealtimeEventFromBotWorkerAction({
        action,
        createdAt: "2026-04-25T00:00:00.000Z",
      }),
    );

    expect(converted.map((event) => event?.type)).toEqual([
      "task.started",
      "task.discarded",
      "task.completed",
      "task.failed",
      "task.interrupted",
    ]);
    expect(converted[2]).toMatchObject({
      bot_id: "bot-realtime-action",
      payload: {
        job_id: "msg-realtime-action",
        status: "completed",
        message_id: "msg-realtime-action",
        total_steps: 1,
      },
    });
    expect(
      createRealtimeEventFromBotWorkerAction({
        action: completedActions[1],
        createdAt: "2026-04-25T00:00:00.000Z",
      }),
    ).toBeNull();
    expect(replyEvent).toEqual({
      bot_id: "bot-realtime-action",
      type: "chat.reply",
      created_at: "2026-04-25T00:00:00.000Z",
      payload: {
        message_id: "msg-realtime-action",
        content: "收到喵~",
      },
    });
    expect(Object.isFrozen(replyEvent.payload)).toBe(true);
  });

  it("应把任务终态转换为游戏聊天可见结果且同一终态只汇报一次", async () => {
    const action = createBotWorkerActions({
      task: createBotWorkerTask({
        bot_id: "bot-realtime-action",
        exec_job: createCodeJob({
          message_id: "msg-mine-failed-reply",
          intent_epoch: 3,
          snapshot_ts: 1777906762364,
          priority: ExecPriority.Normal,
          code: "await mine('stone', 5)",
        }),
        owner_text: "给我挖5个石头",
      }),
      phase: "terminal",
      status: TaskHistoryStatus.Failed,
      total_steps: 0,
      duration_ms: 23,
      error: {
        name: "Error",
        message: "not_equipped:stone:requires_wooden_or_stone_pickaxe",
      },
      last_step: "executeCode",
    });
    const completedAction = createBotWorkerActions({
      task: createBotWorkerTask({
        bot_id: "bot-realtime-action",
        exec_job: createCodeJob({
          message_id: "msg-cut-tree-completed-reply",
          intent_epoch: 4,
          snapshot_ts: 1777906762364,
          priority: ExecPriority.Normal,
          code: "await cutTree(12)",
        }),
        owner_text: "砍12块木头",
      }),
      phase: "terminal",
      status: TaskHistoryStatus.Completed,
      total_steps: 2,
      duration_ms: 3100,
      result_summary: {
        task_type: ExecutionTaskKind.Code,
        operation: "cutTree",
        target: "oak_log",
        requested_count: 12,
        completed_count: 12,
        inventory_delta: [{ item_name: "oak_log", count: 12 }],
        world_key: "minecraft:overworld",
      },
    });

    const reporter = createTaskResultReporter();
    const failureReply = await reporter.consume(action[1]);
    const completedReply = await reporter.consume(completedAction[1]);

    expect(failureReply).toMatchObject({
      message_id: "msg-mine-failed-reply:task_result",
    });
    expect(failureReply?.content).toContain("任务失败：code 失败码 not_equipped");
    expect(failureReply?.content).toContain("阶段 executeCode");
    expect(failureReply?.content).toContain("可恢复");
    expect(completedReply?.content).toContain("任务完成：砍到 oak_log x12");
    expect(completedReply?.content).toContain("已捡拾掉落物");
    await expect(reporter.consume(completedAction[1])).resolves.toBeNull();

    const multiCompletedAction = createBotWorkerActions({
      task: createBotWorkerTask({
        bot_id: "bot-realtime-action",
        exec_job: createCodeJob({
          message_id: "msg-multi-completed-reply",
          intent_epoch: 5,
          snapshot_ts: 1777906762364,
          priority: ExecPriority.Normal,
        }),
        owner_text: "砍20个木头，然后去挖5个石头，最后回到我这",
      }),
      phase: "terminal",
      status: TaskHistoryStatus.Completed,
      total_steps: 4,
      duration_ms: 4200,
      result_summary: {
        task_type: ExecutionTaskKind.Code,
        operation: "砍木头、挖石头并返回主人身边",
        completed_count: 25,
        inventory_delta: [
          { item_name: "oak_log", count: 20 },
          { item_name: "cobblestone", count: 5 },
        ],
        world_key: "multiworld:resource",
      },
    });
    const multiCompletedReply = await reporter.consume(multiCompletedAction[1]);
    expect(multiCompletedReply?.content).toContain("oak_log x20、cobblestone x5");
  });

  it("应汇报 sandbox TS（沙箱 TypeScript） 报错与中断终态", async () => {
    const task = createBotWorkerTask({
      bot_id: "bot-realtime-action",
      exec_job: createCodeJob({
        message_id: "msg-sandbox-result",
        intent_epoch: 5,
        snapshot_ts: 1777906762364,
        priority: ExecPriority.Normal,
        code: "await mine('iron_ore', 1)",
      }),
      owner_text: "挖铁矿",
    });
    const failedActions = createBotWorkerActions({
      task,
      phase: "terminal",
      status: TaskHistoryStatus.Failed,
      total_steps: 1,
      duration_ms: 900,
      error: {
        name: "FacadeCallError",
        message: "resource_not_found:iron_ore",
        error_code: "resource_not_found",
        details: {
          failure_stage: "mine",
          recoverable: true,
          world_key: "minecraft:overworld",
        },
      },
      last_step: "mine",
      result_summary: {
        task_type: ExecutionTaskKind.Code,
        operation: "mine",
        target: "iron_ore",
        requested_count: 1,
        completed_count: 0,
        world_key: "minecraft:overworld",
      },
    });
    const interruptedActions = createBotWorkerActions({
      task,
      phase: "terminal",
      status: TaskHistoryStatus.Interrupted,
      total_steps: 1,
      duration_ms: 1200,
      interrupt_source: {
        type: "control",
        command: "cancel",
      },
      reason: "owner requested cancel",
      result_summary: {
        task_type: ExecutionTaskKind.Code,
        operation: "mine",
        target: "iron_ore",
        requested_count: 1,
        completed_count: 0,
        world_key: "minecraft:overworld",
      },
    });

    const reporter = createTaskResultReporter();
    const failedReply = await reporter.consume(failedActions[1]);
    const interruptedReply = await reporter.consume(interruptedActions[1]);

    expect(failedReply?.content).toContain(
      "任务失败：mine 失败码 resource_not_found，阶段 mine，可恢复",
    );
    expect(failedReply?.content).toContain("下一步建议换位置或扩大搜索范围");
    expect(interruptedReply?.content).toContain("任务已取消：mine 已停止");
    expect(interruptedReply?.content).not.toContain("任务完成");
  });

  it("应在 sandbox TS（沙箱 TypeScript） 前置成功后准确汇报后续失败操作", async () => {
    const sandboxJob = createCodeJob({
      message_id: "msg-sandbox-step-failure",
      intent_epoch: 6,
      snapshot_ts: 1777906762364,
      priority: ExecPriority.Normal,
      code: [
        "await craft('wooden_pickaxe', 1)",
        "await equip('wooden_pickaxe')",
        "await mine('iron_ore', 1)",
      ].join("\n"),
    });
    const sandboxResult = {
      status: TaskHistoryStatus.Failed,
      summary: { total_steps: 3 },
      step_results: [
        {
          action: "craft",
          status: "ok",
          params: { itemName: "wooden_pickaxe", count: 1 },
          result: { ok: true, data: { item_name: "wooden_pickaxe", completed_count: 1 } },
        },
        {
          action: "equip",
          status: "ok",
          params: { itemName: "wooden_pickaxe" },
          result: { skill: "equip", item_name: "wooden_pickaxe" },
        },
        {
          action: "mine",
          status: "err",
          params: { blockName: "iron_ore", count: 1 },
          error: {
            name: "FacadeCallError",
            message: "resource_not_found:iron_ore",
            error_code: "resource_not_found",
          },
        },
      ],
      error: {
        name: "FacadeCallError",
        message: "resource_not_found:iron_ore",
        error_code: "resource_not_found",
        method: "mine",
        details: {
          failure_stage: "mine",
          recoverable: true,
          world_key: "minecraft:overworld",
          target_progress: {
            action: "mine",
            target: "iron_ore",
            requested_count: 1,
            completed_count: 0,
          },
        },
      },
    } as unknown as Parameters<typeof createTaskResultSummaryFromSandboxResult>[1];
    const task = createBotWorkerTask({
      bot_id: "bot-realtime-action",
      exec_job: sandboxJob,
      owner_text: "做镐再挖铁矿",
    });
    const failedActions = createBotWorkerActions({
      task,
      phase: "terminal",
      status: TaskHistoryStatus.Failed,
      total_steps: 3,
      duration_ms: 1600,
      error: {
        name: "FacadeCallError",
        message: "resource_not_found:iron_ore",
        error_code: "resource_not_found",
        details: {
          failure_stage: "mine",
          recoverable: true,
          world_key: "minecraft:overworld",
        },
      },
      last_step: "mine",
      result_summary: createTaskResultSummaryFromSandboxResult(sandboxJob, sandboxResult),
    });

    const reporter = createTaskResultReporter();
    const failedReply = await reporter.consume(failedActions[1]);

    expect(failedReply?.content).toContain(
      "任务失败：mine 失败码 resource_not_found，阶段 mine，可恢复",
    );
    expect(failedReply?.content).not.toContain("equip 失败码 resource_not_found");
    expect(failedReply?.content).not.toContain("craft 失败码 resource_not_found");
  });

  it("应为 Phase 1（第一阶段） 技能生成统一 SkillResultSummary（技能结果摘要）", () => {
    const summaries = [
      createTaskResultSummaryFromSkillResult(
        createCodeJobForSkill({
          message_id: "msg-summary-go",
          intent_epoch: 1,
          snapshot_ts: 1777906762364,
          priority: ExecPriority.Normal,
          skill: "goTo",
          params: { x: 1, y: 2, z: 3 },
        }),
        createGoToSkillExecutionResult({ x: 1, y: 2, z: 3 }, { world_key: "multiworld:resource" }),
        { durationMs: 10 },
      ),
      createTaskResultSummaryFromSkillResult(
        createCodeJobForSkill({
          message_id: "msg-summary-mine",
          intent_epoch: 1,
          snapshot_ts: 1777906762364,
          priority: ExecPriority.Normal,
          skill: "mine",
          params: { blockName: "stone", count: 2 },
        }),
        createMineSkillExecutionResult(
          { blockName: "stone", count: 2 },
          {
            world_key: "minecraft:overworld",
            collected_item_name: "cobblestone",
            collected_count: 2,
            mined_count: 2,
            diagnostics: ["planner=stair_bfs"],
          },
        ),
        { durationMs: 20 },
      ),
      createTaskResultSummaryFromSkillResult(
        createCodeJobForSkill({
          message_id: "msg-summary-collect",
          intent_epoch: 1,
          snapshot_ts: 1777906762364,
          priority: ExecPriority.Normal,
          skill: "collect",
          params: { itemName: "oak_log" },
        }),
        createCollectSkillExecutionResult(
          { itemName: "oak_log" },
          {
            world_key: "multiworld:resource",
            collected: [{ name: "oak_log", count: 3 }],
          },
        ),
        { durationMs: 30 },
      ),
      createTaskResultSummaryFromSkillResult(
        createCodeJobForSkill({
          message_id: "msg-summary-cut-tree",
          intent_epoch: 1,
          snapshot_ts: 1777906762364,
          priority: ExecPriority.Normal,
          skill: "cutTree",
          params: { count: 4 },
        }),
        createCutTreeSkillExecutionResult(
          { count: 4 },
          {
            world_key: "minecraft:overworld",
            collected_count: 5,
            completed: true,
            status: "completed",
            clusters: [
              {
                cluster_id: "tree-1",
                log_block_name: "oak_log",
                estimated_log_count: 5,
                target: { x: 4, y: 64, z: 4 },
                collected_count: 5,
              },
            ],
          },
        ),
        { durationMs: 40 },
      ),
      createTaskResultSummaryFromSkillResult(
        createCodeJobForSkill({
          message_id: "msg-summary-equip",
          intent_epoch: 1,
          snapshot_ts: 1777906762364,
          priority: ExecPriority.Normal,
          skill: "equip",
          params: { itemName: "stone_pickaxe" },
        }),
        createEquipSkillExecutionResult(
          { itemName: "stone_pickaxe" },
          {
            world_key: "multiworld:resource",
            status: "already_equipped",
            total_steps: 0,
          },
        ),
        { durationMs: 50 },
      ),
    ];

    expect(summaries.map((summary) => summary.skill_name)).toEqual([
      "goTo",
      "mine",
      "collect",
      "cutTree",
      "equip",
    ]);
    for (const summary of summaries) {
      expect(summary.status).toBe("completed");
      expect(summary.operation).toBe(summary.skill_name);
      expect(summary.duration_ms).toBeGreaterThan(0);
    }
    expect(summaries[1]?.inventory_delta).toEqual([{ item_name: "cobblestone", count: 2 }]);
    expect(summaries[1]?.diagnostics).toEqual(["planner=stair_bfs"]);
    expect(summaries.map((summary) => summary.world_key)).toEqual([
      "multiworld:resource",
      "minecraft:overworld",
      "multiworld:resource",
      "minecraft:overworld",
      "multiworld:resource",
    ]);
    expect(summaries[4]?.details).toMatchObject({ status: "already_equipped" });
  });

  it("goTo（移动）成功汇报应使用摘要中的真实世界键", async () => {
    const task = createBotWorkerTask({
      bot_id: "bot-realtime-action",
      exec_job: createCodeJobForSkill({
        message_id: "msg-goto-world-report",
        intent_epoch: 1,
        snapshot_ts: 1777906762364,
        priority: ExecPriority.Normal,
        skill: "goTo",
        params: { x: 16, y: 104, z: 10 },
      }),
      owner_text: "到我这来",
    });
    const actions = createBotWorkerActions({
      task,
      phase: "terminal",
      status: TaskHistoryStatus.Completed,
      total_steps: 1,
      duration_ms: 800,
      result_summary: createTaskResultSummaryFromSkillResult(
        task.exec_job,
        createGoToSkillExecutionResult(
          { x: 16, y: 104, z: 10 },
          { world_key: "multiworld:resource" },
        ),
        { durationMs: 800 },
      ),
    });

    const reporter = createTaskResultReporter();
    const reply = await reporter.consume(actions[1]);

    expect(reply?.content).toContain("世界 multiworld:resource");
    expect(reply?.content).not.toContain("世界 unknown");
  });

  it("sandbox TS（沙箱 TypeScript） 成功摘要应保留 goTo / collect / equip 的世界键", () => {
    const sandboxJob = createCodeJob({
      message_id: "msg-sandbox-skill-world",
      intent_epoch: 1,
      snapshot_ts: 1777906762364,
      priority: ExecPriority.Normal,
      code: "await goTo(1, 64, 1)",
    });
    const createResult = (action: string, result: Readonly<Record<string, unknown>>) =>
      ({
        status: TaskHistoryStatus.Completed,
        summary: { total_steps: 1 },
        step_results: [
          {
            action,
            status: "ok",
            params: {},
            result,
          },
        ],
      }) as unknown as Parameters<typeof createTaskResultSummaryFromSandboxResult>[1];

    const goToSummary = createTaskResultSummaryFromSandboxResult(
      sandboxJob,
      createResult("goTo", {
        skill: "goTo",
        world_key: "multiworld:resource",
        target: { x: 1, y: 64, z: 1 },
      }),
    );
    const collectSummary = createTaskResultSummaryFromSandboxResult(
      sandboxJob,
      createResult("collect", {
        skill: "collect",
        item_name: "oak_log",
        world_key: "multiworld:resource",
        collected: [{ name: "oak_log", count: 2 }],
      }),
    );
    const equipSummary = createTaskResultSummaryFromSandboxResult(
      sandboxJob,
      createResult("equip", {
        skill: "equip",
        item_name: "bread",
        world_key: "multiworld:resource",
      }),
    );

    expect(goToSummary.world_key).toBe("multiworld:resource");
    expect(collectSummary.world_key).toBe("multiworld:resource");
    expect(equipSummary.world_key).toBe("multiworld:resource");
  });

  it("应为 sandbox TS（沙箱 TypeScript） 工具链能力生成统一成功与失败摘要", () => {
    const sandboxJob = createCodeJob({
      message_id: "msg-toolchain-summary",
      intent_epoch: 1,
      snapshot_ts: 1777906762364,
      priority: ExecPriority.Normal,
      code: "await ensure(async () => mine('iron_ore', 1), until.gained('raw_iron', 1))",
    });
    const successResult = {
      status: TaskHistoryStatus.Completed,
      summary: { total_steps: 3, duration_ms: 120 },
      step_results: [
        {
          action: "craft",
          status: "ok",
          params: { itemName: "crafting_table", count: 1 },
          result: {
            ok: true,
            data: {
              item_name: "crafting_table",
              completed_count: 1,
              world_key: "minecraft:overworld",
            },
          },
        },
        {
          action: "place",
          status: "ok",
          params: { blockName: "crafting_table" },
          result: {
            ok: true,
            data: {
              block_name: "crafting_table",
              completed_count: 1,
              world_key: "minecraft:overworld",
            },
          },
        },
        {
          action: "ensure",
          status: "ok",
          params: {
            condition: { kind: "gained", itemName: "raw_iron", count: 1 },
          },
          result: {
            ok: true,
            data: {
              item_name: "stone_pickaxe",
              completed_count: 1,
              target_count: 1,
              world_key: "minecraft:overworld",
            },
          },
        },
      ],
    } as unknown as Parameters<typeof createTaskResultSummaryFromSandboxResult>[1];
    const failureSummary = createTaskFailureResultSummary(
      createCodeJobForSkill({
        message_id: "msg-failure-summary",
        intent_epoch: 1,
        snapshot_ts: 1777906762364,
        priority: ExecPriority.Normal,
        skill: "mine",
        params: { blockName: "iron_ore", count: 1 },
      }),
      {
        name: "Error",
        message: "unsafe_path:lava_risk",
        error_code: "unsafe_path",
        details: {
          failure_stage: "mine",
          recoverable: true,
          world_key: "minecraft:overworld",
          current_position: { x: 0, y: 64, z: 0 },
          inventory_summary: { occupied_slots: 3 },
          equipment_summary: { main_hand: { name: "stone_pickaxe" } },
          target_progress: {
            action: "mine",
            target: "iron_ore",
            requested_count: 1,
            completed_count: 0,
          },
        },
      },
      { durationMs: 70 },
    );

    const successSummary = createTaskResultSummaryFromSandboxResult(sandboxJob, successResult, {
      durationMs: 120,
    });

    expect(successSummary).toMatchObject({
      skill_name: "ensure",
      status: "completed",
      target: "stone_pickaxe",
      completed_count: 1,
      world_key: "minecraft:overworld",
      duration_ms: 120,
    });
    expect(failureSummary.failure).toMatchObject({
      failure_code: "unsafe_path",
      failure_stage: "mine",
      recoverable: true,
      current_position: { x: 0, y: 64, z: 0 },
      inventory_summary: { occupied_slots: 3 },
      equipment_summary: { main_hand: { name: "stone_pickaxe" } },
      target_progress: {
        action: "mine",
        target: "iron_ore",
        requested_count: 1,
        completed_count: 0,
      },
    });
  });

  it("应补全直接 code（技能调用） 失败的 SkillResultSummary（技能结果摘要）", () => {
    const mineJob = createCodeJobForSkill({
      message_id: "msg-direct-skill-failure-summary",
      intent_epoch: 1,
      snapshot_ts: 1777906762364,
      priority: ExecPriority.Normal,
      skill: "mine",
      params: { blockName: "stone", count: 5 },
    });

    const summary = createTaskFailureResultSummary(
      mineJob,
      {
        name: "Error",
        message: "not_equipped:stone:main_hand_empty",
      },
      { durationMs: 33 },
    );

    expect(summary).toMatchObject({
      skill_name: "code",
      operation: "code",
      status: "failed",
      completed_count: 0,
      duration_ms: 33,
    });
    expect(summary.failure).toEqual({
      failure_code: "not_equipped",
      failure_stage: "code",
      message: "not_equipped:stone:main_hand_empty",
      recoverable: true,
      current_position: null,
      inventory_summary: null,
      equipment_summary: null,
      target_progress: null,
    });
    expect(summary.failure_capsule).toEqual({
      goal: "code 目标 x1",
      failed_action: "code",
      failure_code: "not_equipped",
      progress: "目标 0/1",
      retry_guard: '不要原样重复 code("目标", 1)',
      hint: "先调用 equip 或 ensure 工具链准备所需工具",
    });
  });

  it("应在真实在线状态投影中保留 code（沙箱代码） interrupted（已中断） 终态", () => {
    const externalAuth = createExternalAuthState({ status: "not_required" });
    const descriptor = createMineflayerTransportDescriptor({
      botId: "bot-sandbox-interrupted",
    });
    const actor = {
      getSnapshot: () =>
        Object.freeze({
          bot_id: "bot-sandbox-interrupted",
          status: BotStatus.IDLE,
          transport: Object.freeze({
            bot_id: "bot-sandbox-interrupted" as const,
            state: "connected" as const,
            connected: true,
            world_ready: true,
            descriptor,
            username: "bot-online",
            last_error: null,
          }),
          ready_gate: createRuntimeReadyGate({
            status: BotStatus.IDLE,
            externalAuth,
          }),
          external_auth: externalAuth,
          external_auth_plan: createExternalAuthExecutionPlan(externalAuth),
          current_task: null,
          emitted_events: Object.freeze([]),
          chat_writes: Object.freeze([]),
          skill_executions: Object.freeze([]),
          sandbox_executions: Object.freeze([
            {
              message_id: "msg-sandbox-stop",
              status: "interrupted" as const,
              total_steps: 2,
            },
          ]),
        }),
    } as AppRuntimeCoreResources<"bot-sandbox-interrupted">["actor"];
    const provider = createOnlineConversationActorStateProjectionProvider(actor);

    const projection = provider();

    expect(projection.recent_sandbox).toEqual({
      message_id: "msg-sandbox-stop",
      status: "interrupted",
      total_steps: 2,
    });
    expect(projection.summary).toContain("最近沙箱：interrupted");
    expect(projection.summary).not.toContain("最近沙箱：failed");
  });
});
