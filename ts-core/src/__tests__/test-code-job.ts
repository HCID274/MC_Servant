import type { SkillName, SkillParamsByName } from "../core-ports/skills.js";
import { type CodeJob, type ExecPriority, createCodeJob } from "../core-ports/tasking.js";

export function createCodeJobForSkill<TName extends SkillName>(input: {
  readonly message_id: string;
  readonly intent_epoch: number;
  readonly snapshot_ts: number;
  readonly priority: ExecPriority;
  readonly skill: TName;
  readonly params: Readonly<SkillParamsByName[TName]>;
}): CodeJob {
  return createCodeJob({
    message_id: input.message_id,
    intent_epoch: input.intent_epoch,
    snapshot_ts: input.snapshot_ts,
    priority: input.priority,
    code: renderSkillInvocationCode(input.skill, input.params),
  });
}

function renderSkillInvocationCode<TName extends SkillName>(
  skill: TName,
  params: Readonly<SkillParamsByName[TName]>,
): string {
  switch (skill) {
    case "goTo": {
      const typed = params as Readonly<SkillParamsByName["goTo"]>;
      return `await goTo(${typed.x}, ${typed.y}, ${typed.z});`;
    }
    case "mine": {
      const typed = params as Readonly<SkillParamsByName["mine"]>;
      return `await mine(${JSON.stringify(typed.blockName)}, ${typed.count});`;
    }
    case "cutTree": {
      const typed = params as Readonly<SkillParamsByName["cutTree"]>;
      return `await cutTree(${typed.count});`;
    }
    case "collect": {
      const typed = params as Readonly<SkillParamsByName["collect"]>;
      const item = typed.itemName === undefined ? "undefined" : JSON.stringify(typed.itemName);
      return `await collect(${item}, ${typed.radius ?? 32});`;
    }
    case "equip": {
      const typed = params as Readonly<SkillParamsByName["equip"]>;
      const destination =
        typed.destination === undefined ? "" : `, ${JSON.stringify(typed.destination)}`;
      return `await equip(${JSON.stringify(typed.itemName)}${destination});`;
    }
  }
}
