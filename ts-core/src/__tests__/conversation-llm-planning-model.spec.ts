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
    expect(messages[0]?.content).toContain('纯闲聊只输出 reply 空对象，例如 {"reply":{}}。');
    expect(messages[0]?.content).not.toContain('"content":"我在喵~"');
    expect(messages[0]?.content).not.toContain("reply 只写自然短句");
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
                      '{"cancel":{"reason":"主人要求先停下","priority":"interrupt"},"reply":{},"action":{"intent":"task","priority":"urgent","reason":"主人要求去坐标"}}',
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
      reply: {},
      action: {
        intent: "task",
        priority: "urgent",
        reason: "主人要求去坐标",
      },
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
    expect(messages[0]?.content).toContain("reply");
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
  });

  it("单技能规划 prompt（提示词） 不应再把“三个坐标”写成通用失败条件", () => {
    const messages = createConversationPlanMessages({
      message_id: "msg-plan-prompt",
      message: "把地上的圆石捡起来",
      snapshot_context: "online_runtime: T-046 only; executable skills: goTo, collect",
    });

    expect(messages[0]?.content).toContain("如果不能明确判断为允许技能中的一种");
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

  it("单技能规划 prompt（提示词） 应由策略表生成技能段且不写死 MC（Minecraft） 示例物品", () => {
    const messages = createConversationPlanMessages({
      message_id: "msg-plan-template",
      message: "把地上的东西捡起来",
      snapshot_context: "online_runtime: T-046 only; executable skills: goTo, collect",
    });
    const skillSection = createConversationSkillPlanPromptSection();

    expect(Object.keys(CONVERSATION_SKILL_PLAN_TABLE)).toEqual(["goTo", "collect"]);
    expect(messages[0]?.content).toContain(skillSection);
    expect(messages[0]?.content).toContain("默认以环境快照 [主人] 坐标作为 collect.params.center");
    expect(messages[0]?.content).toContain("执行层会在 32 未命中时自动扩到 64 搜索");
    expect(messages[0]?.content).toContain("<skill_name>");
    expect(messages[0]?.content).toContain("<param_name>");
    expect(messages[0]?.content).not.toContain('"blockName":"stone"');
    expect(messages[0]?.content).not.toContain('"itemName":"cobblestone"');
    expect(messages[0]?.content).not.toContain('"itemName":"stone_pickaxe"');
  });

  it("应允许 collect（捡拾） 并拒绝 mine（挖掘） / equip（装备） 进入 T-046（任务四十六） 单技能规划结果", async () => {
    const responses = [
      '{"type":"skill_call","reply":"收到，我去挖石头","skill":"mine","params":{"blockName":"stone","count":2}}',
      '{"type":"skill_call","reply":"收到，我去捡圆石","skill":"collect","params":{"itemName":"cobblestone","radius":32}}',
      '{"type":"skill_call","reply":"收到，我去捡附近掉落物","skill":"collect","params":{}}',
      '{"type":"skill_call","reply":"收到，我去捡附近掉落物","skill":"collect","params":{"itemName":"item","center":{"x":1,"y":64,"z":2},"radius":32}}',
      '{"type":"skill_call","reply":"收到，我先把稿子拿在手上","skill":"equip","params":{"itemName":"stone_pickaxe","destination":"hand"}}',
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
    ).rejects.toBeInstanceOf(ConversationLlmSkillNotEnabledError);
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
        message_id: "msg-plan-equip",
        message: "把石镐拿在手上",
        snapshot_context: "online_runtime: T-046 only; executable skills: goTo, collect",
      }),
    ).rejects.toBeInstanceOf(ConversationLlmSkillNotEnabledError);
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
                      '{"type":"skill_call","reply":"收到","skill":"cutTree","params":{"count":1}}',
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
