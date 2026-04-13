import { PHASE1_SKILL_DEFINITIONS } from "../skills/index.js";
import {
  SANDBOX_BOT_METHOD_NAMES,
  SANDBOX_CHAT_METHOD_NAMES,
  SANDBOX_KNOWLEDGE_METHOD_NAMES,
  SANDBOX_MEMORY_METHOD_NAMES,
  SANDBOX_OWNER_VALUE_NAMES,
  SANDBOX_TASK_VALUE_NAMES,
  SANDBOX_WORLD_METHOD_NAMES,
  type SandboxBotMethodName,
  type SandboxBotSkillBindings,
  type SandboxFacadeContract,
  type SandboxMethodContract,
  type SandboxValueContract,
} from "./contracts.js";

function createMethodContract<TName extends string>(input: {
  name: TName;
  access: "read" | "write";
  parameterKeys: readonly string[];
  emitsStep: boolean;
  alignedSkill?: SandboxBotMethodName;
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

/** `bot`（动作） 分区与 Phase 1（第一阶段） 技能目录的精确绑定表。 */
export const SANDBOX_BOT_SKILL_BINDINGS = Object.freeze({
  goTo: "goTo",
  mine: "mine",
  cutTree: "cutTree",
  collect: "collect",
  equip: "equip",
} as const satisfies SandboxBotSkillBindings);

/** 创建 Facade API（门面接口） 的最小顶层契约描述。 */
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
