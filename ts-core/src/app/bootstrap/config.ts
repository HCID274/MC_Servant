import type { DataConfigEnvironment } from "../../data/index.js";
import { asOptionalPlainObject } from "./env.js";

/** 提取数据层机器人配置。 */
export function selectDataBotConfig(input: unknown): unknown {
  const botConfig = asOptionalPlainObject(input, "botConfig");

  if (botConfig === undefined) {
    return undefined;
  }

  const dataBotConfig: Record<string, unknown> = {};

  if (botConfig.logs !== undefined) {
    dataBotConfig.logs = botConfig.logs;
  }

  if (botConfig.embedding !== undefined) {
    dataBotConfig.embedding = botConfig.embedding;
  }

  return Object.keys(dataBotConfig).length === 0 ? undefined : dataBotConfig;
}
