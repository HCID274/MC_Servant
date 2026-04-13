import type { ModuleBoundary } from "../domain/contracts.js";

/** diagnostics 模块边界声明。 */
export const diagnosticsModuleBoundary = {
  moduleName: "diagnostics",
  responsibilities: [
    "定义 tasks、sandbox、llm 三类 JSONL 日志行契约",
    "统一诊断通道目录、保留期与 log_ref/code_ref 校验规则",
  ],
  placeholderExports: [
    "diagnosticsModuleBoundary",
    "createDiagnosticsCatalog",
    "createTaskLogLine",
    "createSandboxLogLine",
  ],
} satisfies ModuleBoundary;

export * from "./contracts.js";
export * from "./logs.js";
