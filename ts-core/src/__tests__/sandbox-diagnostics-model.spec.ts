import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  type AbortError,
  ExecPriority,
  ExecutionTaskKind,
  PHASE1_SKILL_NAMES,
  SANDBOX_BOT_SKILL_BINDINGS,
  SANDBOX_FACADE_SECTIONS,
  SANDBOX_FORBIDDEN_DEMO_METHOD_NAMES,
  SANDBOX_READONLY_SECTIONS,
  type SANDBOX_STEP_ACTION_NAMES,
  SANDBOX_TOOLCHAIN_CAPABILITY_NAMES,
  SANDBOX_TOOLCHAIN_FAILURE_CODES,
  type SandboxExecutionRequest,
  type SandboxStepParamsByAction,
  type SandboxToolchainCapabilityParamsByName,
  TaskHistoryStatus,
  type TaskLifecycleEvent,
  createDiagnosticsCatalog,
  createLlmDiagnosticSummary,
  createLlmLogLine,
  createLlmLogRef,
  createLocalConversationReplyLogSink,
  createSandboxCodeJob,
  createSandboxCodeRef,
  createSandboxError,
  createSandboxExecutionFailure,
  createSandboxExecutionInterrupted,
  createSandboxExecutionRequest,
  createSandboxExecutionSuccess,
  createSandboxExperienceDraft,
  createSandboxFacadeContract,
  createSandboxFacadePromptIndex,
  createSandboxLogLine,
  createSandboxLogRef,
  createSandboxResourceLimits,
  createSandboxStepResult,
  createTaskLifecycleSummaryJsonlLine,
  createTaskLogLine,
  createTaskLogRef,
  createTaskStartedLifecycleEvent,
  createTaskTerminalLifecycleEvent,
  describeFacadeNamespace,
  executeSandboxCodeRequest,
  updateSandboxFacadeHotNamespaceQueue,
} from "../index.js";

const validBindings: typeof SANDBOX_BOT_SKILL_BINDINGS = SANDBOX_BOT_SKILL_BINDINGS;
void validBindings;

// @ts-expect-error `dig`（挖掘） 不是 Phase 1（第一阶段） 可记录动作。
const invalidStepAction: (typeof SANDBOX_STEP_ACTION_NAMES)[number] = "dig";
void invalidStepAction;

// @ts-expect-error `goTo`（移动） 的参数必须是坐标结构。
const invalidGoToParams: SandboxStepParamsByAction["goTo"] = { blockName: "oak_log", count: 1 };
void invalidGoToParams;

// @ts-expect-error `goTo`（移动） 不能映射到 `mine`（挖掘） 技能。
const invalidGoToBinding: typeof SANDBOX_BOT_SKILL_BINDINGS.goTo = "mine";
void invalidGoToBinding;

// @ts-expect-error `SandboxExecutionRequest.type` 固定为 `sandbox_code`（沙箱代码）。
const invalidSandboxRequestType: SandboxExecutionRequest["type"] = ExecutionTaskKind.SkillCall;
void invalidSandboxRequestType;

// @ts-expect-error `AbortError`（中断错误） 固定不可恢复。
const invalidAbortRecoverable: AbortError["recoverable"] = true;
void invalidAbortRecoverable;

const validCraftParams: SandboxToolchainCapabilityParamsByName["craft"] = {
  itemName: "stone_pickaxe",
  count: 1,
};
void validCraftParams;

// @ts-expect-error `craft`（合成） 参数不接受坐标；放置坐标属于 `place`（放置） 能力。
const invalidCraftParams: SandboxToolchainCapabilityParamsByName["craft"] = { x: 1 };
void invalidCraftParams;

describe("sandbox（沙箱） 与 diagnostics（诊断） 契约", () => {
  const createRuntimeSandboxRequest = (input: {
    code: string;
    messageId?: string;
    resourceLimits?: Parameters<typeof createSandboxResourceLimits>[0];
  }) =>
    createSandboxExecutionRequest({
      job_id: input.messageId ?? "T-027",
      bot_id: "bot-027",
      intent_epoch: 1,
      snapshot_ts: 1_712_930_001,
      code: input.code,
      log_ref: createSandboxLogRef({
        date: "2026-04-13",
        job_id: input.messageId ?? "T-027",
      }),
      resource_limits: input.resourceLimits,
    });

  it("应让 Facade API（门面接口） 写动作与 Phase 1（第一阶段） 技能目录精确对齐", () => {
    const facadeContract = createSandboxFacadeContract();

    expect(Object.keys(facadeContract)).toEqual([...SANDBOX_FACADE_SECTIONS]);
    expect(Object.keys(facadeContract.bot)).toEqual([...PHASE1_SKILL_NAMES]);
    expect(SANDBOX_BOT_SKILL_BINDINGS.goTo).toBe("goTo");
    expect(facadeContract.bot.mine.aligned_skill).toBe("mine");
    expect(facadeContract.chat.report.emits_step).toBe(true);
    expect(SANDBOX_READONLY_SECTIONS).toEqual(["world", "knowledge", "memory", "owner", "task"]);
  });

  it("应声明工具链能力契约但不把未实现能力注入当前 Facade（门面）", () => {
    const facadeContract = createSandboxFacadeContract();

    expect(SANDBOX_TOOLCHAIN_CAPABILITY_NAMES).toEqual([
      "craft",
      "place",
      "equip",
      "mine",
      "ensureLogs",
      "ensureCraftingTablePlaced",
      "ensureWoodenPickaxeEquipped",
      "ensureCobblestone",
      "ensureStonePickaxeEquipped",
    ]);
    expect(SANDBOX_FORBIDDEN_DEMO_METHOD_NAMES).toEqual(["demoMineIron"]);
    expect(SANDBOX_TOOLCHAIN_CAPABILITY_NAMES).not.toContain("demoMineIron");
    expect(SANDBOX_TOOLCHAIN_FAILURE_CODES).toEqual(
      expect.arrayContaining(["missing_materials", "cannot_place", "unsafe_path"]),
    );
    expect(Object.keys(facadeContract.bot)).toEqual([...PHASE1_SKILL_NAMES]);
    expect(facadeContract.bot).not.toHaveProperty("craft");
    expect(facadeContract.bot).not.toHaveProperty("place");
    expect(facadeContract.bot).not.toHaveProperty("ensureStonePickaxeEquipped");
  });

  it("应提供渐进披露索引并按 namespace（命名空间） 描述 Facade API（门面接口）", () => {
    const index = createSandboxFacadePromptIndex();
    const botDescription = describeFacadeNamespace("bot");

    expect(index).toContain("Facade namespaces");
    expect(index).toContain("describe(namespace)");
    expect(index).not.toContain("goTo(x,y,z)");
    expect(botDescription).toContain("goTo");
    expect(describeFacadeNamespace("task")).toContain("userMessage");
  });

  it("应按 token（令牌） 预算维护 LRU（最近最少使用） Facade API 热队列", () => {
    const botBudget = Math.ceil(describeFacadeNamespace("bot").length / 4) + 1;
    const chatBudget = Math.ceil(describeFacadeNamespace("chat").length / 4) + 1;
    const bothBudget = botBudget + chatBudget + 4;
    const withBot = updateSandboxFacadeHotNamespaceQueue({
      namespace: "bot",
      budget_tokens: bothBudget,
    });
    const withChat = updateSandboxFacadeHotNamespaceQueue({
      queue: withBot,
      namespace: "chat",
      budget_tokens: bothBudget,
    });
    const refreshedBot = updateSandboxFacadeHotNamespaceQueue({
      queue: withChat,
      namespace: "bot",
      budget_tokens: bothBudget,
    });
    const trimmed = updateSandboxFacadeHotNamespaceQueue({
      queue: refreshedBot,
      namespace: "task",
      budget_tokens: chatBudget,
    });

    expect(withChat.entries.map((entry) => entry.namespace)).toEqual(["bot", "chat"]);
    expect(refreshedBot.entries.map((entry) => entry.namespace)).toEqual(["chat", "bot"]);
    expect(trimmed.total_tokens).toBeLessThanOrEqual(chatBudget);
    expect(trimmed.entries.at(-1)?.namespace).toBe("task");
    expect(() =>
      updateSandboxFacadeHotNamespaceQueue({
        namespace: "bot",
        budget_tokens: 0,
      }),
    ).toThrow(/budget_tokens/);
  });

  it("应在 isolated-vm（隔离虚拟机） 内执行 chat.say（聊天输出） 并记录步骤", async () => {
    const messages: string[] = [];
    const result = await executeSandboxCodeRequest({
      request: createRuntimeSandboxRequest({
        code: "await api.chat.say('hello sandbox')",
      }),
      facade: {
        async executeBotSkill() {
          throw new Error("skill should not run");
        },
        async writeChat(_method, params) {
          messages.push(params.message);

          return { delivered: true };
        },
      },
    });

    expect(result.status).toBe(TaskHistoryStatus.Completed);
    expect(messages).toEqual(["hello sandbox"]);
    expect(result.step_results).toMatchObject([
      {
        action: "say",
        status: "ok",
        params: { message: "hello sandbox" },
      },
    ]);
  });

  it("应让只读 task（任务） 查询不产出步骤记录", async () => {
    const result = await executeSandboxCodeRequest({
      request: createRuntimeSandboxRequest({
        code: "if (api.task.id !== 'task-readonly') { throw new Error('bad task id') }\nif (typeof __sandboxHostCall !== 'undefined') { throw new Error('host leaked') }",
        messageId: "task-readonly",
      }),
      task: {
        id: "task-readonly",
        userMessage: "读任务上下文",
        intent: "sandbox_code",
      },
      facade: {
        async executeBotSkill() {
          throw new Error("skill should not run");
        },
        async writeChat() {
          throw new Error("chat should not run");
        },
      },
    });

    expect(result.status).toBe(TaskHistoryStatus.Completed);
    expect(result.step_results).toEqual([]);
  });

  it("应拒绝 process / require / import / fetch 等沙箱逃逸入口", async () => {
    const forbiddenCases = [
      { code: "process.env", violation: "process" },
      { code: "require('fs')", violation: "require" },
      { code: "import('node:fs')", violation: "import" },
      { code: "globalThis.process", violation: "process" },
      { code: "await fetch('https://example.com')", violation: "network" },
    ] as const;

    for (const forbiddenCase of forbiddenCases) {
      const result = await executeSandboxCodeRequest({
        request: createRuntimeSandboxRequest({
          code: forbiddenCase.code,
          messageId: `forbidden-${forbiddenCase.violation}`,
        }),
        facade: {
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
    const transpileFailure = await executeSandboxCodeRequest({
      request: createRuntimeSandboxRequest({
        code: "const value: = 1",
        messageId: "T-027-transpile",
      }),
      facade,
    });
    const timeoutFailure = await executeSandboxCodeRequest({
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
    const facadeFailure = await executeSandboxCodeRequest({
      request: createRuntimeSandboxRequest({
        code: "await api.bot.goTo(1, 64, 1)",
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
    const result = await executeSandboxCodeRequest({
      request: createRuntimeSandboxRequest({
        code: "try { await api.bot.goTo(1, 64, 1) } catch { await api.chat.say('handled') }",
        messageId: "T-027-facade-catch",
      }),
      facade: {
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
    const result = await executeSandboxCodeRequest({
      request: createRuntimeSandboxRequest({
        code: "await api.chat.say('late side effect')",
        messageId: "T-027-timeout-side-effect",
        resourceLimits: {
          timeout_ms: 30,
          script_timeout_ms: 20,
          abort_cleanup_timeout_ms: 120,
        },
      }),
      facade: {
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

  it("应把 cutTree（砍树） 显式拒绝为 FacadeCallError（门面调用错误）", async () => {
    const result = await executeSandboxCodeRequest({
      request: createRuntimeSandboxRequest({
        code: "await api.bot.cutTree({ count: 1 })",
        messageId: "T-027-cut-tree",
      }),
      facade: {
        async executeBotSkill() {
          throw new Error("cutTree should be rejected before adapter");
        },
        async writeChat() {
          throw new Error("chat should not run");
        },
      },
    });

    expect(result.status).toBe(TaskHistoryStatus.Failed);
    expect(result.error.name).toBe("FacadeCallError");
    expect(result.step_results[0]).toMatchObject({
      action: "cutTree",
      status: "err",
      error: {
        name: "FacadeCallError",
      },
    });
  });

  it("应集中表达 diagnostics（诊断） 通道目录、保留期与引用规则", () => {
    const diagnosticsCatalog = createDiagnosticsCatalog();
    const taskLogRef = createTaskLogRef({
      date: "2026-04-13",
      job_id: "T-007",
    });
    const sandboxLogRef = createSandboxLogRef({
      date: "2026-04-13",
      job_id: "T-007",
    });
    const sandboxCodeRef = createSandboxCodeRef({
      date: "2026-04-13",
      job_id: "T-007",
    });
    const llmLogRef = createLlmLogRef({
      date: "2026-04-13",
      stage: "triage",
      message_id: "msg-001",
    });

    expect(diagnosticsCatalog.channels.map((channel) => channel.channel)).toEqual([
      "tasks",
      "sandbox",
      "llm",
    ]);
    expect(taskLogRef).toBe("tasks/2026-04-13/T-007.jsonl");
    expect(sandboxLogRef).toBe("sandbox/2026-04-13/T-007.jsonl");
    expect(sandboxCodeRef).toBe("sandbox/2026-04-13/T-007.code.ts");
    expect(llmLogRef).toBe("llm/2026-04-13/triage-msg-001.jsonl");

    expect(() =>
      createSandboxExecutionRequest({
        job_id: "T-007",
        bot_id: "bot-007",
        intent_epoch: 2,
        snapshot_ts: 1,
        code: "await api.chat.say('hello')",
        log_ref: taskLogRef,
      }),
    ).toThrow(/sandbox/);
  });

  it("应把每次 conversation reply（对话回复） 与上下文写入本地 JSONL（结构化日志）", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "ts-core-conversation-log-"));
    const logSink = createLocalConversationReplyLogSink({
      baseDir,
      sensitiveValues: ["sk-local-dev"],
    });

    try {
      await logSink({
        bot_id: "bot-log",
        message_id: "msg/log:1",
        created_at: "2026-05-03T01:46:56.000Z",
        owner_message: "你在哪",
        route_kind: "chat_reply",
        reply_mode: "llm",
        reply: "我在这里喵~",
        contexts: {
          state_context: "当前状态：idle",
          memory_context: "api_key=sk-local-dev",
        },
        llm_diagnostics: {
          lines: [
            {
              role: "system",
              content: "[Bot] 位置:(0,64,0)\n[世界] minecraft:overworld",
            },
          ],
        },
      });

      const content = await readFile(
        join(baseDir, "conversation", "2026-05-03", "msg_log_1.jsonl"),
        "utf8",
      );
      const line = JSON.parse(content.trim()) as {
        reply?: string;
        contexts?: { memory_context?: string };
        llm_diagnostics?: { lines?: Array<{ content?: string }> };
      };

      expect(line.reply).toBe("我在这里喵~");
      expect(line.contexts?.memory_context).toBe(`api_key=${"<redacted>"}`);
      expect(line.llm_diagnostics?.lines?.[0]?.content).toContain("[世界] minecraft:overworld");
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  it("应创建只读的 tasks（任务执行） / sandbox（沙箱执行） / llm（大语言模型） 日志行", () => {
    const taskStep = createTaskLogLine({
      t: 1_712_930_001,
      e: "step",
      i: 0,
      act: "goTo",
      p: { x: 1, y: 64, z: 2 },
      s: "ok",
      ms: 5200,
    });
    const sandboxLine = createSandboxLogLine({
      t: 1_712_930_001,
      phase: "facade_result",
      m: "goTo",
      s: "ok",
      r: { arrived: true },
      ms: 5200,
    });
    const llmLine = createLlmLogLine({
      t: 1_712_930_001,
      meta: {
        input_tokens: 120,
        output_tokens: 35,
        ms: 800,
        ok: true,
      },
    });

    expect(Object.isFrozen(taskStep)).toBe(true);
    expect(Object.isFrozen(taskStep.p ?? {})).toBe(true);
    expect(Object.isFrozen(sandboxLine.r ?? {})).toBe(true);
    expect(Object.isFrozen(llmLine.meta)).toBe(true);

    const llmSummary = createLlmDiagnosticSummary({
      stage: "triage",
      message_id: "msg-001",
      status: "error",
      model: "bl-auto",
      log_ref: "llm/2026-04-13/triage-msg-001.jsonl",
      created_at: "2026-04-13T12:00:00.000Z",
      error_summary: "upstream timeout",
    });

    expect(llmSummary).toEqual({
      stage: "triage",
      message_id: "msg-001",
      status: "error",
      model: "bl-auto",
      log_ref: "llm/2026-04-13/triage-msg-001.jsonl",
      created_at: "2026-04-13T12:00:00.000Z",
      error_summary: "upstream timeout",
    });
    expect(Object.isFrozen(llmSummary)).toBe(true);

    const redactedLlmSummary = createLlmDiagnosticSummary(
      {
        stage: "chat",
        message_id: "msg-002",
        status: "error",
        model: "bl-auto",
        log_ref: "llm/2026-04-13/chat-msg-002.jsonl",
        created_at: "2026-04-13T12:00:01.000Z",
        error_summary:
          "LLM_API_KEY=sk-local-dev failed postgres://user:pg-pass@localhost/db redis://:redis-pass@localhost EasyAuth密码=hunter2",
      },
      { sensitiveValues: ["hunter2"] },
    );

    expect(redactedLlmSummary.error_summary).toContain("<redacted>");
    expect(redactedLlmSummary.error_summary).not.toContain("sk-local-dev");
    expect(redactedLlmSummary.error_summary).not.toContain("pg-pass");
    expect(redactedLlmSummary.error_summary).not.toContain("redis-pass");
    expect(redactedLlmSummary.error_summary).not.toContain("hunter2");
  });

  it("应让 tasks（任务执行） 摘要与运行时 started / terminal（已开始 / 终态） 生命周期对齐", () => {
    const job = createSandboxCodeJob({
      message_id: "T-008",
      intent_epoch: 6,
      snapshot_ts: 1_712_940_000,
      priority: ExecPriority.Normal,
      code: "await api.chat.say('ok')",
    });
    const startedSummary = createTaskLifecycleSummaryJsonlLine({
      t: 1_712_940_001,
      lifecycle: createTaskStartedLifecycleEvent(job),
    });
    const failedLifecycle = createTaskTerminalLifecycleEvent({
      job,
      status: TaskHistoryStatus.Failed,
      total_steps: 2,
      duration_ms: 9800,
      error: {
        name: "StaticCheckError",
        message: "Forbidden import detected",
      },
      last_step: "goTo",
    });
    if (failedLifecycle.status !== TaskHistoryStatus.Failed) {
      throw new Error("expected failed terminal lifecycle");
    }
    const failedSummary = createTaskLifecycleSummaryJsonlLine({
      t: 1_712_940_099,
      lifecycle: failedLifecycle as TaskLifecycleEvent<TaskHistoryStatus.Failed>,
    });

    expect(startedSummary.status).toBe(TaskHistoryStatus.Started);
    expect(startedSummary.e).toBe("task.started");
    expect(failedSummary.status).toBe(TaskHistoryStatus.Failed);
    expect(failedSummary.e).toBe("task.failed");
    expect(failedSummary.err.message).toBe("Forbidden import detected");
    expect(Object.isFrozen(failedSummary.err)).toBe(true);
  });

  it("应创建携带阶段日志与终态摘要的 sandbox（沙箱执行） 请求和结果", () => {
    const resourceLimits = createSandboxResourceLimits();
    const logRef = createSandboxLogRef({
      date: "2026-04-13",
      job_id: "T-007",
    });
    const codeRef = createSandboxCodeRef({
      date: "2026-04-13",
      job_id: "T-007",
    });
    const request = createSandboxExecutionRequest({
      job_id: "T-007",
      bot_id: "bot-007",
      intent_epoch: 4,
      snapshot_ts: 1712930000,
      code: "await api.bot.goTo({ x: 1, y: 64, z: 2 });",
      log_ref: logRef,
      code_ref: codeRef,
      resource_limits: resourceLimits,
    });
    const phaseLogs = [
      createSandboxLogLine({
        t: 1_712_930_000,
        phase: "precheck",
        ok: true,
      }),
      createSandboxLogLine({
        t: 1_712_930_022,
        phase: "sandbox_complete",
        steps: 1,
        ms: 22000,
      }),
    ] as const;
    const stepResults = [
      createSandboxStepResult({
        step_index: 0,
        action: "goTo",
        params: { x: 1, y: 64, z: 2 },
        status: "ok",
        duration_ms: 5200,
        result: { x: 1, y: 64, z: 2 },
      }),
    ] as const;
    const success = createSandboxExecutionSuccess({
      job_id: request.job_id,
      bot_id: request.bot_id,
      intent_epoch: request.intent_epoch,
      log_ref: request.log_ref,
      ...(request.code_ref !== undefined ? { code_ref: request.code_ref } : {}),
      phase_logs: phaseLogs,
      step_results: stepResults,
      summary: {
        total_steps: 1,
        duration_ms: 22000,
      },
    });

    expect(request.type).toBe(ExecutionTaskKind.SandboxCode);
    expect(success.status).toBe(TaskHistoryStatus.Completed);
    expect(success.summary.terminal_status).toBe(TaskHistoryStatus.Completed);
    expect(Object.isFrozen(success.phase_logs)).toBe(true);
    expect(success.step_results).toHaveLength(1);
    expect(Object.isFrozen(success.step_results[0]?.params ?? {})).toBe(true);
  });

  it("应覆盖文档要求的错误分类并区分失败与中断终态", () => {
    const logRef = createSandboxLogRef({
      date: "2026-04-13",
      job_id: "T-007",
    });
    const phaseLogs = [
      createSandboxLogLine({
        t: 1_712_930_000,
        phase: "precheck",
        ok: false,
        violation: "\\bimport\\s",
      }),
    ] as const;
    const staticCheckError = createSandboxError({
      name: "StaticCheckError",
      message: "Forbidden import detected",
      recoverable: false,
      violation: "\\bimport\\s",
    });
    const abortError = createSandboxError({
      name: "AbortError",
      message: "Sandbox aborted",
      recoverable: false,
      reason: "owner_interrupt",
    });
    const failure = createSandboxExecutionFailure({
      job_id: "T-007",
      bot_id: "bot-007",
      intent_epoch: 4,
      log_ref: logRef,
      phase_logs: phaseLogs,
      step_results: [],
      summary: {
        total_steps: 0,
        duration_ms: 10,
      },
      error: staticCheckError,
    });
    const interrupted = createSandboxExecutionInterrupted({
      job_id: "T-007",
      bot_id: "bot-007",
      intent_epoch: 4,
      log_ref: logRef,
      phase_logs: phaseLogs,
      step_results: [],
      summary: {
        total_steps: 0,
        duration_ms: 10,
      },
      error: abortError,
    });

    expect(failure.status).toBe(TaskHistoryStatus.Failed);
    expect(failure.error.name).toBe("StaticCheckError");
    expect(interrupted.status).toBe(TaskHistoryStatus.Interrupted);
    expect(interrupted.error.name).toBe("AbortError");
    expect(interrupted.error.recoverable).toBe(false);
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

  it("应创建已脱敏、限长且只读的 sandbox experience（沙箱经验）草案", () => {
    const draft = createSandboxExperienceDraft({
      bot_id: "bot-035",
      message_id: "msg-sandbox-exp",
      intent_epoch: 7,
      status: TaskHistoryStatus.Failed,
      total_steps: 2,
      duration_ms: 3456,
      log_ref: "sandbox/2026-04-26/msg-sandbox-exp.jsonl",
      code_ref: "sandbox/2026-04-26/msg-sandbox-exp.code.ts",
      code: String.raw`await api.chat.say('LLM_API_KEY=sk-local-dev password=hunter2 file=/home/hcid274/code/MC_WSL_servant/.env win=C:\Users\hcid274\.ts-core\.env')`,
      error: {
        name: "FacadeCallError",
        message: String.raw`failed with sk-local-dev postgres://user:pg-pass@localhost/db EasyAuth密码=hunter2 at /Users/dev/MC_WSL_servant/.env and C:\Users\dev\AppData\Local\ts-core\.env`,
        error_code: "path_not_found",
        recoverable: false,
      },
      sensitiveValues: ["hunter2"],
    });

    expect(draft.status).toBe(TaskHistoryStatus.Failed);
    expect(draft.code_hash).toMatch(/^sha256:/);
    expect(draft.code_preview?.length ?? 0).toBeLessThanOrEqual(240);
    expect(draft.summary.length).toBeLessThanOrEqual(240);
    expect(JSON.stringify(draft)).not.toContain("sk-local-dev");
    expect(JSON.stringify(draft)).not.toContain("pg-pass");
    expect(JSON.stringify(draft)).not.toContain("hunter2");
    expect(JSON.stringify(draft)).not.toContain("/home/hcid274/code/MC_WSL_servant/.env");
    expect(JSON.stringify(draft)).not.toContain("/Users/dev/MC_WSL_servant/.env");
    expect(JSON.stringify(draft)).not.toContain(String.raw`C:\Users\hcid274\.ts-core\.env`);
    expect(JSON.stringify(draft)).not.toContain(
      String.raw`C:\Users\dev\AppData\Local\ts-core\.env`,
    );
    expect(JSON.stringify(draft)).toContain("<redacted-path>");
    expect(Object.isFrozen(draft)).toBe(true);
    expect(Object.isFrozen(draft.error ?? {})).toBe(true);

    expect(() =>
      createSandboxExperienceDraft({
        bot_id: "bot-035",
        message_id: "msg-sandbox-exp-bad",
        intent_epoch: 7,
        status: TaskHistoryStatus.Failed,
        total_steps: 0,
        duration_ms: 1,
      }),
    ).toThrow(/requires error/);
  });
});
