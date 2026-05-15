import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { isValidStorageRef } from "../data/index.js";

/** 创建任务 JSONL（结构化日志） 摘要读取器，最多返回前 50 行。 */
export function createLocalTaskLogExcerptReader(input: {
  /** logs（日志） 根目录。 */
  readonly baseDir: string;
  /** 最大读取行数。 */
  readonly maxLines?: number;
}): (logRef: string) => Promise<string | undefined> {
  const maxLines = input.maxLines ?? 50;

  return async (logRef) => {
    if (!isValidStorageRef(logRef)) {
      return undefined;
    }

    try {
      const content = await readFile(join(input.baseDir, logRef), "utf8");

      return content.split(/\r?\n/u).filter(Boolean).slice(0, maxLines).join("\n");
    } catch (error) {
      console.warn("[diagnostics] task log excerpt read failed", {
        log_ref: logRef,
        error_summary: summarizeError(error),
      });
      return undefined;
    }
  };
}

function summarizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
