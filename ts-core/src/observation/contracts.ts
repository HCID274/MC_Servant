/**
 * observation（观测）契约兼容入口。
 *
 * 纯观测与威胁评估端口已下沉到 core-ports（核心端口层）；observation（观测） 模块只保留重新导出。
 */

export * from "../core-ports/observation.js";
