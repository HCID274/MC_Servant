import type { ModuleBoundary } from "../domain/contracts.js";

/** observation 模块边界声明。 */
export const observationModuleBoundary = {
  moduleName: "observation",
  responsibilities: ["统一 Mineflayer 与 JAR Bridge 的只读快照契约", "提供威胁评估与只读观察边界"],
  placeholderExports: [
    "observationModuleBoundary",
    "createObservationReadBoundary",
    "createEnvironmentSnapshot",
    "assessThreat",
  ],
} satisfies ModuleBoundary;

export * from "./contracts.js";
export * from "./snapshot.js";
