import type { SkillName, SkillParamsByName } from "../skill-catalog.js";

/** 旧单技能调用结构；仅用于历史回放、迁移测试或负向测试。 */
export interface LegacySkillCall<TName extends SkillName = SkillName> {
  readonly skill: TName;
  readonly params: Readonly<SkillParamsByName[TName]>;
}

/** 旧单技能调用判别联合；在线执行主路径不得继续消费该结构。 */
export type LegacySkillCallInput = {
  [TName in SkillName]: LegacySkillCall<TName>;
}[SkillName];

function freezePlainObject<TValue extends object>(value: TValue): Readonly<TValue> {
  return Object.freeze({ ...value });
}

/** 创建旧单技能调用夹具；只允许 legacy/test-only 路径使用。 */
export function createLegacySkillCall<TInput extends LegacySkillCallInput>(input: TInput): TInput {
  return Object.freeze({
    skill: input.skill,
    params: freezePlainObject(input.params),
  }) as TInput;
}
