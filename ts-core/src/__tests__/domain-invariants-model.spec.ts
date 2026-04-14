import { describe, expect, it } from "vitest";

import { assertNonEmptyString, cloneReadonlyValue, domainModuleBoundary } from "../domain/index.js";

describe("domain invariants（领域基础不变量）", () => {
  it("应导出共享不变量与只读辅助工具", () => {
    expect(domainModuleBoundary.moduleName).toBe("domain");
    expect(domainModuleBoundary.placeholderExports).toContain("assertNonEmptyString");
    expect(domainModuleBoundary.placeholderExports).toContain("cloneReadonlyValue");
  });

  it("应保持非空字符串断言的既有报错语义", () => {
    expect(() => assertNonEmptyString(" bot-root ", "botId")).not.toThrow();
    expect(() => assertNonEmptyString("   ", "botId")).toThrowError(
      "botId must be a non-empty string",
    );
  });

  it("应深克隆并冻结通用只读值而不污染原对象", () => {
    const source = {
      nested: {
        items: [{ name: "oak" }],
      },
    };

    const cloned = cloneReadonlyValue(source);

    expect(cloned).not.toBe(source);
    expect(cloned.nested).not.toBe(source.nested);
    expect(cloned.nested.items).not.toBe(source.nested.items);
    expect(Object.isFrozen(cloned)).toBe(true);
    expect(Object.isFrozen(cloned.nested)).toBe(true);
    expect(Object.isFrozen(cloned.nested.items)).toBe(true);
    expect(Object.isFrozen(cloned.nested.items[0])).toBe(true);
    expect(() => {
      (cloned.nested.items[0] as { name: string }).name = "birch";
    }).toThrow();
    expect(source.nested.items[0].name).toBe("oak");
  });
});
