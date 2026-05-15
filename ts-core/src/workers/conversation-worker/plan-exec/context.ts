import { renderConversationBrainContext } from "../../../conversation/brain-context.js";
import type { BotActorRecentEventProjection } from "../../../core-ports/runtime.js";
import {
  CONVERSATION_WORKER_MEMORY_CONTEXT_CHAR_BUDGET,
  CONVERSATION_WORKER_MEMORY_CONTEXT_LIMIT,
  normalizeMemoryContext,
} from "../helpers.js";
import { createPlanPromptSnapshotContext } from "../shared-context.js";
import type {
  ContextProviderDiagnostic,
  PlanExecHandlerInput,
  PlanningContextSnapshot,
  RecentFailureContext,
} from "./types.js";

export function appendContextProviderDiagnosticEvents(input: {
  readonly events: PlanExecHandlerInput["events"];
  readonly diagnostics: readonly ContextProviderDiagnostic[];
}): void {
  for (const diagnostic of input.diagnostics) {
    input.events.push(
      Object.freeze({
        type: "conversation.context_provider_failed",
        bot_id: diagnostic.bot_id,
        message_id: diagnostic.message_id,
        route_kind: diagnostic.route_kind,
        provider: diagnostic.provider,
        error_summary: diagnostic.error_summary,
      }),
    );
  }
}

export function createContextProviderDiagnostic(
  input: Pick<PlanExecHandlerInput, "task"> & {
    readonly provider: ContextProviderDiagnostic["provider"];
    readonly error: unknown;
  },
): ContextProviderDiagnostic {
  return Object.freeze({
    provider: input.provider,
    route_kind: "plan_exec",
    bot_id: input.task.bot_id,
    message_id: input.task.message.message_id,
    ok: false,
    error_summary: summarizeError(input.error),
  });
}

export function readLatestFailureContext(input: {
  readonly task: PlanExecHandlerInput["task"];
  readonly dependencies: PlanExecHandlerInput["dependencies"];
}): {
  readonly recent_failure: RecentFailureContext;
  readonly diagnostics: readonly ContextProviderDiagnostic[];
} {
  const diagnostics: ContextProviderDiagnostic[] = [];

  try {
    const failureInfo =
      input.dependencies.recentContextStore?.getLatestFailureCapsuleInfo() ?? null;

    return Object.freeze({
      recent_failure: Object.freeze({
        failure_capsule: failureInfo?.capsule ?? null,
        ...(failureInfo === null ? {} : { failure_message_id: failureInfo.message_id }),
        ...(failureInfo === null ? {} : { recovery_chain_id: failureInfo.recovery_chain_id }),
        replan_count: failureInfo?.replan_count ?? 0,
      }),
      diagnostics,
    });
  } catch (error) {
    diagnostics.push(createContextProviderDiagnostic({ ...input, provider: "recent", error }));

    return Object.freeze({
      recent_failure: Object.freeze({
        failure_capsule: null,
        replan_count: 0,
      }),
      diagnostics,
    });
  }
}

export async function readPlanningContext(input: {
  readonly task: PlanExecHandlerInput["task"];
  readonly route: PlanExecHandlerInput["route"];
  readonly dependencies: PlanExecHandlerInput["dependencies"];
  readonly latest_failure_capsule_only: boolean;
  readonly initial_diagnostics: readonly ContextProviderDiagnostic[];
}): Promise<PlanningContextSnapshot> {
  const diagnostics = [...input.initial_diagnostics];
  const recentContext = await readRecentContext({ ...input, diagnostics });
  const memoryContext = await readMemoryContext({ ...input, diagnostics });
  const brainContext = await readBrainContext({ ...input, diagnostics });
  const resourceContext = await readResourceContext({ ...input, diagnostics });
  const promptContext = await createPlanPromptSnapshotContext({
    task: input.task,
    dependencies: input.dependencies,
    ...(resourceContext === undefined ? {} : { resource_context: resourceContext }),
    ...(recentContext === undefined ? {} : { recent_context: recentContext }),
  });
  for (const diagnostic of promptContext.provider_diagnostics) {
    diagnostics.push(
      createContextProviderDiagnostic({
        task: input.task,
        provider: diagnostic.provider,
        error: diagnostic.error_summary,
      }),
    );
  }

  return Object.freeze({
    ...(memoryContext === undefined ? {} : { memory_context: memoryContext }),
    ...(brainContext === undefined ? {} : { brain_context: brainContext }),
    ...(resourceContext === undefined ? {} : { resource_context: resourceContext }),
    ...(recentContext === undefined ? {} : { recent_context: recentContext }),
    ...(promptContext.snapshot_context === undefined
      ? {}
      : { snapshot_context: promptContext.snapshot_context }),
    ...(promptContext.inventory_change_context === undefined
      ? {}
      : { inventory_change_context: promptContext.inventory_change_context }),
    ...(promptContext.owner_position_at_message === undefined
      ? {}
      : { owner_position_at_message: promptContext.owner_position_at_message }),
    provider_diagnostics: Object.freeze([...diagnostics]),
    advanceInventoryBaseline() {
      promptContext.advanceInventoryBaseline();
    },
  });
}

async function readRecentContext(input: {
  readonly task: PlanExecHandlerInput["task"];
  readonly dependencies: PlanExecHandlerInput["dependencies"];
  readonly latest_failure_capsule_only: boolean;
  readonly diagnostics: ContextProviderDiagnostic[];
}): Promise<string | undefined> {
  let actorRecentEvents: readonly BotActorRecentEventProjection[] | undefined;
  try {
    const projection = await input.dependencies.actorStateProjectionProvider?.({
      task: input.task,
    });
    actorRecentEvents = projection?.recent_events;
  } catch (error) {
    input.diagnostics.push(
      createContextProviderDiagnostic({ ...input, provider: "actor_state", error }),
    );
  }

  try {
    return input.dependencies.recentContextStore?.render({
      ...(actorRecentEvents === undefined ? {} : { actorRecentEvents }),
      currentMessageId: input.task.message.message_id,
      roundLimit: 5,
      latestFailureCapsuleOnly: input.latest_failure_capsule_only,
    });
  } catch (error) {
    input.diagnostics.push(
      createContextProviderDiagnostic({ ...input, provider: "recent", error }),
    );
    return undefined;
  }
}

async function readBrainContext(input: {
  readonly task: PlanExecHandlerInput["task"];
  readonly dependencies: PlanExecHandlerInput["dependencies"];
  readonly diagnostics: ContextProviderDiagnostic[];
}): Promise<string | undefined> {
  try {
    const context = await input.dependencies.brainContextProvider?.({
      bot_id: input.task.bot_id,
      message_id: input.task.message.message_id,
      include_skill: true,
    });

    return renderConversationBrainContext({
      ...(context === null || context === undefined ? {} : { context }),
      includeSkill: true,
    });
  } catch (error) {
    input.diagnostics.push(createContextProviderDiagnostic({ ...input, provider: "brain", error }));
    return undefined;
  }
}

async function readResourceContext(input: {
  readonly task: PlanExecHandlerInput["task"];
  readonly route: PlanExecHandlerInput["route"];
  readonly dependencies: PlanExecHandlerInput["dependencies"];
  readonly diagnostics: ContextProviderDiagnostic[];
}): Promise<string | undefined> {
  if (input.dependencies.resourceContextProvider === undefined) {
    return undefined;
  }

  try {
    const context = await input.dependencies.resourceContextProvider({
      bot_id: input.task.bot_id,
      message_id: input.task.message.message_id,
      message_content: input.task.message.content,
      route_kind: input.route.kind,
    });

    return normalizeMemoryContext(context);
  } catch (error) {
    input.diagnostics.push(
      createContextProviderDiagnostic({ ...input, provider: "resource", error }),
    );
    return undefined;
  }
}

async function readMemoryContext(input: {
  readonly task: PlanExecHandlerInput["task"];
  readonly route: PlanExecHandlerInput["route"];
  readonly dependencies: PlanExecHandlerInput["dependencies"];
  readonly diagnostics: ContextProviderDiagnostic[];
}): Promise<string | undefined> {
  if (input.dependencies.memoryContextProvider === undefined) {
    return undefined;
  }

  try {
    return normalizeMemoryContext(
      await input.dependencies.memoryContextProvider({
        bot_id: input.task.bot_id,
        message_id: input.task.message.message_id,
        intent_epoch: input.task.message.intent_epoch,
        message_content: input.task.message.content,
        route_kind: input.route.kind,
        query_reason: input.route.triage.reason,
        limit: CONVERSATION_WORKER_MEMORY_CONTEXT_LIMIT,
        char_budget: CONVERSATION_WORKER_MEMORY_CONTEXT_CHAR_BUDGET,
      }),
    );
  } catch (error) {
    input.diagnostics.push(
      createContextProviderDiagnostic({ ...input, provider: "memory", error }),
    );
    return undefined;
  }
}

function summarizeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return typeof error === "string" ? error : "unknown provider failure";
}
