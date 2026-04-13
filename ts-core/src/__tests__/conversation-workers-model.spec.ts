import { describe, expect, it } from "vitest";

import {
  BotStatus,
  type ConversationPlanningTriage,
  ConversationPriority,
  type ConversationSandboxCodePlanDraft,
  type ConversationSkillCallPlanDraft,
  ExecPriority,
  ExecutionTaskKind,
  MessageSource,
  TaskHistoryStatus,
  createBotWorkerActions,
  createBotWorkerTask,
  createBrainWorkerActions,
  createCancelTemplateReply,
  createConversationPlanningContext,
  createConversationReply,
  createConversationRouteDecision,
  createConversationWorkerActions,
  createConversationWorkerTask,
  createExecJobFromPlan,
  createExecQueueName,
  createMessageQueueName,
  createMessageTriage,
  createSandboxCodePlanDraft,
  createSkillCallPlanDraft,
  createWorkerQueueCatalog,
  ensureReplyEndsWithMeow,
  shouldSearchConversationMemory,
} from "../index.js";

// @ts-expect-error `follow`（跟随） 尚未进入 Phase 1（第一阶段） 技能目录。
const invalidSkillName: ConversationSkillCallPlanDraft["skill"] = "follow";
void invalidSkillName;

// @ts-expect-error `sandbox_code`（沙箱代码） 规划产物的类型固定不可改成 `skill_call`（技能调用）。
const invalidSandboxPlanType: ConversationSandboxCodePlanDraft["type"] =
  ExecutionTaskKind.SkillCall;
void invalidSandboxPlanType;

// @ts-expect-error 规划上下文只接受 `task`（任务） / `modify`（修改） 意图。
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

  it("应让 skill_call（技能调用） / sandbox_code（沙箱代码） 双路径严格对齐现有执行契约", () => {
    const skillPlan = createSkillCallPlanDraft({
      reply: "我这就去砍树",
      skill: "cutTree",
      params: { count: 3 },
    });
    const sandboxPlan = createSandboxCodePlanDraft({
      reply: "我先去看一眼再决定",
      code: "await api.chat.say('收到');",
    });
    const skillJob = createExecJobFromPlan({
      plan: skillPlan,
      message_id: "msg-skill",
      intent_epoch: 7,
      snapshot_ts: 100,
      priority: ExecPriority.Urgent,
    });
    const sandboxJob = createExecJobFromPlan({
      plan: sandboxPlan,
      message_id: "msg-code",
      intent_epoch: 8,
      snapshot_ts: 101,
      priority: ExecPriority.Normal,
    });

    expect(skillPlan.skill).toBe("cutTree");
    expect(skillJob.type).toBe(ExecutionTaskKind.SkillCall);
    if (skillJob.type !== ExecutionTaskKind.SkillCall) {
      throw new Error("expected skill_call job");
    }
    expect(skillJob.skill).toBe("cutTree");
    expect(sandboxPlan.type).toBe(ExecutionTaskKind.SandboxCode);
    expect(sandboxJob.type).toBe(ExecutionTaskKind.SandboxCode);
  });

  it("应将 cancel（取消） 与 modify（修改） 分流为不同的中断桥接行为", () => {
    const cancelRoute = createConversationRouteDecision({
      triage: createMessageTriage({
        intent: "cancel",
        priority: "interrupt",
        reason: "owner_cancel",
      }),
      message: "取消",
      has_active_task: true,
    });
    const modifyRoute = createConversationRouteDecision({
      triage: createMessageTriage({
        intent: "modify",
        priority: "urgent",
        reason: "owner_modify",
      }),
      message: "改成砍两棵树",
      has_active_task: true,
    });
    if (cancelRoute.kind !== "cancel_interrupt") {
      throw new Error("expected cancel_interrupt route");
    }
    if (modifyRoute.kind !== "modify_interrupt_then_plan") {
      throw new Error("expected modify_interrupt_then_plan route");
    }
    const cancelActions = createConversationWorkerActions({
      bot_id: "bot-008",
      route: cancelRoute,
      intent_epoch: 9,
      reply: createCancelTemplateReply(),
    });
    const modifyActions = createConversationWorkerActions({
      bot_id: "bot-008",
      route: modifyRoute,
      intent_epoch: 10,
      reply: createConversationReply({
        mode: "llm",
        reply: "我改成先砍两棵树",
      }),
      exec_job: createExecJobFromPlan({
        plan: createSkillCallPlanDraft({
          reply: "我改成先砍两棵树",
          skill: "cutTree",
          params: { count: 2 },
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
    expect(modifyRoute.kind).toBe("modify_interrupt_then_plan");
    expect(modifyActions.map((action) => action.type)).toEqual([
      "interrupt_runtime",
      "broadcast_reply",
      "enqueue_exec",
    ]);
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

  it("应把优先级映射到队列侧行为，并在 modify 规划时要求被中断任务摘要", () => {
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
    expect(() =>
      createConversationPlanningContext({
        message: {
          bot_id: "bot-008",
          message_id: "msg-ctx",
          content: "改一下",
          source: MessageSource.Web,
          intent_epoch: 11,
          snapshot_ts: 150,
          bot_status: BotStatus.EXECUTING,
          created_at: "2026-04-14T00:00:00.000Z",
        },
        triage: {
          intent: "modify",
          priority: ConversationPriority.Urgent,
          reason: "modify",
        },
        snapshot_context: "[Bot] 位置:(0,64,0)",
      }),
    ).toThrow(/interrupted_task/);
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
        plan: createSkillCallPlanDraft({
          reply: "我去装备一下",
          skill: "equip",
          params: { itemName: "stone_pickaxe", destination: "hand" },
        }),
        message_id: "msg-exec",
        intent_epoch: 13,
        snapshot_ts: 161,
        priority: ExecPriority.Normal,
      }),
    });
    const botActions = createBotWorkerActions({
      task: botTask,
      status: TaskHistoryStatus.Completed,
    });
    const enqueueBrainAction = botActions.find((action) => action.type === "enqueue_brain");

    if (!enqueueBrainAction) {
      throw new Error("enqueue_brain action missing");
    }

    const brainActions = createBrainWorkerActions({
      task: enqueueBrainAction.task,
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
      "emit_task_terminal",
      "enqueue_brain",
    ]);
    expect(brainActions[0]?.type).toBe("persist_task_summary");
  });
});
