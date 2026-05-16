import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createCodeJobForSkill } from "../../helpers/test-code-job.js";

import { EventEmitter } from "node:events";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";

import { createAppServerBridgeConfigFromEnvironment } from "../../../app/bootstrap/env.js";
import {
  bindOnlineResourceServiceBlockUpdates,
  createAppBootstrapContract,
  createAppExternalAuthSecretFromEnvironment,
  createAppStartupSummary,
  createOnlineConversationActorStateProjectionProvider,
  createRealtimeEventFromBotWorkerAction,
  createRealtimeEventFromConversationReply,
  renderAppStartupSummary,
  runAppEntrypoint,
  startAppOnlineRuntime,
} from "../../../app/index.js";
import type { AppRuntimeCoreResources } from "../../../app/index.js";
import {
  ConversationLlmPlanError,
  createConversationCompositeTriage,
} from "../../../conversation/index.js";
import { ExecutionTaskKind } from "../../../core-ports/foundation.js";
import {
  createCollectSkillExecutionResult,
  createCutTreeSkillExecutionResult,
  createEquipSkillExecutionResult,
  createGoToSkillExecutionResult,
  createMineSkillExecutionResult,
} from "../../../core-ports/skills.js";
import { ExecPriority, TaskHistoryStatus, createCodeJob } from "../../../core-ports/tasking.js";
import { createBrainTaskCard } from "../../../data/index.js";
import { ConversationPriority } from "../../../domain/contracts.js";
import { SERVER_BRIDGE_PROTOCOL_VERSION } from "../../../interfaces/index.js";
import { createObservationRuntimeCache } from "../../../observation/index.js";
import {
  BotStatus,
  createExternalAuthExecutionPlan,
  createExternalAuthState,
  createMineflayerTransportDescriptor,
  createRuntimeReadyGate,
} from "../../../runtime/index.js";
import type { MineflayerBotHandle } from "../../../runtime/transport/types.js";
import {
  type BotWorkerTask,
  type BrainWorkerTask,
  createBotWorkerActions,
  createBotWorkerTask,
  createBrainWorkerTask,
  createConversationWorkerTask,
} from "../../../workers/contracts.js";
import {
  type BrainWorkerRuntimeDependencies,
  createTaskResultReporter,
} from "../../../workers/index.js";
import {
  createTaskFailureResultSummary,
  createTaskResultSummaryFromSandboxResult,
  createTaskResultSummaryFromSkillResult,
} from "../../../workers/task-result-summary/index.js";
import { createResourceService } from "../../../world-model/index.js";

export class FakeEntrypointMineflayerBot extends EventEmitter implements MineflayerBotHandle {
  readonly username = "bot-online";
  readonly entity = {
    id: "bot-online",
    position: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
  };
  readonly players: Record<
    string,
    { entity?: { id: string; username: string; position: { x: number; y: number; z: number } } }
  > = {};

  constructor(private readonly events: string[]) {
    super();
  }

  chat(text: string): void {
    this.events.push(`chat:${text}`);
  }

  quit(): void {
    this.events.push("mineflayer.quit");
    this.emit("end");
  }

  setOwnerPosition(
    ownerName: string,
    position: { readonly x: number; readonly y: number; readonly z: number },
  ): void {
    this.players[ownerName] = {
      entity: {
        id: ownerName,
        username: ownerName,
        position: { x: position.x, y: position.y, z: position.z },
      },
    };
  }
}

export function waitForWsOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
}

export function waitForWsClose(socket: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    socket.once("close", () => resolve());
  });
}

export function readNextWsText(socket: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    socket.once("message", (data) => {
      resolve(data.toString("utf8"));
    });
    socket.once("error", reject);
  });
}

export function createFakeIntentEpochRedisClient(initialEpoch = 0): {
  readonly incr: () => Promise<number>;
  readonly get: () => Promise<string>;
} {
  let epoch = initialEpoch;

  return {
    async incr() {
      epoch += 1;

      return epoch;
    },
    async get() {
      return String(epoch);
    },
  };
}

export function createNoopBrainWorkerDependencies(): Partial<BrainWorkerRuntimeDependencies> {
  return {
    generateEmbedding: async () => [0.1],
    persistTaskEvent: async () => undefined,
    createWorker: () => ({
      close: async () => undefined,
    }),
  };
}

export {
  readFileSync,
  mkdtemp,
  readFile,
  rm,
  tmpdir,
  join,
  resolve,
  createCodeJobForSkill,
  EventEmitter,
  Fastify,
  describe,
  expect,
  it,
  WebSocket,
  createAppServerBridgeConfigFromEnvironment,
  bindOnlineResourceServiceBlockUpdates,
  createAppBootstrapContract,
  createAppExternalAuthSecretFromEnvironment,
  createAppStartupSummary,
  createOnlineConversationActorStateProjectionProvider,
  createRealtimeEventFromBotWorkerAction,
  createRealtimeEventFromConversationReply,
  renderAppStartupSummary,
  runAppEntrypoint,
  startAppOnlineRuntime,
  ConversationLlmPlanError,
  createConversationCompositeTriage,
  ExecutionTaskKind,
  createCollectSkillExecutionResult,
  createCutTreeSkillExecutionResult,
  createEquipSkillExecutionResult,
  createGoToSkillExecutionResult,
  createMineSkillExecutionResult,
  ExecPriority,
  TaskHistoryStatus,
  createCodeJob,
  createBrainTaskCard,
  ConversationPriority,
  SERVER_BRIDGE_PROTOCOL_VERSION,
  createObservationRuntimeCache,
  BotStatus,
  createExternalAuthExecutionPlan,
  createExternalAuthState,
  createMineflayerTransportDescriptor,
  createRuntimeReadyGate,
  createBotWorkerActions,
  createBotWorkerTask,
  createBrainWorkerTask,
  createConversationWorkerTask,
  createTaskResultReporter,
  createTaskFailureResultSummary,
  createTaskResultSummaryFromSandboxResult,
  createTaskResultSummaryFromSkillResult,
  createResourceService,
};

export type {
  AppRuntimeCoreResources,
  MineflayerBotHandle,
  BotWorkerTask,
  BrainWorkerTask,
  BrainWorkerRuntimeDependencies,
};
