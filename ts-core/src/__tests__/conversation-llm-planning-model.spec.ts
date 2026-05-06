import { describe, expect, it } from "vitest";

import {
  CONVERSATION_SKILL_PLAN_TABLE,
  ConversationLlmPlanError,
  ConversationLlmSkillNotEnabledError,
  ConversationLlmTriageError,
  createChatSnapshotContext,
  createConversationLlmClient,
  createConversationLlmConfig,
  createConversationPlanMessages,
  createConversationSkillPlanPromptSection,
  createConversationTriageMessages,
  createPlannerSnapshotContext,
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
                      '{"action":{"intent":"task","priority":"urgent","reason":"主人给了明确坐标移动指令"}}',
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

    const result = await client.generateCompositeTriage({
      message_id: "msg-triage",
      message: "请去坐标 x=10 y=64 z=-5",
      bot_summary: "idle",
      history: [{ role: "owner", content: "你现在空着吗" }],
    });

    expect(result).toEqual({
      action: {
        intent: "task",
        priority: "urgent",
        reason: "主人给了明确坐标移动指令",
      },
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

  it("triage（分诊） prompt（提示词） 不应要求生成聊天正文", () => {
    const messages = createConversationTriageMessages({
      message_id: "msg-triage-prompt",
      message: "你在哪",
    });

    expect(messages[0]?.content).toContain("分诊只做路由判断");
    expect(messages[0]?.content).toContain('纯闲聊只输出 chat 空对象，例如 {"chat":{}}。');
    expect(messages[0]?.content).toContain("即使 Brain上下文或最近历史里出现过类似任务完成记录");
    expect(messages[0]?.content).not.toContain('"content":"我在喵~"');
    expect(messages[0]?.content).not.toContain("reply 只写自然短句");
  });

  it("triage（分诊） 应通过 prompt（提示词） 指向重复明确动作指令不能被历史完成记录吞掉", async () => {
    const capturedRequests: Array<{ body: unknown }> = [];
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
        fetch: async (_url, init) => {
          capturedRequests.push({
            body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
          });

          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content:
                      '{"action":{"intent":"task","priority":"normal","reason":"主人重复给出明确砍树动作指令"}}',
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

    await expect(
      client.generateCompositeTriage({
        message_id: "msg-triage-repeat-cut-tree",
        message: "给我砍5块木头",
        bot_summary: "idle",
        brain_context: "主人要求“给我砍5块木头”，Bot 执行技能 cutTree完成。",
      }),
    ).resolves.toEqual({
      action: {
        intent: "task",
        priority: "normal",
        reason: "主人重复给出明确砍树动作指令",
      },
    });
    expect(JSON.stringify(capturedRequests[0]?.body)).toContain(
      "即使 Brain上下文或最近历史里出现过类似任务完成记录",
    );
  });

  it("三阶段 prompt（提示词） 应按表注入 A.5 + C 层且 Triage（分诊） 不暴露 search() tool（工具）", async () => {
    const triageMessages = createConversationTriageMessages({
      message_id: "msg-brain-triage",
      message: "你记得我家在哪吗",
      brain_context:
        "[A.5滚动摘要]\n最近在基地附近活动\n[C.USER]\n主人喜欢直接回答\n[C.MEMORY]\n主基地 x=120 y=64 z=-300",
    });
    const planMessages = createConversationPlanMessages({
      message_id: "msg-brain-plan",
      message: "按以前的流程去挖矿",
      snapshot_context: "[Bot] 位置:(0,64,0)",
      brain_context:
        "[A.5滚动摘要]\n最近准备挖矿\n[C.USER]\n主人喜欢直接回答\n[C.MEMORY]\n主基地 x=120\n[C.SKILL]\n挖矿前检查铁镐和火把",
    });

    expect(triageMessages[1]?.content).toContain("[A.5滚动摘要]");
    expect(triageMessages[1]?.content).toContain("[C.USER]");
    expect(triageMessages[1]?.content).toContain("[C.MEMORY]");
    expect(triageMessages[1]?.content).not.toContain("[C.SKILL]");
    expect(planMessages[1]?.content).toContain("[C.SKILL]");

    const capturedBodies: unknown[] = [];
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
        fetch: async (_url, init) => {
          capturedBodies.push(init?.body === undefined ? undefined : JSON.parse(String(init.body)));

          return new Response(
            JSON.stringify({ choices: [{ message: { content: '{"chat":{}}' } }] }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        },
      },
    );

    await client.generateCompositeTriage({
      message_id: "msg-brain-triage-runtime",
      message: "你记得我家在哪吗",
      brain_context: "[A.5滚动摘要]\n最近在基地附近活动",
    });

    expect(capturedBodies[0]).not.toHaveProperty("tools");
    expect(capturedBodies[0]).not.toHaveProperty("tool_choice");
  });

  it("应按 OpenAI（开放人工智能） 兼容 chat.completions（对话补全） 解析 composite triage（复合分诊） JSON", async () => {
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
                      '{"cancel":{"reason":"主人要求先停下","priority":"interrupt"},"chat":{},"action":{"intent":"task","priority":"urgent","reason":"主人要求去坐标"}}',
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
      client.generateCompositeTriage({
        message_id: "msg-composite-triage",
        message: "停下当前任务，回我一句知道了，然后去坐标 1 64 -3",
        bot_summary: "executing",
      }),
    ).resolves.toEqual({
      cancel: {
        reason: "主人要求先停下",
        priority: "interrupt",
      },
      chat: {},
      action: {
        intent: "task",
        priority: "urgent",
        reason: "主人要求去坐标",
      },
    });
  });

  it("应把 triage（分诊） chat 空对象解析为 Chat（闲聊） 路由片段", async () => {
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
          new Response(JSON.stringify({ choices: [{ message: { content: '{"chat":{}}' } }] }), {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          }),
      },
    );

    await expect(
      client.generateCompositeTriage({
        message_id: "msg-chat-triage",
        message: "你好呀",
      }),
    ).resolves.toEqual({ chat: {} });
  });

  it("Plan（规划） 应暴露 search() tool（工具） 并在 tool_result（工具结果） 后解析技能计划", async () => {
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
        fetch: async (_url, init) => {
          capturedBodies.push(init?.body === undefined ? undefined : JSON.parse(String(init.body)));

          if (capturedBodies.length === 1) {
            return new Response(
              JSON.stringify({
                choices: [
                  {
                    message: {
                      content: "",
                      tool_calls: [
                        {
                          id: "call-plan-search",
                          type: "function",
                          function: {
                            name: "search",
                            arguments: '{"query":"基地坐标"}',
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
              choices: [
                {
                  message: {
                    content:
                      '{"type":"skill_call","reply":"我去基地附近看看喵~","skill":"goTo","params":{"x":120,"y":64,"z":-300}}',
                  },
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        },
      },
    );

    const result = await client.generateSkillPlan({
      bot_id: "bot-cw",
      message_id: "msg-plan-search",
      message: "去基地",
      snapshot_context: "[主人] 位置:(0,64,0)",
      search_tool: async (input) => {
        searchCalls.push(input);

        return {
          hits: [
            {
              id: "event-base",
              task_id: "msg-base",
              owner_text: "这里是我们的基地",
              task_card: { owner_position_at_message: { x: 120, y: 64, z: -300 } },
              created_at: "2026-04-24T10:00:00.000Z",
              score: 0.88,
            },
          ],
        };
      },
    });

    expect(result).toMatchObject({
      type: "skill_call",
      skill: "goTo",
      params: { x: 120, y: 64, z: -300 },
    });
    expect(searchCalls).toEqual([{ bot_id: "bot-cw", query: "基地坐标" }]);
    expect(capturedBodies[0]).toMatchObject({ tool_choice: "auto" });
    expect(capturedBodies[1]).toMatchObject({
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: "tool",
          content: expect.stringContaining("这里是我们的基地"),
        }),
      ]),
    });
  });

  it("应拒绝旧单 intent（意图） triage（分诊） 输出并写入 diagnostics（诊断）", async () => {
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
        onDiagnostic: (record) => diagnostics.push(record),
        fetch: async () =>
          new Response(
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
          ),
      },
    );

    await expect(
      client.generateCompositeTriage({
        message_id: "msg-legacy-triage",
        message: "去 10 64 -5",
      }),
    ).rejects.toBeInstanceOf(ConversationLlmTriageError);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      stage: "triage",
      message_id: "msg-legacy-triage",
      ok: false,
      error_summary: "triage must use composite schema",
    });
  });

  it("应拒绝 triage（分诊） chat 片段携带正文并写入 diagnostics（诊断）", async () => {
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
        onDiagnostic: (record) => diagnostics.push(record),
        fetch: async () =>
          new Response(
            JSON.stringify({
              choices: [{ message: { content: '{"chat":{"content":"你好"}}' } }],
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          ),
      },
    );

    await expect(
      client.generateCompositeTriage({
        message_id: "msg-chat-content-triage",
        message: "你好呀",
      }),
    ).rejects.toBeInstanceOf(ConversationLlmTriageError);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      stage: "triage",
      message_id: "msg-chat-content-triage",
      ok: false,
      error_summary: "triage chat must be an empty object",
    });
  });

  it("应拒绝旧 reply 空对象 triage（分诊） schema（结构） 并写入 diagnostics（诊断）", async () => {
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
        onDiagnostic: (record) => diagnostics.push(record),
        fetch: async () =>
          new Response(
            JSON.stringify({
              choices: [{ message: { content: '{"reply":{}}' } }],
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          ),
      },
    );

    await expect(
      client.generateCompositeTriage({
        message_id: "msg-legacy-reply-triage",
        message: "你好呀",
      }),
    ).rejects.toBeInstanceOf(ConversationLlmTriageError);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      stage: "triage",
      message_id: "msg-legacy-reply-triage",
      ok: false,
      error_summary: "triage reply field is no longer supported; use chat empty object",
    });
  });

  it("应在 triage（分诊） 返回非法 JSON 时抛出带 diagnostics（诊断） 的错误", async () => {
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
        onDiagnostic: (record) => diagnostics.push(record),
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
      client.generateCompositeTriage({
        message_id: "msg-triage-fallback",
        message: "随便聊聊",
      }),
    ).rejects.toMatchObject({
      name: "ConversationLlmTriageError",
      diagnostics: {
        stage: "triage",
        message_id: "msg-triage-fallback",
        ok: false,
      },
    });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      stage: "triage",
      message_id: "msg-triage-fallback",
      ok: false,
    });
  });

  it("应将在线 triage（分诊） prompt 升级为 composite（复合） 输出且禁止 modify（修改）", () => {
    const messages = createConversationTriageMessages({
      message_id: "msg-triage-scope",
      message: "把刚才的任务改成去 10 64 -5",
      bot_summary: "online_runtime_ready",
    });

    expect(messages[0]?.content).toContain("输出 composite JSON");
    expect(messages[0]?.content).toContain("cancel");
    expect(messages[0]?.content).toContain("chat");
    expect(messages[0]?.content).toContain("action");
    expect(messages[0]?.content).toContain("禁止输出 modify");
    expect(messages[0]?.content).toContain("cancel + action");
    expect(messages[0]?.content).not.toContain("- modify：");
  });

  it("应按 OpenAI（开放人工智能） 兼容 chat.completions（对话补全） 发起单技能规划，并允许 goTo（前往坐标） 结果", async () => {
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

    const result = await client.generateSkillPlan({
      message_id: "msg-plan",
      message: "去 10, 64, -5 那里",
      snapshot_context: "online_runtime: T-046 only; executable skills: goTo, collect",
      triage_reason: "主人给了明确坐标移动指令",
      memory_context: "历史：主人上次要求抵达坐标后先回报状态。",
    });

    expect(result).toMatchObject({
      type: "skill_call",
      reply: "收到，我这就过去喵~",
      skill: "goTo",
      params: {
        x: 10,
        y: 64,
        z: -5,
      },
    });
    expect(result.diagnostics).toMatchObject({
      stage: "plan",
      message_id: "msg-plan",
      ok: true,
    });
    expect(capturedRequests).toEqual([
      {
        url: "http://127.0.0.1:8045/v1/chat/completions",
        body: {
          model: "bl-auto",
          messages: createConversationPlanMessages({
            message_id: "msg-plan",
            message: "去 10, 64, -5 那里",
            snapshot_context: "online_runtime: T-046 only; executable skills: goTo, collect",
            triage_reason: "主人给了明确坐标移动指令",
            memory_context: "历史：主人上次要求抵达坐标后先回报状态。",
          }),
        },
      },
    ]);
    const requestBody = capturedRequests[0]?.body as {
      messages?: Array<{ role: string; content: string }>;
    };
    expect(requestBody.messages?.[1]?.content).toContain(
      "记忆摘要：历史：主人上次要求抵达坐标后先回报状态。",
    );
    expect(requestBody.messages?.[0]?.content).toContain("复杂任务输出 JSON");
    expect(requestBody.messages?.[0]?.content).toContain("你不直接执行世界动作");
  });

  it("单技能规划 prompt（提示词） 不应再把“三个坐标”写成通用失败条件", () => {
    const messages = createConversationPlanMessages({
      message_id: "msg-plan-prompt",
      message: "把地上的圆石捡起来",
      snapshot_context: "online_runtime: T-046 only; executable skills: goTo, collect",
    });

    expect(messages[0]?.content).toContain("无法规划输出 JSON");
    expect(messages[0]?.content).toContain("把这个东西捡起来");
    expect(messages[0]?.content).toContain("不要因为缺 itemName 输出 cannot_plan");
    expect(messages[0]?.content).toContain("禁止把 item、unknown 或 Item 当作 itemName");
    expect(messages[0]?.content).not.toContain("如果不能明确提取三个坐标");
  });

  it("应把真实 observation（观测） 快照压缩为 planner（规划器） 八行上下文", () => {
    const context = createPlannerSnapshotContext({
      snapshot: {
        timestamp: 1_712_000_000,
        snapshot_version: "planner-snapshot-1",
        bot: {
          position: { x: 10, y: 64, z: -2 },
          world_key: "multiworld:resource",
          health: 18,
          food: 16,
          experience: 3,
          is_on_fire: false,
          is_in_water: false,
          y_velocity: 0,
        },
        inventory: {
          items: [{ slot: 0, item_name: "oak_log", count: 12 }],
          total_items: 12,
          occupied_slots: 1,
          free_slots: 35,
        },
        equipment: {
          head: null,
          chest: null,
          legs: null,
          feet: null,
          main_hand: { slot: "main_hand", item_name: "stone_pickaxe", count: 1 },
          off_hand: null,
          has_weapon_equipped: false,
        },
        nearby_blocks: [
          { block_name: "oak_log", position: { x: 12, y: 64, z: -2 }, distance: 2 },
          { block_name: "stone", position: { x: 10, y: 63, z: -2 }, distance: 1 },
        ],
        nearby_entities: [
          {
            entity_id: "drop-1",
            entity_type: "item",
            kind: "other",
            display_name: "Item",
            position: { x: 11, y: 64, z: -2 },
            distance: 1,
          },
          {
            entity_id: "owner",
            entity_type: "player",
            kind: "player",
            display_name: "Steve",
            position: { x: 13, y: 64, z: -2 },
            distance: 3,
          },
        ],
        owner: {
          name: "Steve",
          online: true,
          position: { x: 13, y: 64, z: -2 },
        },
        time: {
          phase: "day",
          time_of_day: 6000,
        },
      },
    });

    expect(context).toContain("[Bot] 位置:(10,64,-2) 生命:18/20 饥饿:16/20 着火:否");
    expect(context).toContain("[世界] multiworld:resource");
    expect(context).toContain("[主人] 位置:(13,64,-2) 距离:3格 在线:是");
    expect(context).toContain("[装备] 头:无 身:无 腿:无 脚:无 主手:stone_pickaxe 副手:无");
    expect(context).toContain("[背包] oak_log x12");
    expect(context).toContain("[附近方块] stonex1(最近1格), oak_logx1(最近2格)");
    expect(context).toContain("[附近掉落物] Item(item,1格)");
    expect(context).toContain("[附近生物] player(玩家,3格)");
    expect(context).toContain("[时间] 白天(6000)");
  });

  it("主人离线时 planner（规划器） 快照上下文不应输出主人坐标", () => {
    const context = createPlannerSnapshotContext({
      snapshot: {
        timestamp: 1_712_000_000,
        snapshot_version: "planner-snapshot-offline",
        bot: {
          position: { x: 0, y: 64, z: 0 },
          world_key: "minecraft:overworld",
          health: 20,
          food: 20,
          experience: 0,
          is_on_fire: false,
          is_in_water: false,
          y_velocity: 0,
        },
        inventory: { items: [], total_items: 0, occupied_slots: 0, free_slots: 36 },
        equipment: {
          head: null,
          chest: null,
          legs: null,
          feet: null,
          main_hand: null,
          off_hand: null,
          has_weapon_equipped: false,
        },
        nearby_blocks: [],
        nearby_entities: [],
        owner: {
          name: "Steve",
          online: false,
          position: { x: 0, y: 64, z: 0 },
        },
      },
    });

    expect(context).toContain("[主人] 离线");
    expect(context).not.toContain("距离:");
  });

  it("应把真实 observation（观测） 快照压缩为 Chat（闲聊） 七类行上下文", () => {
    const context = createChatSnapshotContext({
      snapshot: {
        timestamp: 1_712_000_000,
        snapshot_version: "chat-snapshot-1",
        bot: {
          position: { x: 10, y: 64, z: -2 },
          world_key: "multiworld:resource",
          health: 18,
          food: 16,
          experience: 3,
          is_on_fire: false,
          is_in_water: false,
          y_velocity: 0,
        },
        inventory: {
          items: [{ slot: 0, item_name: "oak_log", count: 12 }],
          total_items: 12,
          occupied_slots: 1,
          free_slots: 35,
        },
        equipment: {
          head: null,
          chest: null,
          legs: null,
          feet: null,
          main_hand: null,
          off_hand: null,
          has_weapon_equipped: false,
        },
        nearby_blocks: [],
        nearby_entities: [],
        owner: {
          name: "Steve",
          online: true,
          position: { x: 13, y: 64, z: -2 },
        },
        time: {
          phase: "day",
          time_of_day: 6000,
        },
      },
      inventoryChangeContext: "oak_log+2",
      recentContextLines: ["主人：早上好", "Bot：早上好喵~"],
    });

    expect(context).toBe(
      [
        "[Bot] 位置:(10,64,-2) 生命:18/20 饥饿:16/20 着火:否",
        "[世界] multiworld:resource",
        "[主人] 位置:(13,64,-2) 距离:3格 在线:是",
        "[背包] oak_logx12",
        "[背包变化] oak_log+2",
        "[最近上下文]",
        "主人：早上好",
        "Bot：早上好喵~",
        "[时间] 白天(6000)",
      ].join("\n"),
    );
  });

  it("主人离线时 Chat（闲聊） 快照上下文应整行降级", () => {
    const context = createChatSnapshotContext({
      snapshot: {
        timestamp: 1_712_000_000,
        snapshot_version: "chat-snapshot-offline",
        bot: {
          position: { x: 0, y: 64, z: 0 },
          world_key: "minecraft:overworld",
          health: 20,
          food: 20,
          experience: 0,
          is_on_fire: false,
          is_in_water: false,
          y_velocity: 0,
        },
        inventory: { items: [], total_items: 0, occupied_slots: 0, free_slots: 36 },
        equipment: {
          head: null,
          chest: null,
          legs: null,
          feet: null,
          main_hand: null,
          off_hand: null,
          has_weapon_equipped: false,
        },
        nearby_blocks: [],
        nearby_entities: [],
        owner: {
          name: "Steve",
          online: false,
          position: { x: 0, y: 64, z: 0 },
        },
      },
    });

    expect(context).toContain("[主人] 离线");
    expect(context).not.toContain("距离:");
    expect(context).not.toContain("在线:");
  });

  it("Chat（闲聊） 空槽位应省略背包变化整行与最近上下文整段", () => {
    const context = createChatSnapshotContext({
      snapshot: {
        timestamp: 1_712_000_000,
        snapshot_version: "chat-snapshot-empty-slots",
        bot: {
          position: { x: 0, y: 64, z: 0 },
          world_key: "minecraft:overworld",
          health: 20,
          food: 20,
          experience: 0,
          is_on_fire: false,
          is_in_water: false,
          y_velocity: 0,
        },
        inventory: { items: [], total_items: 0, occupied_slots: 0, free_slots: 36 },
        equipment: {
          head: null,
          chest: null,
          legs: null,
          feet: null,
          main_hand: null,
          off_hand: null,
          has_weapon_equipped: false,
        },
        nearby_blocks: [],
        nearby_entities: [],
        time: {
          phase: "night",
          time_of_day: 13_000,
        },
      },
      inventoryChangeContext: "   ",
      recentContextLines: ["  "],
    });

    expect(context).toBe(
      [
        "[Bot] 位置:(0,64,0) 生命:20/20 饥饿:20/20 着火:否",
        "[世界] minecraft:overworld",
        "[主人] 离线",
        "[背包] 空",
        "[时间] 夜晚(13000)",
      ].join("\n"),
    );
  });

  it("单技能规划 prompt（提示词） 应由策略表生成技能段并暴露工具链能力", () => {
    const messages = createConversationPlanMessages({
      message_id: "msg-plan-template",
      message: "把地上的东西捡起来",
      snapshot_context: "online_runtime: T-046 only; executable skills: goTo, collect",
    });
    const skillSection = createConversationSkillPlanPromptSection();

    expect(Object.keys(CONVERSATION_SKILL_PLAN_TABLE)).toEqual([
      "goTo",
      "collect",
      "mine",
      "cutTree",
      "equip",
    ]);
    expect(messages[0]?.content).toContain(skillSection);
    expect(messages[0]?.content).toContain("默认以环境快照 [主人] 坐标作为 collect.params.center");
    expect(messages[0]?.content).toContain("执行层会在 32 未命中时自动扩到 64 搜索");
    expect(messages[0]?.content).toContain('await api.bot.place("crafting_table")');
    expect(messages[0]?.content).toContain("api.bot.craft(itemName, count)");
    expect(messages[0]?.content).toContain("必须读取环境快照 [主人] 位置");
    expect(messages[0]?.content).toContain("每个 ToolchainResult（工具链结果） 必须检查 ok");
    expect(messages[0]?.content).toContain("sandbox_code 最后必须调用 api.chat.report()");
    expect(messages[0]?.content).toContain("[上一轮失败] Failure Capsule（失败胶囊）");
    expect(messages[0]?.content).toContain("禁止原样重复“避免重复”里的动作");
    expect(messages[0]?.content).toContain("实现阻塞");
    expect(messages[0]?.content).toContain('"skill":"cutTree","params":{"count":12}');
    expect(messages[0]?.content).toContain(
      '"skill":"mine","params":{"blockName":"stone","count":5}',
    );
    expect(messages[0]?.content).toContain("ensureStonePickaxeEquipped()");
    expect(messages[0]?.content).toContain('api.bot.mine(\\"iron_ore\\", 1)');
    expect(messages[0]?.content).toContain("demoMineIron()");
    expect(messages[0]?.content).toContain('craft("planks", count)');
    expect(messages[0]?.content).toContain("<skill_name>");
    expect(messages[0]?.content).toContain("<param_name>");
    expect(messages[0]?.content).toContain('"blockName":"stone"');
    expect(messages[0]?.content).not.toContain('"itemName":"cobblestone"');
    expect(messages[0]?.content).toContain("这里的装备就是拿到主手");
    expect(messages[0]?.content).toContain("不能输出中文物品名");
  });

  it("应允许 mine（挖掘） / collect（捡拾） / cutTree（砍树） / equip（装备） 进入在线单技能规划结果", async () => {
    const responses = [
      '{"type":"skill_call","reply":"收到，我去挖石头","skill":"mine","params":{"blockName":"stone","count":2}}',
      '{"type":"skill_call","reply":"收到，我去捡圆石","skill":"collect","params":{"itemName":"cobblestone","radius":32}}',
      '{"type":"skill_call","reply":"收到，我去捡附近掉落物","skill":"collect","params":{}}',
      '{"type":"skill_call","reply":"收到，我去捡附近掉落物","skill":"collect","params":{"itemName":"item","center":{"x":1,"y":64,"z":2},"radius":32}}',
      '{"type":"skill_call","reply":"收到，我去砍 12 块木头","skill":"cutTree","params":{"count":12}}',
      '{"type":"sandbox_code","reply":"收到，我来放一个工作台","code":"const placed = await api.bot.place(\\"crafting_table\\"); if (!placed.ok) { await api.chat.report(`放置工作台失败: ${placed.error.code}喵~`); throw new Error(placed.error.code); } await api.chat.report(\\"工作台已放好喵~\\");"}',
      '{"type":"sandbox_code","reply":"收到，我来你这里放工作台","code":"await api.bot.goTo(8,64,2); const placed = await api.bot.place(\\"crafting_table\\", {x:8,y:64,z:2}); if (!placed.ok) { await api.chat.report(`放置工作台失败: ${placed.error.code}喵~`); throw new Error(placed.error.code); } await api.chat.report(\\"工作台已放好喵~\\");"}',
      '{"type":"sandbox_code","reply":"收到，我先做木镐再挖石头","code":"const pickaxe = await api.bot.ensureWoodenPickaxeEquipped(); if (!pickaxe.ok) { await api.chat.report(`做木镐失败: ${pickaxe.error.code}喵~`); throw new Error(pickaxe.error.code); } const mined = await api.bot.mine(\\"stone\\", 5); if (!mined.ok) { await api.chat.report(`挖石头失败: ${mined.error.code}喵~`); throw new Error(mined.error.code); } await api.chat.report(\\"挖石头完成喵~\\");"}',
      '{"type":"skill_call","reply":"收到，我先把稿子拿在手上","skill":"equip","params":{"itemName":"stone_pickaxe","destination":"hand"}}',
      '{"type":"skill_call","reply":"收到，我把面包装备到主手","skill":"equip","params":{"itemName":"bread"}}',
    ];
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
                    content: responses.shift(),
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
      client.generateSkillPlan({
        message_id: "msg-plan-mine",
        message: "去挖两块石头",
        snapshot_context: "online_runtime: T-046 only; executable skills: goTo, collect",
      }),
    ).resolves.toMatchObject({
      type: "skill_call",
      skill: "mine",
      params: {
        blockName: "stone",
        count: 2,
      },
    });
    await expect(
      client.generateSkillPlan({
        message_id: "msg-plan-collect",
        message: "把地上的圆石捡起来",
        snapshot_context: "online_runtime: T-046 only; executable skills: goTo, collect",
      }),
    ).resolves.toMatchObject({
      skill: "collect",
      params: {
        itemName: "cobblestone",
        radius: 32,
      },
    });
    await expect(
      client.generateSkillPlan({
        message_id: "msg-plan-collect-generic",
        message: "把这个东西捡起来",
        snapshot_context:
          "online_runtime: T-046 only; executable skills: goTo, collect\n[附近掉落物] Item(item,1格)",
      }),
    ).resolves.toMatchObject({
      skill: "collect",
      params: {},
    });
    const placeholderNamePlan = await client.generateSkillPlan({
      message_id: "msg-plan-collect-placeholder-name",
      message: "把这个东西捡起来",
      snapshot_context:
        "online_runtime: T-046 only; executable skills: goTo, collect\n[主人] 位置:(1,64,2) 距离:3格 在线:是\n[附近掉落物] Item(item,1格)",
    });
    if (placeholderNamePlan.type !== "skill_call") {
      throw new Error("expected collect skill plan");
    }
    expect(placeholderNamePlan).toMatchObject({
      skill: "collect",
      params: {
        center: { x: 1, y: 64, z: 2 },
        radius: 32,
      },
    });
    expect(placeholderNamePlan.params).not.toHaveProperty("itemName");
    await expect(
      client.generateSkillPlan({
        message_id: "msg-plan-cut-tree",
        message: "砍 12 块木头",
        snapshot_context:
          "online_runtime: executable skills: goTo, collect, cutTree\nresources: tree found",
      }),
    ).resolves.toMatchObject({
      skill: "cutTree",
      params: {
        count: 12,
      },
    });
    await expect(
      client.generateSkillPlan({
        message_id: "msg-plan-place-table",
        message: "放置一个工作台",
        snapshot_context: "online_runtime: executable skills: goTo, collect, cutTree, place",
      }),
    ).resolves.toMatchObject({
      type: "sandbox_code",
      code: expect.stringContaining("api.chat.report"),
    });
    await expect(
      client.generateSkillPlan({
        message_id: "msg-plan-place-table-owner",
        message: "在我这放置一个工作台",
        snapshot_context:
          "online_runtime: executable skills: goTo, collect, cutTree, place\n[主人] 位置:(8,64,2) 距离:6格 在线:是",
      }),
    ).resolves.toMatchObject({
      type: "sandbox_code",
      code: expect.stringContaining("api.bot.goTo(8,64,2)"),
    });
    await expect(
      client.generateSkillPlan({
        message_id: "msg-plan-craft-pickaxe-then-mine",
        message: "找工作台做一个木镐,然后去挖石头",
        snapshot_context:
          "online_runtime: executable skills: goTo, collect, cutTree, equip, mine, place; sandbox toolchain: craft, place(crafting_table)\n[背包] oak_log x38",
      }),
    ).resolves.toMatchObject({
      type: "sandbox_code",
      code: expect.stringContaining("ensureWoodenPickaxeEquipped"),
    });
    await expect(
      client.generateSkillPlan({
        message_id: "msg-plan-equip",
        message: "把石镐拿在手上",
        snapshot_context: "online_runtime: executable skills: goTo, collect, cutTree, equip, place",
      }),
    ).resolves.toMatchObject({
      type: "skill_call",
      skill: "equip",
      params: {
        itemName: "stone_pickaxe",
        destination: "hand",
      },
    });
    await expect(
      client.generateSkillPlan({
        message_id: "msg-plan-equip-bread",
        message: "装备面包",
        snapshot_context:
          "online_runtime: executable skills: goTo, collect, cutTree, equip\n[背包] bread x1, oak_log x38",
      }),
    ).resolves.toMatchObject({
      type: "skill_call",
      skill: "equip",
      params: {
        itemName: "bread",
      },
    });
  });

  it("应拒绝 sandbox_code（沙箱代码） 缺少最终 report（汇报） 或调用隐藏 demo（演示）", async () => {
    const responses = [
      '{"type":"sandbox_code","reply":"收到","code":"await api.bot.ensureStonePickaxeEquipped()"}',
      '{"type":"sandbox_code","reply":"收到","code":"await demoMineIron(); await api.chat.report(\\"完成喵~\\")"}',
    ];
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
                    content: responses.shift(),
                  },
                },
              ],
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          ),
      },
    );

    await expect(
      client.generateSkillPlan({
        message_id: "msg-plan-sandbox-missing-report",
        message: "做一把石镐",
        snapshot_context: "online_runtime: executable skills: mine, cutTree, equip",
      }),
    ).rejects.toMatchObject({
      message: "planner sandbox code must call api.chat.report",
    });

    await expect(
      client.generateSkillPlan({
        message_id: "msg-plan-sandbox-demo",
        message: "去挖铁",
        snapshot_context: "online_runtime: executable skills: mine, cutTree, equip",
      }),
    ).rejects.toMatchObject({
      message: "planner sandbox code must not call demoMineIron",
    });
  });

  it("应把 cannot_plan（无法规划） 的 skill_not_enabled（技能未启用） 原因保留为门禁错误", async () => {
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
                      '{"type":"cannot_plan","reason":"skill_not_enabled","code":"skill_not_enabled"}',
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
      client.generateSkillPlan({
        message_id: "msg-plan-disabled-cannot-plan",
        message: "去挖两块石头",
        snapshot_context: "online_runtime: T-046 only; executable skills: goTo, collect",
      }),
    ).rejects.toBeInstanceOf(ConversationLlmSkillNotEnabledError);
  });

  it("应把 cannot_plan（无法规划） 的 conversation_fact（对话事实） 作为普通规划失败", async () => {
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
                      '{"type":"cannot_plan","reason":"conversation_fact","code":"conversation_fact"}',
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
      client.generateSkillPlan({
        message_id: "msg-plan-location-fact",
        message: "记住这里为峡谷之巅",
        snapshot_context: "[主人] 位置:(7.7,118,-35.6) 距离:41.5格 在线:是",
      }),
    ).rejects.toBeInstanceOf(ConversationLlmPlanError);
  });

  it("应在单技能规划返回非法载荷时抛出显式错误", async () => {
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
                      '{"type":"skill_call","reply":"收到","skill":"cutTree","params":{"count":"一棵"}}',
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
      client.generateSkillPlan({
        message_id: "msg-plan-invalid",
        message: "帮我走过去",
        snapshot_context: "online_runtime: T-046 only; executable skills: goTo, collect",
      }),
    ).rejects.toBeInstanceOf(ConversationLlmPlanError);
  });
});
