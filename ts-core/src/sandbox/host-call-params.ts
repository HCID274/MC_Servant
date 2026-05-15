import { cloneReadonlyValue } from "../domain/invariants.js";
import type {
  SandboxStepActionName,
  SandboxStepParamsByAction,
  SandboxStepResult,
} from "./contracts.js";
import { isRecord, isSandboxStepActionName } from "./validators.js";

/** 把沙箱内部 method 名收敛为可记录的步骤动作名。 */
export function toSandboxStepActionName(method: string): SandboxStepActionName {
  const action =
    method.startsWith("bot.") || method.startsWith("chat.")
      ? method.slice(method.indexOf(".") + 1)
      : method;

  if (!isSandboxStepActionName(action)) {
    throw new Error(`Unsupported Facade method: ${method}`);
  }

  return action;
}

/** 只负责把语义 API 参数规整为 host bridge 参数，不执行动作。 */
export function normalizeSandboxCallParams(
  action: SandboxStepActionName,
  args: readonly unknown[],
): SandboxStepResult["params"] {
  const first = args[0];

  if (action === "goTo") {
    if (args.length === 3) {
      return { x: Number(args[0]), y: Number(args[1]), z: Number(args[2]) };
    }

    return cloneReadonlyValue(first ?? {}) as SandboxStepParamsByAction["goTo"];
  }

  if (action === "mine") {
    if (typeof first === "string") {
      return { blockName: first, count: Number(args[1] ?? 1) };
    }

    return cloneReadonlyValue(first ?? {}) as SandboxStepParamsByAction["mine"];
  }

  if (action === "collect") {
    if (typeof first === "string") {
      return {
        itemName: first,
        ...(args[1] !== undefined ? { radius: Number(args[1]) } : {}),
      };
    }

    return cloneReadonlyValue(first ?? {}) as SandboxStepParamsByAction["collect"];
  }

  if (action === "equip") {
    if (typeof first === "string") {
      return {
        itemName: first,
        ...(typeof args[1] === "string" ? { destination: args[1] } : {}),
      } as SandboxStepParamsByAction["equip"];
    }

    return cloneReadonlyValue(first ?? {}) as SandboxStepParamsByAction["equip"];
  }

  if (action === "craft") {
    if (typeof first === "string") {
      return {
        itemName: first,
        count: Number(args[1] ?? 1),
      } as SandboxStepParamsByAction["craft"];
    }

    return cloneReadonlyValue(first ?? {}) as SandboxStepParamsByAction["craft"];
  }

  if (action === "place") {
    if (typeof first === "string") {
      return {
        blockName: first,
        ...(isRecord(args[1]) ? { near: cloneReadonlyValue(args[1]) } : {}),
      } as SandboxStepParamsByAction["place"];
    }

    return cloneReadonlyValue(first ?? {}) as SandboxStepParamsByAction["place"];
  }

  if (action === "ensure") {
    return cloneReadonlyValue(first ?? {}) as SandboxStepParamsByAction["ensure"];
  }

  if (action === "cutTree") {
    if (typeof first === "number") {
      return { count: first } as SandboxStepParamsByAction["cutTree"];
    }

    return cloneReadonlyValue(first ?? {}) as SandboxStepParamsByAction["cutTree"];
  }

  if (typeof first !== "string" || first.trim().length === 0) {
    return { message: "" };
  }

  return { message: first };
}

/** 规整 search 只读参数。 */
export function normalizeSandboxSearchParams(args: readonly unknown[]): {
  readonly query: string;
  readonly limit?: number;
} {
  const first = args[0];
  if (typeof first === "string") {
    const query = first.trim();
    if (query.length === 0) {
      throw new Error("search query must be non-empty");
    }

    return Object.freeze({
      query,
      ...(args[1] === undefined ? {} : { limit: normalizeSandboxSearchLimit(args[1]) }),
    });
  }

  if (isRecord(first) && typeof first.query === "string") {
    const query = first.query.trim();
    if (query.length === 0) {
      throw new Error("search query must be non-empty");
    }

    return Object.freeze({
      query,
      ...(first.limit === undefined ? {} : { limit: normalizeSandboxSearchLimit(first.limit) }),
    });
  }

  throw new Error("search requires a query string");
}

/** 规整 sleep 只读参数。 */
export function normalizeSandboxSleepMs(value: unknown, maxSleepMs: number): number {
  const ms = Number(value);
  if (!Number.isInteger(ms) || ms < 0) {
    throw new Error("sleep ms must be a non-negative integer");
  }

  return Math.min(ms, maxSleepMs);
}

function normalizeSandboxSearchLimit(value: unknown): number {
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit <= 0 || limit > 10) {
    throw new Error("search limit must be an integer between 1 and 10");
  }

  return limit;
}
