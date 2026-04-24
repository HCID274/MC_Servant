import { describe, expect, it } from "vitest";

import {
  ConversationLlmChatError,
  createConversationChatMessages,
  createConversationLlmClient,
  createConversationLlmConfig,
} from "../conversation/llm.js";

describe("conversation llm（对话大语言模型） 运行时", () => {
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
            bot_name: "maid_bot",
            owner_name: "主人",
          }),
        },
      },
    ]);
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
