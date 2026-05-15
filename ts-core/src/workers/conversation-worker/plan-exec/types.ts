import type {
  ConversationPlanDraft,
  ConversationRouteDecision,
} from "../../../conversation/contracts.js";
import type { ConversationLlmDiagnosticRecord } from "../../../conversation/llm.js";
import type { SnapshotPosition } from "../../../core-ports/observation.js";
import type { FailureCapsule } from "../../../core-ports/task-result.js";
import type { ExecJob } from "../../../core-ports/tasking.js";
import type { ConversationWorkerTask } from "../../contracts.js";
import type {
  ConversationWorkerRuntimeDependencies,
  ConversationWorkerRuntimeEvent,
} from "../types.js";

export type PlanExecRoute = Extract<ConversationRouteDecision, { readonly kind: "plan_exec" }>;

export interface PlanExecHandlerInput {
  readonly task: ConversationWorkerTask;
  readonly route: PlanExecRoute;
  readonly dependencies: ConversationWorkerRuntimeDependencies;
  readonly events: ConversationWorkerRuntimeEvent[];
  readonly suppressPlanReply?: boolean;
}

export type PlanningFailureReason =
  | "planner_unavailable"
  | "planner_failed"
  | "skill_not_enabled"
  | "implementation_blocker"
  | "retry_guard_repeated";

export type ContextProviderKind =
  | "recent"
  | "actor_state"
  | "memory"
  | "brain"
  | "resource"
  | "environment_snapshot";

export interface ContextProviderDiagnostic {
  readonly provider: ContextProviderKind;
  readonly route_kind: "plan_exec";
  readonly bot_id: string;
  readonly message_id: string;
  readonly ok: false;
  readonly error_summary: string;
}

export interface RecentFailureContext {
  readonly failure_capsule: FailureCapsule | null;
  readonly failure_message_id?: string;
  readonly recovery_chain_id?: string | null;
  readonly replan_count: number;
}

export interface PlanRecoveryContext {
  readonly recovery_chain_id: string;
  readonly recovery_class: "recoverable" | "unknown";
  readonly replan_count: number;
}

export interface PlanningContextSnapshot {
  readonly memory_context?: string;
  readonly brain_context?: string;
  readonly resource_context?: string;
  readonly recent_context?: string;
  readonly snapshot_context?: string;
  readonly inventory_change_context?: string;
  readonly owner_position_at_message?: SnapshotPosition;
  readonly provider_diagnostics: readonly ContextProviderDiagnostic[];
  advanceInventoryBaseline(): void;
}

export type PlanWithDiagnostics = ConversationPlanDraft & {
  readonly diagnostics?: ConversationLlmDiagnosticRecord;
};

export interface PlannedExecJob {
  readonly plan: PlanWithDiagnostics;
  readonly exec_job: ExecJob;
}
