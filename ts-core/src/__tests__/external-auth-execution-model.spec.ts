import { describe, expect, it } from "vitest";

import {
  BotStatus,
  createAppBootstrapContract,
  createExternalAuthExecutionPlan,
  createExternalAuthSecretBinding,
  createExternalAuthState,
  createRuntimeReadyGate,
} from "../index.js";

describe("external auth（外部认证） 执行模型", () => {
  it("应为 pending（待执行） 状态生成唯一登录命令计划", () => {
    const secret = createExternalAuthSecretBinding({
      source: "env",
      reference: "MC_EXTERNAL_AUTH_SECRET",
      secret: "hunter2",
    });
    const pendingState = createExternalAuthState({
      status: "pending",
      secret,
    });
    const plan = createExternalAuthExecutionPlan(pendingState, secret);

    expect(plan.status).toBe("pending");
    expect(pendingState).toEqual({
      status: "pending",
      required: true,
      entrypoint: "game_chat_command",
      secret_source: "env",
      secret_reference: "MC_EXTERNAL_AUTH_SECRET",
    });
    expect(plan.next_action).toEqual({
      kind: "login_command",
      entrypoint: "game_chat_command",
      target: "minecraft_chat",
      command: "/login hunter2",
      retry_allowed: true,
    });
    expect(plan.action_summary).toEqual({
      kind: "login_command",
      entrypoint: "game_chat_command",
      target: "minecraft_chat",
      command_preview: "/login <redacted>",
      retry_allowed: true,
    });
  });

  it("应在 not_required（无需认证） 下直接放行认证前置，但在 failed（失败） 下阻断 ready（就绪）", () => {
    const notRequiredGate = createRuntimeReadyGate({
      status: BotStatus.IDLE,
      externalAuth: createExternalAuthState({ status: "not_required" }),
    });
    const failedAssembly = createAppBootstrapContract({
      botId: "bot-auth-failed",
      now: "2026-04-14T00:00:00.000Z",
      env: {
        MC_EXTERNAL_AUTH_REQUIRED: "true",
      },
    });

    expect(notRequiredGate.ready).toBe(true);
    expect(notRequiredGate.blocked_by).toEqual([]);
    expect(failedAssembly.auth.state.status).toBe("failed");
    expect(failedAssembly.runtime.ready_gate.ready).toBe(false);
    expect(failedAssembly.runtime.ready_gate.blocked_by).toContain("external_auth_failed");
  });
});
