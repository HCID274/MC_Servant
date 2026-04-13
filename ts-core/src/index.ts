import { dataModuleBoundary } from "./data/index.js";
import { diagnosticsModuleBoundary } from "./diagnostics/index.js";
import { domainModuleBoundary } from "./domain/index.js";
import { observationModuleBoundary } from "./observation/index.js";
import { runtimeModuleBoundary } from "./runtime/index.js";
import { skillsModuleBoundary } from "./skills/index.js";
import { worldModelModuleBoundary } from "./world-model/index.js";

/** TS Core 的模块边界清单。 */
export const coreModuleBoundaries = [
  runtimeModuleBoundary,
  skillsModuleBoundary,
  observationModuleBoundary,
  worldModelModuleBoundary,
  diagnosticsModuleBoundary,
  domainModuleBoundary,
  dataModuleBoundary,
] as const;

export * from "./runtime/index.js";
export * from "./skills/index.js";
export * from "./observation/index.js";
export * from "./world-model/index.js";
export * from "./diagnostics/index.js";
export * from "./domain/index.js";
export * from "./data/index.js";
