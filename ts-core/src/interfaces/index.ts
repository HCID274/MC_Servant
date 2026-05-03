/**
 * 外部接入与接口契约模块。
 *
 * 1. 通讯协议定义：定义 HTTP API 路由、实时推送（Realtime）和 Server Bridge 的消息包结构。
 * 2. 入口（Ingress）标准化：统一 Web 端、Minecraft 游戏内聊天和跨服桥接的输入边界。
 * 3. 状态投影：将系统内部的运行时状态或执行结果投影为外部可直接消费的响应格式（如 Health, Status）。
 * 4. 鉴权与会话：管理面向接口层的 Session 与令牌，维护外部接入的安全边界。
 */

import type { ModuleBoundary } from "../domain/contracts.js";

/**
 * interfaces（接口层） 模块边界声明。
 *
 * 1. 边界定义：明确接口层在通讯协议、入口标准化、状态投影及安全鉴权四个维度的职责。
 * 2. 拓扑管理：作为系统级模块清单的一项，定义其在全局架构中的定位。
 */
export const interfacesModuleBoundary: ModuleBoundary = {
  moduleName: "interfaces",
  responsibilities: [
    "声明 HTTP（超文本传输协议） 路由输入输出契约",
    "收口会话 / token（令牌） 鉴权边界",
    "复用 runtime（运行时） 事件命名构造实时推送与 replay（补拉） 模型",
    "统一网页端、游戏聊天与服务端桥接的 ingress（入口） 标准化边界",
  ],
  placeholderExports: [
    "API_ROUTE_DEFINITIONS",
    "createSessionRecord",
    "createWebMessageEnvelope",
    "createInterfaceExternalAuthSnapshot",
    "createGameChatIngressDecision",
    "createServerBridgeEventEnvelope",
    "createStatusResponse",
    "createReplayResponse",
    "createRealtimeEventEnvelope",
    "createInterfaceServerRuntime",
  ],
};

export * from "./contracts.js";
export * from "./control-fast-path.js";
export * from "./api.js";
export * from "./realtime.js";
export * from "./errors.js";
export * from "./server.js";
export * from "./game-chat/index.js";
export * from "./server-bridge/index.js";
