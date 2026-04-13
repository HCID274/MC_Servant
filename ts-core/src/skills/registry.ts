import {
  PHASE1_SKILL_DEFINITIONS,
  PHASE1_SKILL_NAMES,
  type SkillDefinition,
  type SkillName,
} from "./contracts.js";

type SkillDefinitionMap = Partial<Record<SkillName, SkillDefinition>>;

/** 技能注册表的只读快照结构。 */
export interface SkillRegistry {
  /** 已注册技能定义映射。 */
  readonly definitions: Readonly<SkillDefinitionMap>;
}

/** 创建空的或带初始定义的技能注册表。 */
export function createSkillRegistry(definitions: readonly SkillDefinition[] = []): SkillRegistry {
  const nextDefinitions: SkillDefinitionMap = {};

  for (const definition of definitions) {
    nextDefinitions[definition.name] = definition;
  }

  return Object.freeze({
    definitions: Object.freeze({ ...nextDefinitions }),
  });
}

/** 在注册表上追加或覆盖一个技能定义，并返回新的只读快照。 */
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

/** 以 Phase 1（第一阶段） 固定顺序列出当前已注册技能。 */
export function listSkillDefinitions(registry: SkillRegistry): readonly SkillDefinition[] {
  const definitions = PHASE1_SKILL_NAMES.flatMap((name) => {
    const definition = getSkillDefinition(registry, name);
    return definition === undefined ? [] : [definition];
  });

  return Object.freeze(definitions);
}

/** 创建内置五个 Phase 1（第一阶段） 技能的注册表。 */
export function createPhase1SkillRegistry(): SkillRegistry {
  return createSkillRegistry(PHASE1_SKILL_DEFINITIONS);
}
