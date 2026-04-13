import { describe, expect, it } from "vitest";

import {
  BotStatus,
  CORE_MODULE_NAMES,
  ExecutionTaskKind,
  MessageSource,
  coreModuleBoundaries,
  createRuntimeScaffold,
} from "../index.js";

describe("TS Core 工程骨架", () => {
  it("应导出七个模块边界并与模块名清单一致", () => {
    const moduleNames = coreModuleBoundaries.map((boundary) => boundary.moduleName);

    expect(moduleNames).toEqual([...CORE_MODULE_NAMES]);
  });

  it("应保留基础状态枚举与任务类型枚举", () => {
    expect(BotStatus.IDLE).toBe("idle");
    expect(ExecutionTaskKind.SkillCall).toBe("skill_call");
    expect(MessageSource.Web).toBe("web");
  });

  it("应能创建最小运行时骨架对象", () => {
    const runtimeScaffold = createRuntimeScaffold();

    expect(runtimeScaffold.defaultStatus).toBe(BotStatus.IDLE);
    expect(runtimeScaffold.supportedTaskKinds).toContain(ExecutionTaskKind.SkillCall);
    expect(runtimeScaffold.supportedTaskKinds).not.toContain("conversation");
    expect(runtimeScaffold.interruptTemplate.source.type).toBe("system");
  });
});
