import { describe, expect, it } from "vitest";

import {
  ConversationLlmPlanError,
  createConversationLlmClient,
  createConversationLlmConfig,
  createConversationPlanMessages,
  createConversationTriageMessages,
} from "../conversation/llm.js";

describe("conversation llm（对话大语言模型） 分诊与规划", () => {
  it("应按 OpenAI（开放人工智能） 兼容 chat.completions（对话补全） 发起 triage（分诊） 请求并解析 JSON", async () => {
    const capturedRequests: Array<{ url: string; body: unknown }> = [];
    const client = createConversationLlmClient(
      createConversationLlmConfig({
        base_url: "http://127.0.0.1:8045/v1",
        api_key: "sk-local-dev",
        model: "bl-auto",
        bot_name: "maid_bot",
        owner_name: "主人",
        timeout_ms: 15_000,
      }),
      {
        fetch: async (url, init) => {
          capturedRequests.push({
            url: String(url),
            body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
          });

          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content:
                      '{"intent":"task","priority":"urgent","reason":"主人给了明确坐标移动指令"}',
                  },
                },
              ],
            }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
              },
            },
          );
        },
      },
    );

    const result = await client.generateTriage({
      message_id: "msg-triage",
      message: "请去坐标 x=10 y=64 z=-5",
      bot_summary: "idle",
      history: [{ role: "owner", content: "你现在空着吗" }],
    });

    expect(result).toEqual({
      intent: "task",
      priority: "urgent",
      reason: "主人给了明确坐标移动指令",
    });
    expect(capturedRequests).toEqual([
      {
        url: "http://127.0.0.1:8045/v1/chat/completions",
        body: {
          model: "bl-auto",
          messages: createConversationTriageMessages({
            message_id: "msg-triage",
            message: "请去坐标 x=10 y=64 z=-5",
            bot_summary: "idle",
            history: [{ role: "owner", content: "你现在空着吗" }],
          }),
        },
      },
    ]);
  });

  it("应在 triage（分诊） 返回非法 JSON 时安全回退为 chat/normal", async () => {
    const client = createConversationLlmClient(
      createConversationLlmConfig({
        base_url: "http://127.0.0.1:8045/v1",
        api_key: "sk-local-dev",
        model: "bl-auto",
        bot_name: "maid_bot",
        owner_name: "主人",
        timeout_ms: 15_000,
      }),
      {
        fetch: async () =>
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: "这不是 JSON",
                  },
                },
              ],
            }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
              },
            },
          ),
      },
    );

    await expect(
      client.generateTriage({
        message_id: "msg-triage-fallback",
        message: "随便聊聊",
      }),
    ).resolves.toEqual({
      intent: "chat",
      priority: "normal",
      reason: "llm_triage_fallback",
    });
  });

  it("应将在线 triage（分诊） prompt 收窄到 chat/task/cancel 三类", () => {
    const messages = createConversationTriageMessages({
      message_id: "msg-triage-scope",
      message: "把刚才的任务改成去 10 64 -5",
      bot_summary: "online_runtime_ready",
    });

    expect(messages[0]?.content).toContain("只允许输出 chat、task、cancel 三类意图");
    expect(messages[0]?.content).not.toContain("- modify：");
    expect(messages[0]?.content).toContain('"intent":"chat|task|cancel"');
  });

  it("应按 OpenAI（开放人工智能） 兼容 chat.completions（对话补全） 发起最小 goTo（前往坐标） 规划并校验载荷", async () => {
    const capturedRequests: Array<{ url: string; body: unknown }> = [];
    const client = createConversationLlmClient(
      createConversationLlmConfig({
        base_url: "http://127.0.0.1:8045/v1",
        api_key: "sk-local-dev",
        model: "bl-auto",
        bot_name: "maid_bot",
        owner_name: "主人",
        timeout_ms: 15_000,
      }),
      {
        fetch: async (url, init) => {
          capturedRequests.push({
            url: String(url),
            body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
          });

          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content:
                      '{"type":"skill_call","reply":"收到，我这就过去","skill":"goTo","params":{"x":10,"y":64,"z":-5}}',
                  },
                },
              ],
            }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
              },
            },
          );
        },
      },
    );

    const result = await client.generateGoToPlan({
      message_id: "msg-plan",
      message: "去 10, 64, -5 那里",
      snapshot_context: "online_runtime: world interaction task planning; only goTo is executable",
      triage_reason: "主人给了明确坐标移动指令",
    });

    expect(result).toEqual({
      type: "skill_call",
      reply: "收到，我这就过去喵~",
      skill: "goTo",
      params: {
        x: 10,
        y: 64,
        z: -5,
      },
    });
    expect(capturedRequests).toEqual([
      {
        url: "http://127.0.0.1:8045/v1/chat/completions",
        body: {
          model: "bl-auto",
          messages: createConversationPlanMessages({
            message_id: "msg-plan",
            message: "去 10, 64, -5 那里",
            snapshot_context:
              "online_runtime: world interaction task planning; only goTo is executable",
            triage_reason: "主人给了明确坐标移动指令",
          }),
        },
      },
    ]);
  });

  it("应在最小 goTo（前往坐标） 规划返回非法载荷时抛出显式错误", async () => {
    const client = createConversationLlmClient(
      createConversationLlmConfig({
        base_url: "http://127.0.0.1:8045/v1",
        api_key: "sk-local-dev",
        model: "bl-auto",
        bot_name: "maid_bot",
        owner_name: "主人",
        timeout_ms: 15_000,
      }),
      {
        fetch: async () =>
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content:
                      '{"type":"skill_call","reply":"收到","skill":"mine","params":{"blockName":"stone","count":1}}',
                  },
                },
              ],
            }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
              },
            },
          ),
      },
    );

    await expect(
      client.generateGoToPlan({
        message_id: "msg-plan-invalid",
        message: "帮我走过去",
        snapshot_context:
          "online_runtime: world interaction task planning; only goTo is executable",
      }),
    ).rejects.toBeInstanceOf(ConversationLlmPlanError);
  });
});
