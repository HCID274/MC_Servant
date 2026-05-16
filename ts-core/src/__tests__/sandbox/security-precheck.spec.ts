import {
  ExecPriority,
  ExecutionTaskKind,
  TaskHistoryStatus,
  createCodeJob,
  createRuntimeSandboxRequest,
  createSandboxError,
  createSandboxExecutionFailure,
  createSandboxExecutionInterrupted,
  createSandboxExecutionSuccess,
  createSandboxResourceLimits,
  createSatisfiedConditionFacade,
  createTaskResultSummaryFromSandboxResult,
  createTestConditionEvaluation,
  describe,
  executeCodeRequest,
  expect,
  invalidAbortRecoverable,
  invalidCraftParams,
  invalidGoToParams,
  invalidSandboxRequestType,
  invalidStepAction,
  it,
  validCraftParams,
} from "./diagnostics-and-execution.fixture.js";

void validCraftParams;
void invalidAbortRecoverable;
void invalidCraftParams;
void invalidGoToParams;
void invalidSandboxRequestType;
void invalidStepAction;

describe("sandbox security/precheck 行为", () => {
  it("应拒绝旧 api.bot / api.chat 执行面", async () => {
    const facade = {
      async executeBotSkill() {
        throw new Error("skill should not run");
      },
      async writeChat() {
        throw new Error("chat should not run");
      },
    };
    const apiVisibility = await executeCodeRequest({
      request: createRuntimeSandboxRequest({
        code: "if (typeof api !== 'undefined') { throw new Error('legacy api leaked') }",
        messageId: "T-083-api-undefined",
      }),
      facade,
    });
    const botApi = await executeCodeRequest({
      request: createRuntimeSandboxRequest({
        code: "await api.bot.mine('stone', 1)",
        messageId: "T-083-api-bot",
      }),
      facade,
    });
    const chatApi = await executeCodeRequest({
      request: createRuntimeSandboxRequest({
        code: "await api.chat.report('done')",
        messageId: "T-083-api-chat",
      }),
      facade,
    });

    expect(apiVisibility.status).toBe(TaskHistoryStatus.Completed);
    expect(botApi.status).toBe(TaskHistoryStatus.Failed);
    expect(botApi.error.name).toBe("UnhandledError");
    expect(chatApi.status).toBe(TaskHistoryStatus.Failed);
    expect(chatApi.error.name).toBe("UnhandledError");
  });

  it("应拒绝 process / require / import / fetch 等沙箱逃逸入口", async () => {
    const forbiddenCases = [
      { code: "process.env", violation: "process" },
      { code: "require('fs')", violation: "require" },
      { code: "import('node:fs')", violation: "import" },
      { code: "globalThis.process", violation: "process" },
      { code: "await fetch('https://example.com')", violation: "network" },
      {
        code: "await __sandboxTryCall('bot.place', [{ blockName: 'crafting_table' }])",
        violation: "sandbox_internal_bridge",
      },
      {
        code: "await __sandboxHostCall('bot.mine', ['stone', 1])",
        violation: "sandbox_internal_bridge",
      },
      {
        code: "await __sandboxRead('memory.search', ['stone'])",
        violation: "sandbox_internal_bridge",
      },
    ] as const;

    for (const forbiddenCase of forbiddenCases) {
      const result = await executeCodeRequest({
        request: createRuntimeSandboxRequest({
          code: forbiddenCase.code,
          messageId: `forbidden-${forbiddenCase.violation}`,
        }),
        hostBridge: {
          async executeBotSkill() {
            throw new Error("skill should not run");
          },
          async writeChat() {
            throw new Error("chat should not run");
          },
        },
      });

      expect(result.status).toBe(TaskHistoryStatus.Failed);
      expect(result.error.name).toBe("StaticCheckError");
      expect(result.phase_logs[0]).toMatchObject({
        phase: "precheck",
        ok: false,
        violation: forbiddenCase.violation,
      });
    }
  });

  it("应把转译失败、脚本超时与 Facade（门面接口） 失败收口为结构化错误", async () => {
    const facade = {
      async executeBotSkill() {
        throw new Error("facade boom");
      },
      async writeChat() {
        throw new Error("chat boom");
      },
    };
    const transpileFailure = await executeCodeRequest({
      request: createRuntimeSandboxRequest({
        code: "const value: = 1",
        messageId: "T-027-transpile",
      }),
      facade,
    });
    const timeoutFailure = await executeCodeRequest({
      request: createRuntimeSandboxRequest({
        code: "while (true) {}",
        messageId: "T-027-timeout",
        resourceLimits: {
          timeout_ms: 30,
          script_timeout_ms: 10,
        },
      }),
      facade,
    });
    const facadeFailure = await executeCodeRequest({
      request: createRuntimeSandboxRequest({
        code: "await goTo(1, 64, 1)",
        messageId: "T-027-facade",
      }),
      facade,
    });

    expect(transpileFailure.status).toBe(TaskHistoryStatus.Failed);
    expect(transpileFailure.error.name).toBe("TranspileError");
    expect(timeoutFailure.status).toBe(TaskHistoryStatus.Failed);
    expect(timeoutFailure.error.name).toBe("SandboxTimeoutError");
    expect(facadeFailure.status).toBe(TaskHistoryStatus.Failed);
    expect(facadeFailure.error.name).toBe("FacadeCallError");
    expect(facadeFailure.step_results[0]?.error?.name).toBe("FacadeCallError");
  });

  it("应禁止沙箱代码吞掉 FacadeCallError（门面调用错误） 后伪装成功", async () => {
    const messages: string[] = [];
    const result = await executeCodeRequest({
      request: createRuntimeSandboxRequest({
        code: "try { await goTo(1, 64, 1) } catch { await reply('handled') }",
        messageId: "T-027-facade-catch",
      }),
      hostBridge: {
        async executeBotSkill() {
          throw new Error("goTo failed");
        },
        async writeChat(_method, params) {
          messages.push(params.message);

          return { delivered: true };
        },
      },
    });

    expect(result.status).toBe(TaskHistoryStatus.Failed);
    expect(result.error.name).toBe("FacadeCallError");
    expect(messages).toEqual([]);
    expect(result.step_results).toHaveLength(1);
    expect(result.step_results[0]).toMatchObject({
      action: "goTo",
      status: "err",
    });
  });

  it("应在总超时后阻止 Facade（门面接口） 调用继续产生聊天副作用", async () => {
    const messages: string[] = [];
    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    const result = await executeCodeRequest({
      request: createRuntimeSandboxRequest({
        code: "await reply('late side effect')",
        messageId: "T-027-timeout-side-effect",
        resourceLimits: {
          timeout_ms: 30,
          script_timeout_ms: 20,
          abort_cleanup_timeout_ms: 120,
        },
      }),
      hostBridge: {
        async executeBotSkill() {
          throw new Error("skill should not run");
        },
        async writeChat(_method, params, control) {
          await sleep(60);

          if (control?.signal.aborted !== true) {
            messages.push(params.message);
          }

          return { delivered: true };
        },
      },
    });

    expect(result.status).toBe(TaskHistoryStatus.Failed);
    expect(result.error.name).toBe("SandboxTimeoutError");
    expect(messages).toEqual([]);

    await sleep(80);

    expect(messages).toEqual([]);
  });

  it("应拒绝被类型断言伪装成可恢复的 AbortError（中断错误）", () => {
    expect(() =>
      createSandboxError({
        name: "AbortError",
        message: "Sandbox aborted",
        recoverable: true,
        reason: "owner_interrupt",
      } as unknown as AbortError),
    ).toThrow(/recoverable must be false/);
  });
});
