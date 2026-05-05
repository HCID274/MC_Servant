/**
 * 沙箱门面（Facade）契约实现。
 *
 * 1. 能力映射：将系统内部的真实技能（goTo, mine 等）和观测能力映射为沙箱内部可见的方法和字段。
 * 2. 权限控制：通过 `access` 属性明确区分读操作（read）和写动作（write），为后续沙箱执行器的权限校验提供依据。
 * 3. 步骤发射配置：定义哪些方法调用应当产生“执行步骤（Step）”记录，以便在诊断日志中追踪沙箱代码的执行细节。
 * 4. 技能对齐：确保沙箱内的 `bot` 分区方法与 Phase 1 技能元数据严格对齐。
 */

import { PHASE1_SKILL_DEFINITIONS, type SkillName } from "../core-ports/skills.js";
import {
  SANDBOX_BOT_METHOD_NAMES,
  SANDBOX_CHAT_METHOD_NAMES,
  SANDBOX_FACADE_SECTIONS,
  SANDBOX_KNOWLEDGE_METHOD_NAMES,
  SANDBOX_MEMORY_METHOD_NAMES,
  SANDBOX_OWNER_VALUE_NAMES,
  SANDBOX_TASK_VALUE_NAMES,
  SANDBOX_WORLD_METHOD_NAMES,
  type SandboxBotMethodName,
  type SandboxBotSkillBindings,
  type SandboxFacadeContract,
  type SandboxFacadeSectionName,
  type SandboxMethodContract,
  type SandboxValueContract,
} from "./contracts.js";

/** Facade API（门面接口） 命名空间热队列条目。 */
export interface SandboxFacadeHotNamespaceEntry {
  /** 命名空间。 */
  readonly namespace: SandboxFacadeSectionName;
  /** 压缩签名文本。 */
  readonly description: string;
  /** 估算 token（令牌） 数。 */
  readonly token_count: number;
}

/** Facade API（门面接口） 热队列裁剪结果。 */
export interface SandboxFacadeHotNamespaceQueue {
  /** 按最近使用顺序排列的命名空间，最旧在前、最新在后。 */
  readonly entries: readonly SandboxFacadeHotNamespaceEntry[];
  /** 当前总 token（令牌） 数。 */
  readonly total_tokens: number;
  /** token（令牌） 预算。 */
  readonly budget_tokens: number;
}

/** 创建方法契约描述。 */
function createMethodContract<TName extends string>(input: {
  name: TName;
  access: "read" | "write";
  parameterKeys: readonly string[];
  emitsStep: boolean;
  alignedSkill?: SkillName;
}): SandboxMethodContract<TName> {
  return Object.freeze({
    kind: "method",
    name: input.name,
    access: input.access,
    parameter_keys: Object.freeze([...input.parameterKeys]),
    emits_step: input.emitsStep,
    ...(input.alignedSkill ? { aligned_skill: input.alignedSkill } : {}),
  });
}

/** 创建值字段契约描述。 */
function createValueContract<TName extends string>(name: TName): SandboxValueContract<TName> {
  return Object.freeze({
    kind: "value",
    name,
    access: "read",
  });
}

const phase1SkillMetadata = new Map(
  PHASE1_SKILL_DEFINITIONS.map((definition) => [definition.name, definition.metadata]),
);

const facadeNamespaceDescriptions = Object.freeze({
  bot: "bot(write): goTo(x,y,z), mine(blockName,count), collect(itemName,radius?), equip(itemName,destination?), cutTree(count), craft(itemName,count), place('crafting_table', near?)",
  chat: "chat(write): say(message), report(message); both write through BotActor controlled chat",
  world:
    "world(read): currently unavailable in minimal runtime sandbox; call describe('world') before relying on reads",
  knowledge:
    "knowledge(read): not exposed in minimal runtime sandbox; Minecraft facts must come from runtime data later",
  memory: "memory(read): not exposed in minimal runtime sandbox; task memory retrieval is reserved",
  owner:
    "owner(read): position/name/online are unavailable unless a stable observation projection is wired",
  task: "task(read): id, userMessage, intent",
} as const satisfies Record<SandboxFacadeSectionName, string>);

/** 判断给定字符串是否为 Facade API（门面接口） 命名空间。 */
function isSandboxFacadeSectionName(value: string): value is SandboxFacadeSectionName {
  return (SANDBOX_FACADE_SECTIONS as readonly string[]).includes(value);
}

/** 估算压缩描述文本的 token（令牌） 成本。 */
function estimateDescriptionTokens(description: string): number {
  return Math.max(1, Math.ceil(description.length / 4));
}

/** 冻结 Facade API（门面接口） 热队列结果。 */
function freezeHotNamespaceQueue(input: {
  entries: readonly SandboxFacadeHotNamespaceEntry[];
  budgetTokens: number;
}): SandboxFacadeHotNamespaceQueue {
  const entries = Object.freeze(
    input.entries.map((entry) =>
      Object.freeze({
        namespace: entry.namespace,
        description: entry.description,
        token_count: entry.token_count,
      }),
    ),
  );

  return Object.freeze({
    entries,
    total_tokens: entries.reduce((total, entry) => total + entry.token_count, 0),
    budget_tokens: input.budgetTokens,
  });
}

/** `bot`（动作） 分区与 Phase 1（第一阶段） 技能目录的精确绑定表。 */
export const SANDBOX_BOT_SKILL_BINDINGS = Object.freeze({
  goTo: "goTo",
  mine: "mine",
  cutTree: "cutTree",
  collect: "collect",
  equip: "equip",
} as const satisfies SandboxBotSkillBindings);

/**
 * 创建 Facade API 的最小顶层契约描述。
 *
 * 1. 能力说明书：构建沙箱环境可用的 API 目录，涵盖动作（bot）、世界（world）、知识（knowledge）等多个分区。
 * 2. 指令对齐：明确每个 API 的访问模式（读/写）和参数契约，用于指导沙箱执行器的运行时注入。
 *
 * @returns 不可变的沙箱门面契约
 */
export function createSandboxFacadeContract(): SandboxFacadeContract {
  return Object.freeze({
    bot: Object.freeze({
      goTo: createMethodContract({
        name: "goTo",
        access: "write",
        parameterKeys: phase1SkillMetadata.get("goTo")?.parameterKeys ?? [],
        emitsStep: true,
        alignedSkill: SANDBOX_BOT_SKILL_BINDINGS.goTo,
      }),
      mine: createMethodContract({
        name: "mine",
        access: "write",
        parameterKeys: phase1SkillMetadata.get("mine")?.parameterKeys ?? [],
        emitsStep: true,
        alignedSkill: SANDBOX_BOT_SKILL_BINDINGS.mine,
      }),
      cutTree: createMethodContract({
        name: "cutTree",
        access: "write",
        parameterKeys: phase1SkillMetadata.get("cutTree")?.parameterKeys ?? [],
        emitsStep: true,
        alignedSkill: SANDBOX_BOT_SKILL_BINDINGS.cutTree,
      }),
      collect: createMethodContract({
        name: "collect",
        access: "write",
        parameterKeys: phase1SkillMetadata.get("collect")?.parameterKeys ?? [],
        emitsStep: true,
        alignedSkill: SANDBOX_BOT_SKILL_BINDINGS.collect,
      }),
      equip: createMethodContract({
        name: "equip",
        access: "write",
        parameterKeys: phase1SkillMetadata.get("equip")?.parameterKeys ?? [],
        emitsStep: true,
        alignedSkill: SANDBOX_BOT_SKILL_BINDINGS.equip,
      }),
      craft: createMethodContract({
        name: "craft",
        access: "write",
        parameterKeys: ["itemName", "count"],
        emitsStep: true,
      }),
      place: createMethodContract({
        name: "place",
        access: "write",
        parameterKeys: ["blockName", "near"],
        emitsStep: true,
      }),
    }),
    world: Object.freeze({
      nearestBlocks: createMethodContract({
        name: SANDBOX_WORLD_METHOD_NAMES[0],
        access: "read",
        parameterKeys: ["blockName", "radius", "maxCount"],
        emitsStep: false,
      }),
      nearestEntities: createMethodContract({
        name: SANDBOX_WORLD_METHOD_NAMES[1],
        access: "read",
        parameterKeys: ["filter", "radius"],
        emitsStep: false,
      }),
      blockAt: createMethodContract({
        name: SANDBOX_WORLD_METHOD_NAMES[2],
        access: "read",
        parameterKeys: ["x", "y", "z"],
        emitsStep: false,
      }),
      getTime: createMethodContract({
        name: SANDBOX_WORLD_METHOD_NAMES[3],
        access: "read",
        parameterKeys: [],
        emitsStep: false,
      }),
      getBiome: createMethodContract({
        name: SANDBOX_WORLD_METHOD_NAMES[4],
        access: "read",
        parameterKeys: [],
        emitsStep: false,
      }),
    }),
    knowledge: Object.freeze({
      getRecipe: createMethodContract({
        name: SANDBOX_KNOWLEDGE_METHOD_NAMES[0],
        access: "read",
        parameterKeys: ["itemName"],
        emitsStep: false,
      }),
      getBlockInfo: createMethodContract({
        name: SANDBOX_KNOWLEDGE_METHOD_NAMES[1],
        access: "read",
        parameterKeys: ["blockName"],
        emitsStep: false,
      }),
      getItemInfo: createMethodContract({
        name: SANDBOX_KNOWLEDGE_METHOD_NAMES[2],
        access: "read",
        parameterKeys: ["itemName"],
        emitsStep: false,
      }),
      getEntityInfo: createMethodContract({
        name: SANDBOX_KNOWLEDGE_METHOD_NAMES[3],
        access: "read",
        parameterKeys: ["entityName"],
        emitsStep: false,
      }),
      getSmeltingRecipe: createMethodContract({
        name: SANDBOX_KNOWLEDGE_METHOD_NAMES[4],
        access: "read",
        parameterKeys: ["itemName"],
        emitsStep: false,
      }),
    }),
    memory: Object.freeze({
      search: createMethodContract({
        name: SANDBOX_MEMORY_METHOD_NAMES[0],
        access: "read",
        parameterKeys: ["query", "limit"],
        emitsStep: false,
      }),
      recentTasks: createMethodContract({
        name: SANDBOX_MEMORY_METHOD_NAMES[1],
        access: "read",
        parameterKeys: ["limit"],
        emitsStep: false,
      }),
    }),
    chat: Object.freeze({
      say: createMethodContract({
        name: SANDBOX_CHAT_METHOD_NAMES[0],
        access: "write",
        parameterKeys: ["message"],
        emitsStep: true,
      }),
      report: createMethodContract({
        name: SANDBOX_CHAT_METHOD_NAMES[1],
        access: "write",
        parameterKeys: ["message"],
        emitsStep: true,
      }),
    }),
    owner: Object.freeze({
      position: createValueContract(SANDBOX_OWNER_VALUE_NAMES[0]),
      name: createValueContract(SANDBOX_OWNER_VALUE_NAMES[1]),
      online: createValueContract(SANDBOX_OWNER_VALUE_NAMES[2]),
    }),
    task: Object.freeze({
      id: createValueContract(SANDBOX_TASK_VALUE_NAMES[0]),
      userMessage: createValueContract(SANDBOX_TASK_VALUE_NAMES[1]),
      intent: createValueContract(SANDBOX_TASK_VALUE_NAMES[2]),
    }),
  });
}

/**
 * 创建 Facade API（门面接口） 渐进披露初始索引。
 *
 * 初始 prompt（提示词） 只暴露命名空间入口和 describe(namespace) 机制，避免一次性注入全量手册。
 *
 * @returns 压缩后的 Facade API 入口说明
 */
export function createSandboxFacadePromptIndex(): string {
  return [
    `Facade namespaces: ${SANDBOX_FACADE_SECTIONS.join(", ")}`,
    "Use describe(namespace) to request one namespace signature before calling methods.",
  ].join("\n");
}

/**
 * 按命名空间描述 Facade API（门面接口） 压缩签名。
 *
 * @param namespace 目标命名空间
 * @returns 可放入 prompt（提示词） 的压缩签名文本
 */
export function describeFacadeNamespace(namespace: SandboxFacadeSectionName): string {
  return facadeNamespaceDescriptions[namespace];
}

/**
 * 更新 Facade API（门面接口） 命名空间 LRU（最近最少使用） 热队列。
 *
 * 重复访问会刷新热度；裁剪按估算 token（令牌） 预算进行，而不是按条目数量。
 *
 * @param input 当前队列、访问命名空间和预算
 * @returns 经过预算裁剪的热队列
 */
export function updateSandboxFacadeHotNamespaceQueue(input: {
  queue?: SandboxFacadeHotNamespaceQueue;
  namespace: SandboxFacadeSectionName;
  budget_tokens: number;
}): SandboxFacadeHotNamespaceQueue {
  if (!Number.isInteger(input.budget_tokens) || input.budget_tokens <= 0) {
    throw new Error("budget_tokens must be a positive integer");
  }

  if (!isSandboxFacadeSectionName(input.namespace)) {
    throw new Error(`Unsupported facade namespace: ${input.namespace}`);
  }

  const existingEntries = input.queue?.entries ?? [];
  const description = describeFacadeNamespace(input.namespace);
  const nextEntry = Object.freeze({
    namespace: input.namespace,
    description,
    token_count: estimateDescriptionTokens(description),
  });
  const nextEntries = [
    ...existingEntries.filter((entry) => entry.namespace !== input.namespace),
    nextEntry,
  ];

  while (
    nextEntries.length > 0 &&
    nextEntries.reduce((total, entry) => total + entry.token_count, 0) > input.budget_tokens
  ) {
    nextEntries.shift();
  }

  return freezeHotNamespaceQueue({
    entries: nextEntries,
    budgetTokens: input.budget_tokens,
  });
}
