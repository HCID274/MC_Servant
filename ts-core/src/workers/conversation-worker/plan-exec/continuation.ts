import { type FailureCapsule, classifyFailureCode } from "../../../core-ports/task-result.js";
import { type ExecJob, createRecoveryChainId } from "../../../core-ports/tasking.js";
import type { ConversationWorkerTask } from "../../contracts.js";
import type { PlanRecoveryContext, RecentFailureContext } from "./types.js";

export type ContinuationDecision = Readonly<{
  kind: "none" | "recoverable" | "implementation_blocker" | "unknown";
}>;

export function createContinuationDecision(input: {
  readonly message: string;
  readonly failure_capsule: FailureCapsule | null;
}): ContinuationDecision {
  if (input.failure_capsule === null || !isContinuationMessage(input.message)) {
    return Object.freeze({ kind: "none" });
  }

  const failureClass = classifyFailureCode(input.failure_capsule.failure_code);
  if (failureClass === "implementation_blocker") {
    return Object.freeze({ kind: "implementation_blocker" });
  }
  if (failureClass === "recoverable") {
    return Object.freeze({ kind: "recoverable" });
  }

  return Object.freeze({ kind: "unknown" });
}

export function createPlanRecoveryContext(input: {
  readonly task: ConversationWorkerTask;
  readonly continuation: ContinuationDecision;
  readonly recent_failure: RecentFailureContext;
}): PlanRecoveryContext | null {
  if (input.continuation.kind !== "recoverable" && input.continuation.kind !== "unknown") {
    return null;
  }

  return Object.freeze({
    recovery_chain_id:
      input.recent_failure.recovery_chain_id ??
      createRecoveryChainId({
        bot_id: input.task.bot_id,
        message_id: input.recent_failure.failure_message_id ?? input.task.message.message_id,
      }),
    recovery_class: input.continuation.kind,
    replan_count: input.recent_failure.replan_count + 1,
  });
}

export function createImplementationBlockerRecoveryContext(input: {
  readonly task: ConversationWorkerTask;
  readonly recent_failure: RecentFailureContext;
}): {
  readonly recovery_chain_id: string;
  readonly recovery_class: "implementation_blocker";
  readonly replan_count: number;
} {
  return Object.freeze({
    recovery_chain_id:
      input.recent_failure.recovery_chain_id ??
      createRecoveryChainId({
        bot_id: input.task.bot_id,
        message_id: input.recent_failure.failure_message_id ?? input.task.message.message_id,
      }),
    recovery_class: "implementation_blocker",
    replan_count: input.recent_failure.replan_count,
  });
}

export function detectRepeatedFailurePlan(input: {
  readonly exec_job: ExecJob;
  readonly failure_capsule: FailureCapsule | null;
}): FailureCapsule | null {
  if (input.failure_capsule === null) {
    return null;
  }

  const retrySignature = readRetrySignature(input.failure_capsule.retry_guard);
  if (retrySignature === null) {
    return null;
  }

  return input.exec_job.code.includes(retrySignature) ? input.failure_capsule : null;
}

function isContinuationMessage(message: string): boolean {
  const normalized = message.toLowerCase().split(" ").join("").trim();
  if (normalized.length === 0 || normalized.length > 40) {
    return false;
  }

  return CONTINUATION_PHRASES.some((phrase) => normalized.includes(phrase));
}

function readRetrySignature(retryGuard: string): string | null {
  const prefix = "不要原样重复 ";
  return retryGuard.startsWith(prefix) ? retryGuard.slice(prefix.length).trim() : null;
}

const CONTINUATION_PHRASES = Object.freeze([
  "继续",
  "再试试",
  "想办法",
  "换个办法",
  "你自己解决",
  "继续做",
  "为什么失败了继续做",
] as const);
