import { describe, expect, it } from "vitest";

import {
  type ConversationCodePlanDraft,
  type ConversationPlanningTriage,
  ConversationPriority,
  ExecPriority,
  ExecutionTaskKind,
  TaskHistoryStatus,
  createBotWorkerActions,
  createBotWorkerTask,
  createBrainWorkerActions,
  createCancelTemplateReply,
  createCodePlanDraft,
  createConversationCompositeTriage,
  createConversationReply,
  createConversationRouteDecision,
  createConversationWorkerActions,
  createConversationWorkerTask,
  createExecJobFromPlan,
  createExecQueueName,
  createMessageQueueName,
  createMessageTriage,
  createTaskEventDraft,
  createWorkerQueueCatalog,
  ensureReplyEndsWithMeow,
  normalizeConversationCompositeTriageForMessage,
  shouldSearchConversationMemory,
} from "../index.js";

// @ts-expect-error Plan（规划） 输出草案只允许 code（代码） 字段。
const invalidPlanShape: ConversationCodePlanDraft = { skill: "cutTree" };
void invalidPlanShape;

// @ts-expect-error 规划上下文只接受 `task`（任务） 意图。
const invalidPlanningIntent: ConversationPlanningTriage["intent"] = "cancel";
void invalidPlanningIntent;

describe("conversation（对话） 与 workers（工作线程） 契约", () => {
  it("应创建与文档一致的三队列命名与目录", () => {
    const queueCatalog = createWorkerQueueCatalog("bot-008");

    expect(createMessageQueueName("bot-008")).toBe("msg:bot-008");
    expect(createExecQueueName("bot-008")).toBe("bot:bot-008:exec");
    expect(queueCatalog.conversation.concurrency).toBe("parallel");
    expect(queueCatalog.bot.concurrency).toBe("serial");
    expect(queueCatalog.brain.queue).toBe("brain");
  });

  it("应在 triage（分诊） 非法输出时安全回退到 chat/normal", () => {
    const triage = createMessageTriage({
      intent: "unknown",
      priority: "panic",
    });
    const route = createConversationRouteDecision({
      triage,
      message: "随便聊聊",
      has_active_task: false,
    });

    expect(triage.intent).toBe("chat");
    expect(triage.priority).toBe(ConversationPriority.Normal);
    expect(route.kind).toBe("chat_reply");
    expect(route.queue_behavior).toBe("none");
  });

  it("应创建强类型 composite triage（复合分诊） 并拒绝 chat（闲聊） 正文", () => {
    const composite = createConversationCompositeTriage({
      cancel: {
        reason: "先停下",
        priority: "interrupt",
      },
      chat: {},
      action: {
        intent: "task",
        priority: "urgent",
        reason: "继续规划新动作",
        needs_memory_search: true,
      },
    });

    expect(composite).toEqual({
      cancel: {
        reason: "先停下",
        priority: "interrupt",
      },
      chat: {},
      action: {
        intent: "task",
        priority: "urgent",
        reason: "继续规划新动作",
        needs_memory_search: true,
      },
    });
    expect(() =>
      createConversationCompositeTriage({
        chat: Object.fromEntries([["content", "知道了"]]) as Record<string, never>,
      }),
    ).toThrow(/chat must be an empty object/);
  });

  it("应丢弃普通新任务里 LLM 误带的 composite cancel（复合取消）", () => {
    const noisy = createConversationCompositeTriage({
      cancel: {
        reason: "误判为重置当前状态",
        priority: "interrupt",
      },
      action: {
        intent: "task",
        priority: ConversationPriority.Urgent,
        reason: "挖石头后回来",
      },
    });
    const normalized = normalizeConversationCompositeTriageForMessage({
      triage: noisy,
      message: "去挖10个石头,然后回来",
    });

    expect(normalized).toEqual({
      action: {
        intent: "task",
        priority: ConversationPriority.Urgent,
        reason: "挖石头后回来",
      },
    });
  });

  it("应保留明确中断语义里的 composite cancel（复合取消）", () => {
    const triage = createConversationCompositeTriage({
      cancel: {
        reason: "用户要求先停下当前任务",
        priority: "interrupt",
      },
      action: {
        intent: "task",
        priority: ConversationPriority.Urgent,
        reason: "回到主人身边",
      },
    });

    expect(
      normalizeConversationCompositeTriageForMessage({
        triage,
        message: "停下当前任务，然后回来",
      }),
    ).toBe(triage);
  });

  it("应让 Plan（规划） 唯一 code（代码）形态对齐执行契约", () => {
    const codePlan = createCodePlanDraft({
      code: "await reply('收到'); await cutTree(3); await report('完成');",
    });
    const codeJob = createExecJobFromPlan({
      plan: codePlan,
      message_id: "msg-code",
      intent_epoch: 8,
      snapshot_ts: 101,
      priority: ExecPriority.Normal,
    });

    expect(codePlan).toEqual({
      code: "await reply('收到'); await cutTree(3); await report('完成');",
    });
    expect(codeJob.type).toBe(ExecutionTaskKind.Code);
  });

  it("应将抢占式 task（任务） 映射为 interrupt_then_enqueue（中断后入队）", () => {
    const cancelRoute = createConversationRouteDecision({
      triage: createMessageTriage({
        intent: "cancel",
        priority: "interrupt",
        reason: "owner_cancel",
      }),
      message: "取消",
      has_active_task: true,
    });
    const taskRoute = createConversationRouteDecision({
      triage: createMessageTriage({
        intent: "task",
        priority: "interrupt",
        reason: "owner_replace_task",
      }),
      message: "改成砍两棵树",
      has_active_task: true,
    });
    if (cancelRoute.kind !== "cancel_interrupt") {
      throw new Error("expected cancel_interrupt route");
    }
    if (taskRoute.kind !== "plan_exec") {
      throw new Error("expected plan_exec route");
    }
    expect(taskRoute.needs_memory_search).toBe(false);
    const memoryTaskRoute = createConversationRouteDecision({
      triage: createMessageTriage({
        intent: "task",
        priority: "normal",
        reason: "owner_referenced_history",
      }),
      message: "按以前流程挖矿",
      has_active_task: false,
      needs_memory_search: true,
    });
    expect(memoryTaskRoute.kind).toBe("plan_exec");
    expect(memoryTaskRoute.needs_memory_search).toBe(true);
    const cancelActions = createConversationWorkerActions({
      bot_id: "bot-008",
      route: cancelRoute,
      intent_epoch: 9,
      reply: createCancelTemplateReply(),
    });
    const taskActions = createConversationWorkerActions({
      bot_id: "bot-008",
      route: taskRoute,
      intent_epoch: 10,
      reply: createConversationReply({
        mode: "llm",
        reply: "我改成先砍两棵树",
      }),
      exec_job: createExecJobFromPlan({
        plan: createCodePlanDraft({
          code: "await reply('我改成先砍两棵树喵~'); await cutTree(2); await report('完成喵~');",
        }),
        message_id: "msg-modify",
        intent_epoch: 10,
        snapshot_ts: 124,
        priority: ExecPriority.Urgent,
      }),
    });

    expect(cancelRoute.kind).toBe("cancel_interrupt");
    expect(cancelActions.map((action) => action.type)).toEqual([
      "interrupt_runtime",
      "broadcast_reply",
    ]);
    expect(taskRoute.queue_behavior).toBe("interrupt_then_enqueue");
    expect(taskActions.map((action) => action.type)).toEqual([
      "interrupt_runtime",
      "broadcast_reply",
      "enqueue_exec",
      "emit_task_lifecycle",
    ]);
    expect(taskActions[3]?.type).toBe("emit_task_lifecycle");
    if (taskActions[3]?.type !== "emit_task_lifecycle") {
      throw new Error("expected accepted lifecycle action");
    }
    expect(taskActions[3].lifecycle.status).toBe(TaskHistoryStatus.Accepted);
  });

  it("应拒绝给 cancel（取消） 路径传入非 template（模板） 回复", () => {
    const cancelRoute = createConversationRouteDecision({
      triage: createMessageTriage({
        intent: "cancel",
        priority: "interrupt",
        reason: "owner_cancel",
      }),
      message: "取消",
      has_active_task: true,
    });
    if (cancelRoute.kind !== "cancel_interrupt") {
      throw new Error("expected cancel_interrupt route");
    }

    expect(() =>
      createConversationWorkerActions({
        bot_id: "bot-008",
        route: cancelRoute,
        intent_epoch: 10,
        reply: createConversationReply({
          mode: "llm",
          reply: "我帮你停下来了",
        }),
      } as unknown as Parameters<typeof createConversationWorkerActions>[0]),
    ).toThrow(/template reply/);
  });

  it("应拒绝构造 bot_id（机器人标识） 与消息载荷不一致的对话任务", () => {
    expect(() =>
      createConversationWorkerTask({
        bot_id: "bot-008",
        message: {
          bot_id: "bot-009",
          message_id: "msg-mismatch",
          content: "去砍树",
          intent_epoch: 13,
          snapshot_ts: 161,
        },
      }),
    ).toThrow(/bot_id must match message\.bot_id/);
  });

  it("应把优先级映射到队列侧行为", () => {
    const interruptTaskRoute = createConversationRouteDecision({
      triage: createMessageTriage({
        intent: "task",
        priority: "interrupt",
        reason: "owner_interrupt_task",
      }),
      message: "马上过来",
      has_active_task: true,
    });
    const normalTaskRoute = createConversationRouteDecision({
      triage: createMessageTriage({
        intent: "task",
        priority: "normal",
        reason: "owner_normal_task",
      }),
      message: "去砍树",
      has_active_task: false,
    });

    expect(interruptTaskRoute.kind).toBe("plan_exec");
    expect(interruptTaskRoute.queue_behavior).toBe("interrupt_then_enqueue");
    if (interruptTaskRoute.kind !== "plan_exec") {
      throw new Error("expected plan_exec route");
    }
    expect(interruptTaskRoute.exec_priority).toBe(ExecPriority.Urgent);
    expect(normalTaskRoute.queue_behavior).toBe("enqueue_only");
  });

  it("应为聊天回复、记忆检索与 Bot/Brain Worker 输出动作提供纯函数边界", () => {
    const chatReply = createConversationReply({
      mode: "llm",
      reply: "主人晚上好",
    });
    const workerTask = createConversationWorkerTask({
      bot_id: "bot-008",
      message: {
        bot_id: "bot-008",
        message_id: "msg-chat",
        content: "你还记得上次的矿洞吗",
        intent_epoch: 12,
        snapshot_ts: 160,
      },
    });
    const botTask = createBotWorkerTask({
      bot_id: "bot-008",
      exec_job: createExecJobFromPlan({
        plan: createCodePlanDraft({
          code: "await reply('我去装备一下喵~'); await equip('stone_pickaxe', 'hand'); await report('完成喵~');",
        }),
        message_id: "msg-exec",
        intent_epoch: 13,
        snapshot_ts: 161,
        priority: ExecPriority.Normal,
      }),
      owner_text: "帮我装备石镐",
    });
    const botActions = createBotWorkerActions({
      task: botTask,
      phase: "terminal",
      status: TaskHistoryStatus.Completed,
      total_steps: 1,
      duration_ms: 3200,
    });
    const lifecycleAction = botActions.find((action) => action.type === "emit_task_lifecycle");
    const enqueueBrainAction = botActions.find((action) => action.type === "enqueue_brain");

    if (!enqueueBrainAction) {
      throw new Error("enqueue_brain action missing");
    }
    if (!lifecycleAction || lifecycleAction.type !== "emit_task_lifecycle") {
      throw new Error("emit_task_lifecycle action missing");
    }

    const brainActions = createBrainWorkerActions({
      draft: createTaskEventDraft({
        task_id: enqueueBrainAction.task.payload.task_card.task_id,
        bot_id: enqueueBrainAction.task.payload.bot_id,
        message_id: enqueueBrainAction.task.payload.message_id,
        owner_text: enqueueBrainAction.task.payload.owner_text,
        task_card: enqueueBrainAction.task.payload.task_card,
        embedding: [0.1],
        created_at: "2026-04-26T00:00:00.000Z",
      }),
    });

    expect(ensureReplyEndsWithMeow("好的")).toBe("好的喵~");
    expect(chatReply.reply.endsWith("喵~")).toBe(true);
    expect(
      shouldSearchConversationMemory({
        message: workerTask.message.content,
        triage: { intent: "chat" },
      }),
    ).toBe(true);
    expect(botActions.map((action) => action.type)).toEqual([
      "emit_task_lifecycle",
      "enqueue_brain",
      "persist_sandbox_experience",
    ]);
    expect(lifecycleAction.lifecycle.status).toBe(TaskHistoryStatus.Completed);
    expect(brainActions[0]?.type).toBe("persist_task_event");
  });

  it("应让 BotWorker（机器人工作线程） 将 started / discarded / terminal 分流，并阻止 discarded（已丢弃） 进入 BrainWorker", () => {
    const botTask = createBotWorkerTask({
      bot_id: "bot-008",
      exec_job: createExecJobFromPlan({
        plan: createCodePlanDraft({
          code: "await reply('我去砍树喵~'); await cutTree(1); await report('完成喵~');",
        }),
        message_id: "msg-discarded",
        intent_epoch: 14,
        snapshot_ts: 162,
        priority: ExecPriority.Normal,
      }),
    });
    const startedActions = createBotWorkerActions({
      task: botTask,
      phase: "started",
    });
    const discardedActions = createBotWorkerActions({
      task: botTask,
      phase: "discarded",
      discard_reason: "intent_epoch_stale",
      current_epoch: 15,
    });

    expect(startedActions).toHaveLength(1);
    expect(startedActions[0]?.type).toBe("emit_task_lifecycle");
    if (startedActions[0]?.type !== "emit_task_lifecycle") {
      throw new Error("expected started lifecycle action");
    }
    expect(startedActions[0].lifecycle.status).toBe(TaskHistoryStatus.Started);
    expect(discardedActions).toHaveLength(1);
    expect(discardedActions[0]?.type).toBe("emit_task_lifecycle");
    if (discardedActions[0]?.type !== "emit_task_lifecycle") {
      throw new Error("expected discarded lifecycle action");
    }
    expect(discardedActions[0].lifecycle.status).toBe(TaskHistoryStatus.Discarded);
    if (discardedActions[0].lifecycle.status !== TaskHistoryStatus.Discarded) {
      throw new Error("expected discarded lifecycle payload");
    }
    expect(discardedActions[0].lifecycle.payload.current_epoch).toBe(15);
    expect(discardedActions.some((action) => action.type === "enqueue_brain")).toBe(false);
  });

  it("应拒绝构造缺少 error（错误快照） 的 failed（失败） 终态动作", () => {
    const botTask = createBotWorkerTask({
      bot_id: "bot-008",
      exec_job: createExecJobFromPlan({
        plan: createCodePlanDraft({
          code: "await reply('我去挖矿喵~'); await mine('coal_ore', 1); await report('完成喵~');",
        }),
        message_id: "msg-failed-missing-error",
        intent_epoch: 16,
        snapshot_ts: 163,
        priority: ExecPriority.Urgent,
      }),
    });

    expect(() =>
      createBotWorkerActions({
        task: botTask,
        phase: "terminal",
        status: TaskHistoryStatus.Failed,
        total_steps: 2,
        duration_ms: 1800,
      } as unknown as Parameters<typeof createBotWorkerActions>[0]),
    ).toThrow(/require error/);
  });
});
