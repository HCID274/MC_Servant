import { assertNonEmptyString } from "../../domain/invariants.js";
import type {
  ConversationLlmChatInput,
  ConversationLlmConfig,
  ConversationLlmMessage,
  ConversationLlmPlanInput,
  ConversationLlmTriageInput,
} from "./types.js";

export function createConversationChatMessages(
  input: ConversationLlmChatInput & Pick<ConversationLlmConfig, "bot_name" | "owner_name">,
): readonly ConversationLlmMessage[] {
  assertNonEmptyString(input.message_id, "message_id");
  assertNonEmptyString(input.message, "message");

  const botName = input.bot_name.trim();
  const ownerName = input.owner_name.trim();
  const historyMessages =
    input.history?.flatMap<ConversationLlmMessage>((turn) => {
      const role = turn.role === "bot" ? "assistant" : "user";
      const content =
        turn.role === "bot" ? `[${botName}] ${turn.content}` : `[${ownerName}] ${turn.content}`;

      return Object.freeze([
        Object.freeze({
          role,
          content,
        }),
      ]);
    }) ?? [];

  const systemSections = [
    `你是 ${botName}，一个在 Minecraft 中的贴心猫娘女仆。你的主人是 ${ownerName}。`,
    "绝对规则：",
    "- 每句回复结尾必须加“喵”或“喵~”",
    "- 回复简短自然，不超过 3 句话",
    "- 不要输出 JSON，不要输出动作计划，只说话",
    ...(input.memory_context === undefined ? [] : [`记忆摘要：${input.memory_context}`]),
  ];

  return Object.freeze([
    Object.freeze({
      role: "system",
      content: systemSections.join("\n"),
    }),
    ...historyMessages,
    Object.freeze({
      role: "user",
      content: `[${ownerName}] ${input.message}`,
    }),
  ]);
}

/** 组装 Stage 1-Triage（分诊） 的最小消息列表。 */
export function createConversationTriageMessages(
  input: ConversationLlmTriageInput,
): readonly ConversationLlmMessage[] {
  assertNonEmptyString(input.message_id, "message_id");
  assertNonEmptyString(input.message, "message");

  const historyLines =
    input.history?.map((turn) =>
      turn.role === "bot" ? `[Bot] ${turn.content}` : `[主人] ${turn.content}`,
    ) ?? [];

  return Object.freeze([
    Object.freeze({
      role: "system",
      content: [
        "你是一个消息分类器。根据用户消息和上下文，判断用户的意图类别和紧迫度。",
        "当前在线最小闭环只允许输出 chat、task、cancel 三类意图，不要输出 modify。",
        "只输出 JSON，不要输出其他内容。",
        "意图分类规则：",
        "- chat：闲聊、问候、问问题、情感表达、与 Minecraft 游戏操作无关的对话",
        "- task：要求 Bot 执行游戏内动作（采集、移动、制造、跟随等）",
        "- cancel：要求停止当前任务（只有明确指向当前动作的停止指令）",
        "紧迫度规则：",
        "- interrupt：必须立刻中止当前动作",
        "- urgent：尽快执行，插队",
        "- normal：正常排队",
        "- background：低优先级",
        '输出格式：{"intent":"chat|task|cancel","priority":"interrupt|urgent|normal|background","reason":"一句话说明判断依据"}',
      ].join("\n"),
    }),
    Object.freeze({
      role: "user",
      content: [
        `Bot 状态：${input.bot_summary?.trim() || "idle"}`,
        "---",
        ...(historyLines.length > 0 ? historyLines : ["[无最近对话]"]),
        "---",
        `[主人] ${input.message}`,
      ].join("\n"),
    }),
  ]);
}

/** 组装最小单技能 `skill_call`（技能调用） 规划消息列表。 */
export function createConversationPlanMessages(
  input: ConversationLlmPlanInput,
): readonly ConversationLlmMessage[] {
  assertNonEmptyString(input.message_id, "message_id");
  assertNonEmptyString(input.message, "message");
  assertNonEmptyString(input.snapshot_context, "snapshot_context");

  return Object.freeze([
    Object.freeze({
      role: "system",
      content: [
        "你是一个 Minecraft 任务规划器。",
        "当前阶段只能输出单个 skill_call。",
        "允许的 skill 只有：goTo、mine、collect、equip。",
        "如果是去某个坐标，请输出 JSON：",
        '{"type":"skill_call","reply":"一句简短确认回复","skill":"goTo","params":{"x":10,"y":64,"z":-5}}',
        "如果是挖某种方块 N 个，请输出 JSON：",
        '{"type":"skill_call","reply":"一句简短确认回复","skill":"mine","params":{"blockName":"stone","count":3}}',
        "如果是捡某种掉落物，请输出 JSON：",
        '{"type":"skill_call","reply":"一句简短确认回复","skill":"collect","params":{"itemName":"cobblestone","radius":8}}',
        "如果是把某物装备到手上或指定槽位，请输出 JSON：",
        '{"type":"skill_call","reply":"一句简短确认回复","skill":"equip","params":{"itemName":"stone_pickaxe","destination":"hand"}}',
        "如果不能明确判断为 goTo、mine、collect、equip 其中一种，或参数不完整 / 不合法，输出 JSON：",
        '{"type":"cannot_plan","reason":"一句话说明为什么无法规划"}',
        "绝对规则：",
        "- 只能输出 JSON，不要解释",
        "- 不要输出 sandbox_code",
        "- 不要输出除 goTo、mine、collect、equip 之外的 skill",
        "- goTo.params.x / y / z 必须是数字",
        "- mine.params.blockName 必须是非空字符串，count 必须是正整数",
        "- collect.params.itemName 必须是非空字符串，radius 若提供必须是正整数",
        "- equip.params.itemName 必须是非空字符串，destination 若提供只能是 hand、off-hand、head、torso、legs、feet",
      ].join("\n"),
    }),
    Object.freeze({
      role: "user",
      content: [
        `环境快照：${input.snapshot_context}`,
        ...(input.triage_reason === undefined ? [] : [`分诊理由：${input.triage_reason}`]),
        ...(input.task_history_context === undefined
          ? []
          : [`任务历史：${input.task_history_context}`]),
        ...(input.memory_context === undefined ? [] : [`记忆摘要：${input.memory_context}`]),
        ...(input.interrupted_task === undefined
          ? []
          : [
              `被中断任务：message_id=${input.interrupted_task.message_id}; summary=${input.interrupted_task.intent_summary}${input.interrupted_task.last_step === undefined ? "" : `; last_step=${input.interrupted_task.last_step}`}`,
            ]),
        `主人的指令：${input.message}`,
      ].join("\n"),
    }),
  ]);
}
