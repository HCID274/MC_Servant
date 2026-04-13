import type { ModuleBoundary } from "../domain/contracts.js";

/** interfaces（接口层） 模块边界声明。 */
export const interfacesModuleBoundary: ModuleBoundary = {
  moduleName: "interfaces",
  responsibilities: [
    "声明 HTTP（超文本传输协议） 路由输入输出契约",
    "收口会话 / token（令牌） 鉴权边界",
    "复用 runtime（运行时） 事件命名构造实时推送与 replay（补拉） 模型",
  ],
  placeholderExports: [
    "API_ROUTE_DEFINITIONS",
    "createSessionRecord",
    "createStatusResponse",
    "createReplayResponse",
    "createRealtimeEventEnvelope",
  ],
};

export * from "./contracts.js";
export * from "./api.js";
export * from "./realtime.js";
