import { describe, expect, it } from "vitest";

import {
  ConversationLlmChatError,
  createConversationChatMessages,
  createConversationLlmClient,
  createConversationLlmConfig,
} from "../conversation/llm.js";

describe("conversation llm（对话大语言模型） 运行时", () => {
  it("Chat（闲聊） system prompt（系统提示词） 应注入快照上下文且不补空槽位", () => {
    const messages = createConversationChatMessages({
      message_id: "msg-chat-snapshot",
      message: "你在哪",
      bot_name: "maid_bot",
      owner_name: "主人",
      snapshot_context: [
        "[Bot] 位置:(0,64,0) 生命:20/20 饥饿:20/20 着火:否",
        "[世界] minecraft:overworld",
        "[主人] 离线",
        "[背包] 空",
        "[时间] 白天(1000)",
      ].join("\n"),
    });

    expect(messages[0]?.content).toContain("[Bot] 位置:(0,64,0)");
    expect(messages[0]?.content).toContain("[世界] minecraft:overworld");
    expect(messages[0]?.content).toContain("[主人] 离线");
    expect(messages[0]?.content).toContain("[背包] 空");
    expect(messages[0]?.content).toContain("[时间] 白天(1000)");
    expect(messages[0]?.content).not.toContain("[背包变化]");
    expect(messages[0]?.content).not.toContain("[最近上下文]");
  });

  it("应按 OpenAI（开放人工智能） 兼容 chat.completions（对话补全） 组装请求并解析回复", async () => {
    const capturedRequests: Array<{
      url: string;
      headers: HeadersInit | undefined;
      body: unknown;
    }> = [];
    const diagnostics: unknown[] = [];
    const client = createConversationLlmClient(
      createConversationLlmConfig({
        base_url: "http://127.0.0.1:8045/v1/",
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
            headers: init?.headers,
            body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
          });

          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: "当然可以，我在这里陪着你",
                  },
                },
              ],
              usage: {
                prompt_tokens: 21,
                completion_tokens: 9,
              },
            }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
              },
            },
          );
        },
        now: () => new Date("2026-04-24T10:00:00.000Z"),
        onDiagnostic: (record) => {
          diagnostics.push(record);
        },
      },
    );

    const result = await client.generateChatReply({
      message_id: "msg-llm-chat",
      message: "今天天气怎么样",
      history: [
        { role: "owner", content: "早上好" },
        { role: "bot", content: "早上好喵~" },
      ],
      memory_context: "主人今天想测试真实闲聊回包。",
      state_context: "当前状态：executing；正在执行技能：mine（消息 msg-mine）",
    });

    expect(result.reply).toBe("当然可以，我在这里陪着你");
    expect(capturedRequests).toEqual([
      {
        url: "http://127.0.0.1:8045/v1/chat/completions",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer sk-local-dev",
        },
        body: {
          model: "bl-auto",
          messages: createConversationChatMessages({
            message_id: "msg-llm-chat",
            message: "今天天气怎么样",
            history: [
              { role: "owner", content: "早上好" },
              { role: "bot", content: "早上好喵~" },
            ],
            memory_context: "主人今天想测试真实闲聊回包。",
            state_context: "当前状态：executing；正在执行技能：mine（消息 msg-mine）",
            bot_name: "maid_bot",
            owner_name: "主人",
          }),
        },
      },
    ]);
    const requestBody = capturedRequests[0]?.body as {
      messages?: Array<{ role: string; content: string }>;
    };
    expect(requestBody.messages?.[0]?.content).toContain("记忆摘要：主人今天想测试真实闲聊回包。");
    expect(requestBody.messages?.[0]?.content).toContain(
      "当前状态摘要：当前状态：executing；正在执行技能：mine（消息 msg-mine）",
    );
    expect(result.diagnostics).toMatchObject({
      stage: "chat",
      model: "bl-auto",
      message_id: "msg-llm-chat",
      log_ref: "llm/2026-04-24/chat-msg-llm-chat.jsonl",
      ok: true,
    });
    expect(result.diagnostics.lines.at(-1)).toMatchObject({
      meta: {
        input_tokens: 21,
        output_tokens: 9,
        ok: true,
      },
    });
    expect(diagnostics).toEqual([result.diagnostics]);
  });

  it("应把关闭 thinking（思考） 模式转换为 MiMo（小米大模型） 私有参数", async () => {
    const capturedBodies: unknown[] = [];
    const client = createConversationLlmClient(
      createConversationLlmConfig({
        base_url: "https://token-plan-cn.xiaomimimo.com/v1",
        api_key: "sk-local-dev",
        model: "mimo-v2.5",
        enable_thinking: false,
        reasoning_effort: "none",
        bot_name: "maid_bot",
        owner_name: "主人",
        timeout_ms: 15_000,
      }),
      {
        fetch: async (_url, init) => {
          capturedBodies.push(init?.body === undefined ? undefined : JSON.parse(String(init.body)));

          return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      },
    );

    await client.generateChatReply({
      message_id: "msg-mimo-no-thinking",
      message: "只回复 ok",
    });

    expect(capturedBodies).toEqual([
      expect.objectContaining({
        model: "mimo-v2.5",
        chat_template_kwargs: {
          enable_thinking: false,
        },
      }),
    ]);
  });

  it("应允许 force thinking models（强制思考模型） 覆盖默认关闭策略", async () => {
    const capturedBodies: unknown[] = [];
    const client = createConversationLlmClient(
      createConversationLlmConfig({
        base_url: "https://token-plan-cn.xiaomimimo.com/v1",
        api_key: "sk-local-dev",
        model: "mimo-v2.5-pro",
        enable_thinking: false,
        reasoning_effort: "none",
        force_thinking_models: ["mimo-v2.5-pro"],
        bot_name: "maid_bot",
        owner_name: "主人",
        timeout_ms: 15_000,
      }),
      {
        fetch: async (_url, init) => {
          capturedBodies.push(init?.body === undefined ? undefined : JSON.parse(String(init.body)));

          return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      },
    );

    await client.generateChatReply({
      message_id: "msg-mimo-force-thinking",
      message: "只回复 ok",
    });

    expect(capturedBodies).toEqual([
      expect.objectContaining({
        model: "mimo-v2.5-pro",
        chat_template_kwargs: {
          enable_thinking: true,
        },
      }),
    ]);
  });

  it("应拒绝非 MiMo（小米大模型） force thinking（强制思考） 但 reasoning effort（推理强度） 为 none 的配置", () => {
    expect(() =>
      createConversationLlmConfig({
        base_url: "http://127.0.0.1:8045/v1",
        api_key: "sk-local-dev",
        model: "gpt-5.5",
        enable_thinking: false,
        reasoning_effort: "none",
        force_thinking_models: ["gpt-5.5"],
        bot_name: "maid_bot",
        owner_name: "主人",
        timeout_ms: 15_000,
      }),
    ).toThrow(
      "LLM_FORCE_THINKING_MODELS includes a non-MiMo model; set LLM_REASONING_EFFORT to a non-none value",
    );
  });

  it("应在非 MiMo（小米大模型） force thinking（强制思考） 且 effort（强度） 有效时发送 reasoning_effort", async () => {
    const capturedBodies: unknown[] = [];
    const client = createConversationLlmClient(
      createConversationLlmConfig({
        base_url: "http://127.0.0.1:8045/v1",
        api_key: "sk-local-dev",
        model: "gpt-5.5",
        enable_thinking: false,
        reasoning_effort: "medium",
        force_thinking_models: ["gpt-5.5"],
        bot_name: "maid_bot",
        owner_name: "主人",
        timeout_ms: 15_000,
      }),
      {
        fetch: async (_url, init) => {
          capturedBodies.push(init?.body === undefined ? undefined : JSON.parse(String(init.body)));

          return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      },
    );

    await client.generateChatReply({
      message_id: "msg-non-mimo-force-thinking",
      message: "只回复 ok",
    });

    expect(capturedBodies).toEqual([
      expect.objectContaining({
        model: "gpt-5.5",
        reasoning_effort: "medium",
      }),
    ]);
  });

  it("应在请求失败时留下显式诊断并抛出带诊断的错误", async () => {
    const diagnostics: unknown[] = [];
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
              error: {
                message: "upstream overload",
              },
            }),
            {
              status: 502,
              headers: {
                "content-type": "application/json",
              },
            },
          ),
        now: () => new Date("2026-04-24T10:00:00.000Z"),
        onDiagnostic: (record) => {
          diagnostics.push(record);
        },
      },
    );

    await expect(
      client.generateChatReply({
        message_id: "msg-llm-failed",
        message: "随便聊聊",
      }),
    ).rejects.toMatchObject({
      name: "ConversationLlmChatError",
      message: "upstream overload",
    });

    const error = await client
      .generateChatReply({
        message_id: "msg-llm-failed-2",
        message: "再试一次",
      })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ConversationLlmChatError);
    if (!(error instanceof ConversationLlmChatError)) {
      throw new Error("expected ConversationLlmChatError");
    }
    expect(error.diagnostics).toMatchObject({
      stage: "chat",
      model: "bl-auto",
      message_id: "msg-llm-failed-2",
      ok: false,
      error_summary: "upstream overload",
    });
    expect(error.diagnostics.lines.at(-1)).toMatchObject({
      meta: {
        ok: false,
      },
      err: {
        message: "upstream overload",
      },
    });
    expect(diagnostics).toHaveLength(2);
  });
});
