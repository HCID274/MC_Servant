/**
 * ConversationWorker 真实运行时。
 *
 * 1. 消息消费：作为 BullMQ 消费者，持续拉取并处理 `msg:{botId}` 队列中的入站用户消息。
 * 2. 意图分诊：调用底层分诊逻辑识别意图（如闲聊、规划），在无真实大模型环境时提供安全兜底与模板回复。
 * 3. 动作分发：根据分诊结果，安全地向 BotActor 单写者汇点提交聊天回复，或将规划任务推入执行队列。
 */

import { Worker, type WorkerOptions } from "bullmq";

import { createCancelTemplateReply, createConversationReply } from "../conversation/chat.js";
import type {
  ConversationPlanDraft,
  ConversationPlanningTriage,
  ConversationRouteDecision,
} from "../conversation/contracts.js";
import {
  type ConversationGeneratedReply,
  ConversationLlmChatError,
  type ConversationLlmDiagnosticRecord,
} from "../conversation/llm.js";
import { createExecJobFromPlan } from "../conversation/planning.js";
import { createConversationRouteDecision, createMessageTriage } from "../conversation/triage.js";
import { ConversationPriority, type MessageTriage } from "../core-ports/foundation.js";
import type { SkillName } from "../core-ports/skills.js";
import { ExecPriority, TaskHistoryStatus } from "../core-ports/tasking.js";
import type { RedisClientLike } from "../db/index.js";
import { createBullmqPhysicalQueueName } from "./bullmq.js";
import {
  type BotWorkerTask,
  type ConversationWorkerTask,
  type InterruptRuntimeAction,
  createBotWorkerTask,
  createConversationWorkerActions,
  createConversationWorkerTask,
} from "./contracts.js";
import type { MessageQueueName } from "./queues.js";

/** ConversationWorker（对话工作线程） 处理过程事件。 */
export type ConversationWorkerRuntimeEvent =
  | {
      /** 事件类型。 */
      readonly type: "chat.reply";
      /** 目标 Bot 标识。 */
      readonly bot_id: string;
      /** 原始消息标识。 */
      readonly message_id: string;
      /** 回复内容。 */
      readonly content: string;
    }
  | {
      /** 事件类型。 */
      readonly type: "llm.chat.diagnostic";
      /** 目标 Bot 标识。 */
      readonly bot_id: string;
      /** 调用阶段。 */
      readonly stage: ConversationLlmDiagnosticRecord["stage"];
      /** 原始消息标识。 */
      readonly message_id: string;
      /** 模型名。 */
      readonly model: string;
      /** 日志引用。 */
      readonly log_ref: string;
      /** 创建时间。 */
      readonly created_at: string;
      /** 是否成功。 */
      readonly ok: boolean;
      /** 失败摘要。 */
      readonly error_summary?: string;
    }
  | {
      /** 事件类型。 */
      readonly type: "cancel.logged";
      /** 目标 Bot 标识。 */
      readonly bot_id: string;
      /** 原始消息标识。 */
      readonly message_id: string;
      /** 取消原因。 */
      readonly reason: string;
    }
  | {
      /** 事件类型。 */
      readonly type: "task.discarded";
      /** 目标 Bot 标识。 */
      readonly bot_id: string;
      /** 原始消息标识。 */
      readonly message_id: string;
      /** 任务历史状态。 */
      readonly status: TaskHistoryStatus.Discarded;
      /** 丢弃原因。 */
      readonly reason: "planner_unavailable" | "planner_failed";
    }
  | {
      /** 事件类型。 */
      readonly type: "task.accepted";
      /** 目标 Bot 标识。 */
      readonly bot_id: string;
      /** 原始消息标识。 */
      readonly message_id: string;
      /** 技能名。 */
      readonly skill: SkillName;
      /** 执行队列优先级。 */
      readonly priority: ExecPriority;
    };

/** ConversationWorker（对话工作线程） 广播回复汇点。 */
export type ConversationBroadcastReplySink = (input: {
  /** 原始消息标识。 */
  readonly message_id: string;
  /** 回复内容。 */
  readonly content: string;
}) => Promise<unknown>;

/** ConversationWorker（对话工作线程） 执行任务入队汇点。 */
export type ConversationEnqueueExecTaskSink = (input: {
  /** BotWorker（机器人工作线程） 可消费任务。 */
  readonly task: BotWorkerTask;
  /** BullMQ（任务队列） 数值优先级。 */
  readonly priority: number;
}) => Promise<unknown>;

/** ConversationWorker（对话工作线程） 运行时中断汇点。 */
export type ConversationInterruptRuntimeSink = (input: {
  /** 目标 Bot 标识。 */
  readonly bot_id: string;
  /** 运行时中断信号。 */
  readonly signal: InterruptRuntimeAction["signal"];
}) => Promise<unknown>;

/** ConversationWorker（对话工作线程） 分诊依赖。 */
export type ConversationWorkerTriage = (input: {
  /** Worker 输入任务。 */
  readonly task: ConversationWorkerTask;
}) => MessageTriage | Promise<MessageTriage>;

/** ConversationWorker（对话工作线程） 回复生成依赖。 */
export type ConversationWorkerReplyGenerator = (input: {
  /** Worker 输入任务。 */
  readonly task: ConversationWorkerTask;
  /** 已清洗的分诊结果。 */
  readonly triage: MessageTriage;
  /** 路由决策。 */
  readonly route: ConversationRouteDecision;
}) => string | ConversationGeneratedReply | Promise<string | ConversationGeneratedReply>;

/** ConversationWorker（对话工作线程） 最小规划依赖。 */
export type ConversationWorkerPlanner = (input: {
  /** Worker 输入任务。 */
  readonly task: ConversationWorkerTask;
  /** 已收紧到可规划意图的分诊结果。 */
  readonly triage: ConversationPlanningTriage;
  /** 已收紧到规划分支的路由。 */
  readonly route: Extract<
    ConversationRouteDecision,
    { readonly kind: "plan_exec" | "modify_interrupt_then_plan" }
  >;
}) => ConversationPlanDraft | Promise<ConversationPlanDraft>;

/** ConversationWorker（对话工作线程） BullMQ（任务队列） Worker 最小能力。 */
export interface ConversationBullmqWorkerLike {
  /** 关闭 Worker（工作线程）。 */
  close(): Promise<unknown>;
}

/** ConversationWorker（对话工作线程） 创建 Worker 的注入函数。 */
export type CreateConversationBullmqWorker = (input: {
  /** 队列名称。 */
  readonly queueName: MessageQueueName;
  /** Redis（缓存） 连接。 */
  readonly connection: RedisClientLike;
  /** BullMQ（任务队列） job 处理器。 */
  readonly processor: (job: { readonly data: unknown }) => Promise<void>;
}) => ConversationBullmqWorkerLike;

/** ConversationWorker（对话工作线程） 依赖注入集合。 */
export interface ConversationWorkerRuntimeDependencies {
  /** 分诊函数，默认安全回退为 chat/normal。 */
  readonly triage?: ConversationWorkerTriage;
  /** 回复生成函数，默认生成模板闲聊回复。 */
  readonly replyGenerator?: ConversationWorkerReplyGenerator;
  /** 最小规划函数，成功时返回可执行规划草案。 */
  readonly planner?: ConversationWorkerPlanner;
  /** 广播回复汇点，真实路径指向 BotActor.broadcastReply。 */
  readonly broadcastReplySink: ConversationBroadcastReplySink;
  /** 运行时中断汇点，真实路径指向 BotActor 中断入口。 */
  readonly interruptRuntimeSink?: ConversationInterruptRuntimeSink;
  /** 执行任务入队汇点，真实路径指向 `bot:{botId}:exec`（执行队列）。 */
  readonly enqueueExecTaskSink?: ConversationEnqueueExecTaskSink;
  /** 当前是否已有活跃任务。 */
  readonly hasActiveTask?: () => boolean;
  /** 可注入 BullMQ（任务队列） Worker 工厂。 */
  readonly createWorker?: CreateConversationBullmqWorker;
}

/** ConversationWorker（对话工作线程） 运行时输入队列。 */
export interface ConversationWorkerRuntimeQueue {
  /** 队列名称。 */
  readonly name: MessageQueueName;
  /** Redis（缓存） 连接。 */
  readonly connection: RedisClientLike;
}

/** ConversationWorker（对话工作线程） 运行时句柄。 */
export interface ConversationWorkerRuntime {
  /** 消费的队列名。 */
  readonly queue_name: MessageQueueName;
  /** 启动 BullMQ（任务队列） Worker。 */
  start(): Promise<void>;
  /** 关闭 BullMQ（任务队列） Worker。 */
  close(): Promise<void>;
  /** 获取处理过程事件快照。 */
  getEvents(): readonly ConversationWorkerRuntimeEvent[];
}
/** 创建默认的对话处理工作线程。 */

function createDefaultConversationWorker(input: {
  queueName: MessageQueueName;
  connection: RedisClientLike;
  processor: (job: { readonly data: unknown }) => Promise<void>;
}): ConversationBullmqWorkerLike {
  return new Worker(createBullmqPhysicalQueueName(input.queueName), input.processor, {
    connection: input.connection as WorkerOptions["connection"],
  });
}
/** 生成默认的对话意图分诊结果。 */

function createDefaultTriage(): MessageTriage {
  return createMessageTriage({
    intent: "chat",
    priority: ConversationPriority.Normal,
    reason: "conversation_worker_fallback",
  });
}
/** 克隆并校验对话任务数据。 */

function cloneWorkerTask(data: unknown): ConversationWorkerTask {
  const candidate = data as ConversationWorkerTask;

  return createConversationWorkerTask({
    bot_id: candidate.bot_id,
    message: candidate.message,
  });
}
/** 将系统执行优先级映射到队列数值。 */

function toBullmqPriority(priority: ExecPriority): number {
  switch (priority) {
    case ExecPriority.Urgent:
      return 1;
    case ExecPriority.Normal:
      return 5;
    case ExecPriority.Background:
      return 10;
  }
}

/**
 * 创建任务规划失败的模板回复。
 *
 * 当前阶段不把规划失败伪装成闲聊；统一返回明确失败回执。
 */
function createPlanningFailureReply() {
  return createConversationReply({
    mode: "template",
    reply: "抱歉，这次我还没能规划出可执行的技能任务喵~",
  });
}

/**
 * 归一化回复生成结果。
 *
 * @param result 回复生成器返回值
 * @returns 统一后的回复结构
 */
function normalizeGeneratedReply(
  result: string | ConversationGeneratedReply,
): ConversationGeneratedReply {
  if (typeof result === "string") {
    return Object.freeze({
      mode: "template",
      reply: result,
    });
  }

  return Object.freeze({
    ...result,
    ...(result.diagnostics === undefined ? {} : { diagnostics: result.diagnostics }),
  });
}

/**
 * 记录 LLM（大语言模型） 诊断事件。
 *
 * @param events 事件列表
 * @param botId Bot 标识
 * @param diagnostics 诊断摘要
 */
function appendLlmDiagnosticEvent(
  events: ConversationWorkerRuntimeEvent[],
  botId: string,
  diagnostics: ConversationLlmDiagnosticRecord,
): void {
  events.push(
    Object.freeze({
      type: "llm.chat.diagnostic",
      bot_id: botId,
      stage: diagnostics.stage,
      message_id: diagnostics.message_id,
      model: diagnostics.model,
      log_ref: diagnostics.log_ref,
      created_at: diagnostics.created_at,
      ok: diagnostics.ok,
      ...(diagnostics.error_summary === undefined
        ? {}
        : { error_summary: diagnostics.error_summary }),
    }),
  );
}

/**
 * 创建 ConversationWorker 真实运行时。
 *
 * 1. 消息轮询：作为守护进程持续监听指定的 BullMQ 消息队列，获取前端或游戏内抛出的原始对话事件。
 * 2. 意图分诊：结合上下文信息（如当前是否有执行中任务），动态判断用户意图并产出路由决策。
 * 3. 动作桥接：将闲聊路由映射为广播回复，将规划任务（如确定的 goTo 命令）转换后推入底层执行队列。
 *
 * @param input 包含队列连接与运行时依赖的输入
 * @returns 对话工作线程运行时句柄
 */
export function createConversationWorkerRuntime(input: {
  /** 待消费的消息队列。 */
  readonly queue: ConversationWorkerRuntimeQueue;
  /** 运行时依赖注入。 */
  readonly dependencies: ConversationWorkerRuntimeDependencies;
}): ConversationWorkerRuntime {
  let worker: ConversationBullmqWorkerLike | null = null;
  const events: ConversationWorkerRuntimeEvent[] = [];
  const createWorker = input.dependencies.createWorker ?? createDefaultConversationWorker;

  const processTask = async (job: { readonly data: unknown }): Promise<void> => {
    const task = cloneWorkerTask(job.data);
    const triage = await (input.dependencies.triage?.({ task }) ?? createDefaultTriage());
    const route = createConversationRouteDecision({
      triage,
      message: task.message.content,
      has_active_task: input.dependencies.hasActiveTask?.() ?? false,
    });

    switch (route.kind) {
      case "chat_reply": {
        try {
          const generatedReply = normalizeGeneratedReply(
            (await input.dependencies.replyGenerator?.({ task, triage, route })) ??
              `收到：${task.message.content}`,
          );
          if (generatedReply.diagnostics !== undefined) {
            appendLlmDiagnosticEvent(events, task.bot_id, generatedReply.diagnostics);
          }
          const reply =
            generatedReply.mode === "llm"
              ? createConversationReply({
                  mode: "llm",
                  reply: generatedReply.reply,
                })
              : createConversationReply({
                  mode: "template",
                  reply: generatedReply.reply,
                });

          await input.dependencies.broadcastReplySink({
            message_id: task.message.message_id,
            content: reply.reply,
          });
          events.push(
            Object.freeze({
              type: "chat.reply",
              bot_id: task.bot_id,
              message_id: task.message.message_id,
              content: reply.reply,
            }),
          );
        } catch (error) {
          if (error instanceof ConversationLlmChatError) {
            appendLlmDiagnosticEvent(events, task.bot_id, error.diagnostics);
          }
          throw error;
        }
        break;
      }
      case "cancel_interrupt":
        for (const action of createConversationWorkerActions({
          bot_id: task.bot_id,
          route,
          intent_epoch: task.message.intent_epoch,
          reply: createCancelTemplateReply(),
        })) {
          switch (action.type) {
            case "interrupt_runtime":
              if (input.dependencies.interruptRuntimeSink === undefined) {
                throw new Error("cancel route requires interruptRuntimeSink");
              }

              await input.dependencies.interruptRuntimeSink({
                bot_id: action.bot_id,
                signal: action.signal,
              });
              break;
            case "broadcast_reply":
              await input.dependencies.broadcastReplySink({
                message_id: task.message.message_id,
                content: action.reply.reply,
              });
              events.push(
                Object.freeze({
                  type: "chat.reply",
                  bot_id: task.bot_id,
                  message_id: task.message.message_id,
                  content: action.reply.reply,
                }),
              );
              break;
            default:
              throw new Error(`cancel route produced unsupported action: ${action.type}`);
          }
        }

        events.push(
          Object.freeze({
            type: "cancel.logged",
            bot_id: task.bot_id,
            message_id: task.message.message_id,
            reason: route.triage.reason,
          }),
        );
        break;
      case "plan_exec":
      case "modify_interrupt_then_plan": {
        const plannerFailureReply = createPlanningFailureReply();

        if (input.dependencies.planner === undefined) {
          await input.dependencies.broadcastReplySink({
            message_id: task.message.message_id,
            content: plannerFailureReply.reply,
          });
          events.push(
            Object.freeze({
              type: "chat.reply",
              bot_id: task.bot_id,
              message_id: task.message.message_id,
              content: plannerFailureReply.reply,
            }),
          );
          events.push(
            Object.freeze({
              type: "task.discarded",
              bot_id: task.bot_id,
              message_id: task.message.message_id,
              status: TaskHistoryStatus.Discarded,
              reason: "planner_unavailable",
            }),
          );
          break;
        }

        let plan: ConversationPlanDraft;
        try {
          plan = await input.dependencies.planner({
            task,
            triage: route.triage,
            route,
          });
        } catch {
          await input.dependencies.broadcastReplySink({
            message_id: task.message.message_id,
            content: plannerFailureReply.reply,
          });
          events.push(
            Object.freeze({
              type: "chat.reply",
              bot_id: task.bot_id,
              message_id: task.message.message_id,
              content: plannerFailureReply.reply,
            }),
          );
          events.push(
            Object.freeze({
              type: "task.discarded",
              bot_id: task.bot_id,
              message_id: task.message.message_id,
              status: TaskHistoryStatus.Discarded,
              reason: "planner_failed",
            }),
          );
          break;
        }

        if (input.dependencies.enqueueExecTaskSink === undefined) {
          throw new Error("planning route requires enqueueExecTaskSink");
        }

        const execJob = createExecJobFromPlan({
          plan,
          message_id: task.message.message_id,
          intent_epoch: task.message.intent_epoch,
          snapshot_ts: task.message.snapshot_ts,
          priority: route.exec_priority,
        });

        if (execJob.type !== "skill_call") {
          await input.dependencies.broadcastReplySink({
            message_id: task.message.message_id,
            content: plannerFailureReply.reply,
          });
          events.push(
            Object.freeze({
              type: "chat.reply",
              bot_id: task.bot_id,
              message_id: task.message.message_id,
              content: plannerFailureReply.reply,
            }),
          );
          events.push(
            Object.freeze({
              type: "task.discarded",
              bot_id: task.bot_id,
              message_id: task.message.message_id,
              status: TaskHistoryStatus.Discarded,
              reason: "planner_failed",
            }),
          );
          break;
        }

        if (route.requires_interrupt) {
          if (input.dependencies.interruptRuntimeSink === undefined) {
            throw new Error("planning route requires interruptRuntimeSink");
          }

          await input.dependencies.interruptRuntimeSink({
            bot_id: task.bot_id,
            signal: {
              source: {
                type: "triage",
                intent_epoch: task.message.intent_epoch,
              },
              reason: route.kind === "modify_interrupt_then_plan" ? "modify" : route.triage.reason,
            },
          });
        }

        const reply = createConversationReply({
          mode: "llm",
          reply: plan.reply,
        });
        await input.dependencies.broadcastReplySink({
          message_id: task.message.message_id,
          content: reply.reply,
        });
        events.push(
          Object.freeze({
            type: "chat.reply",
            bot_id: task.bot_id,
            message_id: task.message.message_id,
            content: reply.reply,
          }),
        );

        const botTask = createBotWorkerTask({
          bot_id: task.bot_id,
          exec_job: execJob,
        });
        await input.dependencies.enqueueExecTaskSink({
          task: botTask,
          priority: toBullmqPriority(execJob.priority),
        });

        if (execJob.type === "skill_call") {
          events.push(
            Object.freeze({
              type: "task.accepted",
              bot_id: task.bot_id,
              message_id: task.message.message_id,
              skill: execJob.skill,
              priority: execJob.priority,
            }),
          );
        }
        break;
      }
    }
  };

  return Object.freeze({
    queue_name: input.queue.name,
    async start(): Promise<void> {
      if (worker !== null) {
        return;
      }

      worker = createWorker({
        queueName: input.queue.name,
        connection: input.queue.connection,
        processor: processTask,
      });
    },
    async close(): Promise<void> {
      const currentWorker = worker;
      worker = null;
      await currentWorker?.close();
    },
    getEvents(): readonly ConversationWorkerRuntimeEvent[] {
      return Object.freeze([...events]);
    },
  });
}
