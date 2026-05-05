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
    expect(result.diagnostics.lines).toContainEqual(
      expect.objectContaining({
        role: "assistant",
        content: "当然可以，我在这里陪着你",
      }),
    );
    expect(diagnostics).toEqual([result.diagnostics]);
  });

  it("应记录 LLM（大语言模型）分段性能指标且非 stream（流式响应）ttft 显式不可得", async () => {
    const ticks = [0, 6, 10, 20, 80, 90, 95];
    const nextTick = () => ticks.shift() ?? 85;
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
        monotonicNow: nextTick,
        fetch: async () =>
          new Response(
            JSON.stringify({
              choices: [{ message: { content: "ok" } }],
              usage: { prompt_tokens: 12, completion_tokens: 3 },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      },
    );

    const result = await client.generateChatReply({
      message_id: "msg-llm-metrics",
      message: "只回复 ok",
      queue_wait_ms: 42,
    });

    expect(result.diagnostics.metrics).toEqual({
      queue_wait_ms: 42,
      prompt_build_ms: 6,
      request_total_ms: 60,
      response_parse_ms: 5,
      tool_round_count: 0,
      tool_round_ms: [],
      diagnostics_write_ms: null,
      input_tokens: 12,
      output_tokens: 3,
      tokens_per_second: 50,
      ttft_ms: null,
      ttft_unavailable: "non_streaming",
    });
    expect(result.diagnostics.lines.at(-1)).toMatchObject({
      meta: {
        metrics: result.diagnostics.metrics,
      },
    });
  });

  it("Chat（闲聊） 应暴露 search() tool（工具） 并把 brain.search（大脑检索） 结果回填给 LLM", async () => {
    const capturedBodies: unknown[] = [];
    const searchCalls: unknown[] = [];
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
        now: () => new Date("2026-04-24T10:00:00.000Z"),
        fetch: async (_url, init) => {
          const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
          capturedBodies.push(body);

          if (capturedBodies.length === 1) {
            return new Response(
              JSON.stringify({
                choices: [
                  {
                    message: {
                      content: "",
                      tool_calls: [
                        {
                          id: "call-search-1",
                          type: "function",
                          function: {
                            name: "search",
                            arguments: '{"query":"上次捡盾牌","top_k":5}',
                          },
                        },
                      ],
                    },
                  },
                ],
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }

          return new Response(
            JSON.stringify({
              choices: [{ message: { content: "上次捡到 shield x1" } }],
              usage: { prompt_tokens: 50, completion_tokens: 8 },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        },
      },
    );

    const result = await client.generateChatReply({
      bot_id: "bot-cw",
      message_id: "msg-chat-search",
      message: "你上次捡到了什么",
      brain_context: "[A.5滚动摘要]\n最近帮主人捡过东西",
      search_tool: async (input) => {
        searchCalls.push(input);

        return {
          hits: [
            {
              id: "event-1",
              task_id: "msg-collect",
              owner_text: "去捡盾牌",
              task_card: { result: "collect 成功，捡到 shield x1" },
              created_at: "2026-04-24T09:59:00.000Z",
              score: 0.9,
            },
          ],
        };
      },
    });

    expect(result.reply).toBe("上次捡到 shield x1");
    expect(searchCalls).toEqual([
      {
        bot_id: "bot-cw",
        query: "上次捡盾牌",
        top_k: 5,
      },
    ]);
    expect(capturedBodies[0]).toMatchObject({
      tools: [
        expect.objectContaining({
          type: "function",
          function: expect.objectContaining({ name: "search" }),
        }),
      ],
      tool_choice: "auto",
    });
    expect(capturedBodies[1]).toMatchObject({
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: "tool",
          tool_call_id: "call-search-1",
          content: expect.stringContaining("collect 成功，捡到 shield x1"),
        }),
      ]),
    });
    expect(result.diagnostics.lines).toContainEqual(
      expect.objectContaining({
        role: "tool",
        content: expect.stringContaining("collect 成功，捡到 shield x1"),
      }),
    );
    expect(result.diagnostics.lines).toContainEqual(
      expect.objectContaining({
        role: "assistant",
        content: "",
        tool_calls: [
          expect.objectContaining({
            id: "call-search-1",
          }),
        ],
      }),
    );
    expect(result.diagnostics.lines).toContainEqual(
      expect.objectContaining({
        role: "assistant",
        content: "上次捡到 shield x1",
      }),
    );
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
