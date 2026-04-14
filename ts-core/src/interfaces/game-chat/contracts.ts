import { MessageSource } from "../../domain/contracts.js";
import { type InterfaceMessageEnvelope, createInterfaceMessageEnvelope } from "../contracts.js";

/** 游戏聊天入口固定使用的通道名。 */
export const GAME_CHAT_CHANNEL = "game_chat" as const;

/** 游戏聊天入口固定使用的来源。 */
export const GAME_CHAT_SOURCE = MessageSource.Game;

/** Phase 1（第一阶段） 游戏主人命令的固定前缀。 */
export const GAME_CHAT_COMMAND_PREFIX = "/svs" as const;

/** 游戏聊天入口的主人绑定解析状态集合。 */
export const GAME_CHAT_OWNER_RESOLUTION_STATES = [
  "matched_owner",
  "non_owner",
  "missing_owner_binding",
] as const;

/** 游戏聊天入口的主人绑定解析状态联合类型。 */
export type GameChatOwnerResolutionState = (typeof GAME_CHAT_OWNER_RESOLUTION_STATES)[number];

/** 游戏聊天入口的原始候选消息结构。 */
export interface GameChatIngressCandidate {
  /** 目标 Bot 标识。 */
  readonly bot_id: string;
  /** 已解析出的内部主人标识；`null` 表示当前输入未命中主人绑定。 */
  readonly owner_id: string | null;
  /** 游戏聊天发送者标识，例如 MC（Minecraft） 用户名。 */
  readonly sender_id: string;
  /** 调用方完成的主人绑定解析结果。 */
  readonly owner_resolution: GameChatOwnerResolutionState;
  /** 原始消息标识。 */
  readonly message_id: string;
  /** 原始聊天文本。 */
  readonly content: string;
  /** 固定来源。 */
  readonly source: typeof GAME_CHAT_SOURCE;
  /** 固定通道。 */
  readonly channel: typeof GAME_CHAT_CHANNEL;
  /** 收到聊天的时间戳。 */
  readonly timestamp: string;
}

/** 游戏聊天进入主线后的标准化消息包。 */
export type GameChatMessageEnvelope = InterfaceMessageEnvelope<
  typeof GAME_CHAT_SOURCE,
  typeof GAME_CHAT_CHANNEL,
  string,
  null
>;

/** 游戏聊天忽略原因集合。 */
export const GAME_CHAT_IGNORE_REASONS = ["non_owner", "missing_prefix"] as const;

/** 游戏聊天忽略原因联合类型。 */
export type GameChatIgnoreReason = (typeof GAME_CHAT_IGNORE_REASONS)[number];

/** 游戏聊天拒绝原因集合。 */
export const GAME_CHAT_REJECTION_REASONS = ["missing_owner_binding", "empty_command"] as const;

/** 游戏聊天拒绝原因联合类型。 */
export type GameChatRejectionReason = (typeof GAME_CHAT_REJECTION_REASONS)[number];

/** 游戏聊天入口判定结果联合。 */
export type GameChatIngressDecision =
  | {
      /** 判定状态。 */
      readonly status: "accepted";
      /** 可进入主线的标准化消息包。 */
      readonly envelope: GameChatMessageEnvelope;
    }
  | {
      /** 判定状态。 */
      readonly status: "ignored";
      /** 忽略原因。 */
      readonly reason: GameChatIgnoreReason;
      /** 原始候选消息。 */
      readonly candidate: GameChatIngressCandidate;
    }
  | {
      /** 判定状态。 */
      readonly status: "rejected";
      /** 拒绝原因。 */
      readonly reason: GameChatRejectionReason;
      /** 原始候选消息。 */
      readonly candidate: GameChatIngressCandidate;
    };

function assertNonEmptyString(value: string, fieldName: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
}

function assertOwnerResolutionConsistency(input: {
  owner_id: string | null;
  owner_resolution: GameChatOwnerResolutionState;
}): void {
  if (input.owner_resolution === "matched_owner" && input.owner_id === null) {
    throw new Error("owner_id must be provided when owner_resolution is matched_owner");
  }

  if (input.owner_resolution !== "matched_owner" && input.owner_id !== null) {
    throw new Error("owner_id must be null when owner_resolution is not matched_owner");
  }
}

function createGameChatIngressCandidate(input: {
  bot_id: string;
  owner_id: string | null;
  sender_id: string;
  owner_resolution: GameChatOwnerResolutionState;
  message_id: string;
  content: string;
  timestamp: string;
}): GameChatIngressCandidate {
  assertNonEmptyString(input.bot_id, "bot_id");
  assertNonEmptyString(input.sender_id, "sender_id");
  assertNonEmptyString(input.message_id, "message_id");
  assertNonEmptyString(input.timestamp, "timestamp");
  assertOwnerResolutionConsistency({
    owner_id: input.owner_id,
    owner_resolution: input.owner_resolution,
  });

  return Object.freeze({
    bot_id: input.bot_id,
    owner_id: input.owner_id,
    sender_id: input.sender_id,
    owner_resolution: input.owner_resolution,
    message_id: input.message_id,
    content: input.content,
    source: GAME_CHAT_SOURCE,
    channel: GAME_CHAT_CHANNEL,
    timestamp: input.timestamp,
  });
}

function normalizeGameChatCommandContent(content: string): string | null {
  const trimmedContent = content.trim();

  if (!trimmedContent.startsWith(GAME_CHAT_COMMAND_PREFIX)) {
    return null;
  }

  return trimmedContent.slice(GAME_CHAT_COMMAND_PREFIX.length).trim();
}

/** 创建游戏聊天入口判定结果，用于区分主人命令与应忽略的普通聊天。 */
export function createGameChatIngressDecision(input: {
  bot_id: string;
  owner_id: string | null;
  sender_id: string;
  owner_resolution: GameChatOwnerResolutionState;
  message_id: string;
  content: string;
  timestamp: string;
}): GameChatIngressDecision {
  const candidate = createGameChatIngressCandidate(input);

  if (candidate.owner_resolution === "missing_owner_binding") {
    return Object.freeze({
      status: "rejected",
      reason: "missing_owner_binding",
      candidate,
    });
  }

  if (candidate.owner_resolution === "non_owner") {
    return Object.freeze({
      status: "ignored",
      reason: "non_owner",
      candidate,
    });
  }

  const normalizedContent = normalizeGameChatCommandContent(candidate.content);

  if (normalizedContent === null) {
    return Object.freeze({
      status: "ignored",
      reason: "missing_prefix",
      candidate,
    });
  }

  if (normalizedContent.length === 0) {
    return Object.freeze({
      status: "rejected",
      reason: "empty_command",
      candidate,
    });
  }

  const matchedOwnerId = candidate.owner_id;

  if (matchedOwnerId === null) {
    throw new Error("owner_id must be resolved before creating an accepted game chat envelope");
  }

  return Object.freeze({
    status: "accepted",
    envelope: createInterfaceMessageEnvelope({
      bot_id: candidate.bot_id,
      owner_id: matchedOwnerId,
      session_id: null,
      message_id: candidate.message_id,
      content: normalizedContent,
      source: candidate.source,
      channel: candidate.channel,
      timestamp: candidate.timestamp,
    }),
  });
}
