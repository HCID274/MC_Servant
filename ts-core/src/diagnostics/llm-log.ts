import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { LlmJsonlLine } from "./contracts.js";
import { redactLocalDiagnosticJsonText } from "./local-log-redaction.js";
import { assertDiagnosticStorageRef } from "./logs.js";

/** LLM（大语言模型） 本地 JSONL（结构化日志） 写入输入。 */
export interface LlmDiagnosticLogInput {
  /** 结构化日志引用，必须指向 llm（大语言模型） 通道。 */
  readonly log_ref: string;
  /** 本次调用生成的 JSONL（结构化日志） 行。 */
  readonly lines: readonly LlmJsonlLine[];
}

/** LLM（大语言模型） 本地 JSONL（结构化日志） 写入函数。 */
export type LlmDiagnosticLogSink = (input: LlmDiagnosticLogInput) => Promise<void>;

/** 创建本地 LLM（大语言模型） JSONL（结构化日志） 写入器。 */
export function createLocalLlmDiagnosticLogSink(input: {
  readonly baseDir: string;
  readonly sensitiveValues?: readonly string[];
}): LlmDiagnosticLogSink {
  return async (record) => {
    assertDiagnosticStorageRef({
      channel: "llm",
      refField: "log_ref",
      value: record.log_ref,
    });

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
