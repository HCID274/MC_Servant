import type { ConversationLlmDiagnosticRecord } from "../../../conversation/llm.js";
import {
  ConversationLlmPlanError,
  isConversationLlmSkillNotEnabledError,
} from "../../../conversation/llm/errors.js";
import { createSkillNotEnabledReply } from "../helpers.js";
import type {
  PlanExecHandlerInput,
  PlanWithDiagnostics,
  PlanningContextSnapshot,
} from "./types.js";

export type PlanInvocationResult =
  | {
      readonly ok: true;
      readonly plan: PlanWithDiagnostics;
    }
  | {
      readonly ok: false;
      readonly reason: "planner_failed" | "skill_not_enabled";
      readonly reply: string;
      readonly diagnostics?: ConversationLlmDiagnosticRecord;
    };

export async function invokeConversationPlanner(input: {
  readonly request: PlanExecHandlerInput;
  readonly context: PlanningContextSnapshot;
  readonly planner_failure_reply: string;
}): Promise<PlanInvocationResult> {
  try {
    const planSearchTool =
      input.request.route.needs_memory_search === true
        ? input.request.dependencies.brainSearchTool
        : undefined;

    const plan = await input.request.dependencies.planner?.({
      task: input.request.task,
      triage: input.request.route.triage,
      route: input.request.route,
      ...(input.context.memory_context === undefined
        ? {}
        : { memory_context: input.context.memory_context }),
      ...(input.context.brain_context === undefined
        ? {}
        : { brain_context: input.context.brain_context }),
      ...(planSearchTool === undefined ? {} : { search_tool: planSearchTool }),
      ...(input.context.resource_context === undefined
        ? {}
        : { resource_context: input.context.resource_context }),
      ...(input.context.recent_context === undefined
        ? {}
        : { recent_context: input.context.recent_context }),
      ...(input.context.snapshot_context === undefined
        ? {}
        : { snapshot_context: input.context.snapshot_context }),
      ...(input.context.inventory_change_context === undefined
        ? {}
        : { inventory_change_context: input.context.inventory_change_context }),
    });

    if (plan === undefined) {
      return Object.freeze({
        ok: false,
        reason: "planner_failed",
        reply: input.planner_failure_reply,
      });
    }

    return Object.freeze({ ok: true, plan });
  } catch (error) {
    if (isConversationLlmSkillNotEnabledError(error)) {
      return Object.freeze({
        ok: false,
        reason: "skill_not_enabled",
        reply: createSkillNotEnabledReply().reply,
        ...(error.diagnostics === undefined ? {} : { diagnostics: error.diagnostics }),
      });
    }

    return Object.freeze({
      ok: false,
      reason: "planner_failed",
      reply: input.planner_failure_reply,
      ...createDiagnosticsField(error),
    });
  } finally {
    input.context.advanceInventoryBaseline();
  }
}

function createDiagnosticsField(error: unknown): {
  readonly diagnostics?: ConversationLlmDiagnosticRecord;
} {
  return error instanceof ConversationLlmPlanError && error.diagnostics !== undefined
    ? { diagnostics: error.diagnostics }
    : {};
}
