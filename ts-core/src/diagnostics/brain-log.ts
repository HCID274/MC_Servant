import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join, posix as pathPosix } from "node:path";

import { isValidStorageRef } from "../data/logs.js";
import { redactLocalDiagnosticJsonText } from "./local-log-redaction.js";

/** BrainWorker（大脑工作线程） 诊断日志行。 */
export type BrainDiagnosticJsonlLine =
  | {
      /** Unix 时间戳（秒）。 */
      readonly t: number;
      /** 事件类型。 */
      readonly event: "brain.task.failed";
      /** 目标 Bot（机器人） 标识。 */
      readonly bot_id?: string;
      /** 原始消息标识。 */
      readonly message_id?: string;
      /** 错误快照。 */
      readonly error: Readonly<{
        /** 错误分类名。 */
        readonly name?: string;
        /** 错误消息。 */
        readonly message: string;
      }>;
    }
  | {
      /** Unix 时间戳（秒）。 */
      readonly t: number;
      /** 事件类型。 */
      readonly event: "brain.rubric.parse_failed";
      /** 目标 Bot（机器人） 标识。 */
      readonly bot_id?: string;
      /** 原始消息标识。 */
      readonly message_id?: string;
      /** 当前模型名。 */
      readonly model: string;
      /** rubric（评分规则） 来源。 */
      readonly source?: "task_event" | "conversation_fact";
      /** 解析错误消息。 */
      readonly error_message: string;
      /** 原始 LLM（大语言模型） 输出。 */
      readonly raw_output: string;
    }
  | {
      /** Unix 时间戳（秒）。 */
      readonly t: number;
      /** 事件类型。 */
      readonly event: "brain.rubric.empty";
      /** 目标 Bot（机器人） 标识。 */
      readonly bot_id: string;
      /** 原始消息标识。 */
      readonly message_id?: string;
      /** rubric（评分规则） 来源。 */
      readonly source: "task_event" | "conversation_fact";
      /** 主人原文。 */
      readonly owner_text: string;
      /** 主人发话时坐标。 */
      readonly owner_position?: Readonly<{
        readonly x: number;
        readonly y: number;
        readonly z: number;
      }>;
      /** 原始候选数。 */
      readonly raw_count: number;
      /** 接受或自动提拔的候选数。 */
      readonly accepted_count: number;
    }
  | {
      /** Unix 时间戳（秒）。 */
      readonly t: number;
      /** 事件类型。 */
      readonly event: "brain.fact.enqueue_failed";
      /** 目标 Bot（机器人） 标识。 */
      readonly bot_id: string;
      /** 原始消息标识。 */
      readonly message_id: string;
      /** fact（事实） 来源路由。 */
      readonly route_kind: "chat_reply" | "plan_exec";
      /** 错误快照。 */
      readonly error: Readonly<{
        readonly name?: string;
        readonly message: string;
      }>;
    };

/** BrainWorker（大脑工作线程） 诊断写入输入。 */
export interface BrainDiagnosticLogInput {
  /** 本地日志引用，固定在 brain（大脑）目录下。 */
  readonly log_ref: string;
  /** 本次诊断生成的 JSONL（结构化日志） 行。 */
  readonly lines: readonly BrainDiagnosticJsonlLine[];
}

/** BrainWorker（大脑工作线程） 诊断写入器。 */
export type BrainDiagnosticLogSink = (input: BrainDiagnosticLogInput) => Promise<void>;

/** 创建 brain（大脑）诊断日志引用。 */
export function createBrainDiagnosticLogRef(input: {
  readonly date: string;
  readonly kind: "task-failed" | "rubric-parse-failed" | "rubric-empty" | "fact-enqueue-failed";
  readonly message_id?: string;
}): string {
  const messageId = createSafeBrainDiagnosticFileName(input.message_id ?? "unknown");
  const ref = pathPosix.join("brain", input.date, `${input.kind}-${messageId}.jsonl`);

  if (!isValidBrainDiagnosticLogRef(ref)) {
    throw new Error(`Invalid brain diagnostic log ref: ${ref}`);
  }

  return ref;
}

/** 创建本地 BrainWorker（大脑工作线程） 诊断 JSONL（结构化日志） 写入器。 */
export function createLocalBrainDiagnosticLogSink(input: {
  readonly baseDir: string;
  readonly sensitiveValues?: readonly string[];
}): BrainDiagnosticLogSink {
  return async (record) => {
    if (!isValidBrainDiagnosticLogRef(record.log_ref)) {
      throw new Error(`Invalid brain diagnostic log ref: ${record.log_ref}`);
    }

    const filePath = join(input.baseDir, ...record.log_ref.split("/"));
    const content = record.lines
      .map((line) =>
        redactLocalDiagnosticJsonText(JSON.stringify(line), input.sensitiveValues ?? []),
      )
      .join("\n");

    await mkdir(dirname(filePath), { recursive: true });
    await appendFile(filePath, `${content}\n`, "utf8");
  };
}

function isValidBrainDiagnosticLogRef(value: string): boolean {
  return value.startsWith("brain/") && value.endsWith(".jsonl") && isValidStorageRef(value);
}

function createSafeBrainDiagnosticFileName(value: string): string {
  const normalized = value.trim().replace(/[^A-Za-z0-9._-]+/gu, "_");

  return normalized.length === 0 ? "unknown" : normalized;
}
