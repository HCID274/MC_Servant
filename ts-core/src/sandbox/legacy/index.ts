/**
 * 沙箱旧 Facade 契约入口。
 *
 * 该入口只服务历史回放、迁移测试与负向测试。在线沙箱代码不得通过这里恢复
 * api.bot/api.chat 或 prompt index 执行面。
 */

export * from "./facade.js";
export type { SandboxFacadeContract } from "../contracts.js";
