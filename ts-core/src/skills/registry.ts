/**
 * 技能注册表实现。
 *
 * 1. 技能容器：提供 SkillRegistry 接口及其实现，用于管理 Bot 可用的技能集合。
 * 2. 纯函数演进：通过 registerSkillDefinition 以纯函数方式演进注册表，每次更新均返回新的只读快照。
 * 3. 技能发现：提供列表（list）和查询（get/has）方法，支撑运行时对技能定义和校验逻辑的检索。
 * 4. 预设集成：提供 `createPhase1SkillRegistry` 快速构建包含五个核心技能的初始注册表。
 */

import {
  PHASE1_SKILL_DEFINITIONS,
  PHASE1_SKILL_NAMES,
  type SkillDefinition,
  type SkillName,
} from "./contracts.js";
/** 内部技能定义映射表类型。 */

type SkillDefinitionMap = Partial<Record<SkillName, SkillDefinition>>;

/** 技能注册表的只读快照结构。 */
export interface SkillRegistry {
  /** 已注册技能定义映射。 */
  readonly definitions: Readonly<SkillDefinitionMap>;
}

/**
 * 创建技能注册表。
 *
 * 1. 结构化索引：将输入的技能定义数组转化为按技能名索引的映射表。
 * 2. 状态冻结：产出不可变的只读快照，为运行时的技能检索提供稳定的数据底座。
 *
 * @param definitions 初始技能定义数组
 * @returns 只读的技能注册表快照
 */
export function createSkillRegistry(definitions: readonly SkillDefinition[] = []): SkillRegistry {
  const nextDefinitions: SkillDefinitionMap = {};

  for (const definition of definitions) {
    nextDefinitions[definition.name] = definition;
  }

  return Object.freeze({
    definitions: Object.freeze({ ...nextDefinitions }),
  });
}

/**
 * 在注册表上追加或覆盖一个技能定义。
 *
 * 纯函数演进：遵循不可变数据模式，通过组合旧定义与新定义产出全新的注册表实例，确保演进过程无副作用。
 *
 * @param registry 原注册表
 * @param definition 待注册的技能定义
 * @returns 演进后的新注册表
 */
export function registerSkillDefinition<TName extends SkillName>(
  registry: SkillRegistry,
  definition: SkillDefinition<TName>,
): SkillRegistry {
  return createSkillRegistry([
    ...listSkillDefinitions(registry).filter((item) => item.name !== definition.name),
    definition,
  ]);
}

/** 按技能名读取注册表中的技能定义。 */
export function getSkillDefinition<TName extends SkillName>(
  registry: SkillRegistry,
  name: TName,
): SkillDefinition<TName> | undefined {
  return registry.definitions[name] as SkillDefinition<TName> | undefined;
}

/** 判断技能名是否已在注册表中注册。 */
export function hasSkillDefinition(registry: SkillRegistry, name: SkillName): boolean {
  return getSkillDefinition(registry, name) !== undefined;
}

/**
 * 列出当前注册表中的所有技能定义。
 *
 * 确定性顺序：强制按系统约定的固定顺序（如 Phase 1 清单顺序）输出技能，确保下游消费方看到的能力列表具有确定性。
 *
 * @param registry 技能注册表
 * @returns 排序后的技能定义数组
 */
export function listSkillDefinitions(registry: SkillRegistry): readonly SkillDefinition[] {
  const definitions = PHASE1_SKILL_NAMES.flatMap((name) => {
    const definition = getSkillDefinition(registry, name);
    return definition === undefined ? [] : [definition];
  });

  return Object.freeze(definitions);
}

/** 创建内置 Phase 1 技能的初始注册表。 */
export function createPhase1SkillRegistry(): SkillRegistry {
  return createSkillRegistry(PHASE1_SKILL_DEFINITIONS);
}
