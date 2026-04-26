/**
 * 运行时任务兼容入口。
 *
 * ExecJob（执行任务） 与任务生命周期端口已下沉到 core-ports（核心端口层）；
 * runtime（运行时） 模块保留重新导出，避免旧导入点一次性迁移。
 */

export * from "../core-ports/tasking.js";
