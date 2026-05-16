import { describe, expect, it } from "vitest";

import {
  SANDBOX_BOT_METHOD_NAMES,
  SANDBOX_FACADE_SECTIONS,
  SANDBOX_FORBIDDEN_DEMO_METHOD_NAMES,
  SANDBOX_READONLY_SECTIONS,
  SANDBOX_TOOLCHAIN_CAPABILITY_NAMES,
  SANDBOX_TOOLCHAIN_FAILURE_CODES,
} from "../../sandbox/contracts.js";
import {
  SANDBOX_BOT_SKILL_BINDINGS,
  createSandboxFacadeContract,
  createSandboxFacadePromptIndex,
  describeFacadeNamespace,
  updateSandboxFacadeHotNamespaceQueue,
} from "../../sandbox/legacy/index.js";

const validBindings: typeof SANDBOX_BOT_SKILL_BINDINGS = SANDBOX_BOT_SKILL_BINDINGS;
void validBindings;

// @ts-expect-error `goTo`（移动） 不能映射到 `mine`（挖掘） 技能。
const invalidGoToBinding: typeof SANDBOX_BOT_SKILL_BINDINGS.goTo = "mine";
void invalidGoToBinding;

describe("legacy/test-only sandbox Facade 夹具", () => {
  it("legacy/test-only：应让旧 Facade API 写动作覆盖已启用技能与放置工具链", () => {
    const facadeContract = createSandboxFacadeContract();

    expect(Object.keys(facadeContract)).toEqual([...SANDBOX_FACADE_SECTIONS]);
    expect(Object.keys(facadeContract.bot)).toEqual([...SANDBOX_BOT_METHOD_NAMES]);
    expect(SANDBOX_BOT_SKILL_BINDINGS.goTo).toBe("goTo");
    expect(facadeContract.bot.mine.aligned_skill).toBe("mine");
    expect(facadeContract.bot.place.aligned_skill).toBeUndefined();
    expect(facadeContract.chat.report.emits_step).toBe(true);
    expect(SANDBOX_READONLY_SECTIONS).toEqual(["world", "knowledge", "memory", "owner", "task"]);
  });

  it("legacy/test-only：应声明旧 Facade 工具链能力契约", () => {
    const facadeContract = createSandboxFacadeContract();

    expect(SANDBOX_TOOLCHAIN_CAPABILITY_NAMES).toEqual([
      "craft",
      "place",
      "equip",
      "mine",
      "ensure",
    ]);
    expect(SANDBOX_FORBIDDEN_DEMO_METHOD_NAMES).toEqual(["demoMineIron"]);
    expect(SANDBOX_TOOLCHAIN_CAPABILITY_NAMES).not.toContain("demoMineIron");
    expect(SANDBOX_TOOLCHAIN_FAILURE_CODES).toEqual(
      expect.arrayContaining(["missing_materials", "cannot_place", "unsafe_path"]),
    );
    expect(Object.keys(facadeContract.bot)).toEqual([...SANDBOX_BOT_METHOD_NAMES]);
    expect(facadeContract.bot).toHaveProperty("craft");
    expect(facadeContract.bot).toHaveProperty("place");
    expect(facadeContract.bot).toHaveProperty("ensure");
  });

  it("legacy/test-only：应提供旧 Facade 渐进披露索引", () => {
    const index = createSandboxFacadePromptIndex();
    const botDescription = describeFacadeNamespace("bot");

    expect(index).toContain("Facade namespaces");
    expect(index).toContain("describe(namespace)");
    expect(index).not.toContain("goTo(x,y,z)");
    expect(botDescription).toContain("goTo");
    expect(describeFacadeNamespace("task")).toContain("userMessage");
  });

  it("legacy/test-only：应按 token 预算维护旧 Facade LRU 热队列", () => {
    const botBudget = Math.ceil(describeFacadeNamespace("bot").length / 4) + 1;
    const chatBudget = Math.ceil(describeFacadeNamespace("chat").length / 4) + 1;
    const bothBudget = botBudget + chatBudget + 4;
    const withBot = updateSandboxFacadeHotNamespaceQueue({
      namespace: "bot",
      budget_tokens: bothBudget,
    });
    const withChat = updateSandboxFacadeHotNamespaceQueue({
      queue: withBot,
      namespace: "chat",
      budget_tokens: bothBudget,
    });
    const refreshedBot = updateSandboxFacadeHotNamespaceQueue({
      queue: withChat,
      namespace: "bot",
      budget_tokens: bothBudget,
    });
    const trimmed = updateSandboxFacadeHotNamespaceQueue({
      queue: refreshedBot,
      namespace: "task",
      budget_tokens: chatBudget,
    });

    expect(withChat.entries.map((entry) => entry.namespace)).toEqual(["bot", "chat"]);
    expect(refreshedBot.entries.map((entry) => entry.namespace)).toEqual(["chat", "bot"]);
    expect(trimmed.total_tokens).toBeLessThanOrEqual(chatBudget);
    expect(trimmed.entries.at(-1)?.namespace).toBe("task");
    expect(() =>
      updateSandboxFacadeHotNamespaceQueue({
        namespace: "bot",
        budget_tokens: 0,
      }),
    ).toThrow(/budget_tokens/);
  });
});
