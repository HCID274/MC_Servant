/**
 * 沙箱语义动作结果规范化脚本。
 *
 * 这里生成注入 isolated-vm 的纯事实函数：只读取 action 返回值里的完成证明，
 * 不读 runtime、不调用 LLM、不补默认完成。
 */
export function createSandboxSemanticActionResultScript(): string {
  return `
    const __createUnknownCompletionFailure = (method, args, data, reason) => ({
      ok: false,
      error: {
        action: String(method).replace(/^bot\\./, ""),
        params: { args },
        code: "unknown_completion",
        message: reason,
        details: {
          failure_stage: String(method).replace(/^bot\\./, ""),
          reason,
          result: data
        }
      }
    });
    const __createSemanticConditionFailure = (method, args, data, target, requestedCount, completedCount, reason) => ({
      ok: false,
      error: {
        action: String(method).replace(/^bot\\./, ""),
        params: { args },
        code: "condition_not_met",
        message: reason,
        details: {
          failure_stage: String(method).replace(/^bot\\./, ""),
          reason,
          target_progress: {
            action: String(method).replace(/^bot\\./, ""),
            ...(typeof target === "string" ? { target } : {}),
            ...(typeof requestedCount === "number" ? { requested_count: requestedCount, target_count: requestedCount } : {}),
            ...(typeof completedCount === "number" ? { completed_count: completedCount } : {})
          },
          ...(typeof target === "string" ? { target } : {}),
          ...(typeof requestedCount === "number" ? { requested_count: requestedCount, target_count: requestedCount } : {}),
          ...(typeof completedCount === "number" ? { completed_count: completedCount } : {}),
          ...(__readWorldKey(data) !== undefined ? { world_key: __readWorldKey(data) } : {})
        }
      }
    });
    const __normalizeSemanticActionCompletion = (method, args, result) => {
      if (__isFailedResult(result)) {
        return result;
      }
      const data = __readResultData(result);
      if (method === "bot.mine") {
        const requestedCount = __readActionCountArg(args);
        const completedCount = __readNumericField(data, "collected_count");
        const target = typeof args?.[0] === "string" ? args[0] : data?.block_name;
        if (requestedCount === undefined || completedCount === undefined || typeof data?.collected_item_name !== "string") {
          return __createUnknownCompletionFailure(method, args, data, "mine result lacks inventory completion proof");
        }
        return completedCount >= requestedCount
          ? result
          : __createSemanticConditionFailure(method, args, data, target, requestedCount, completedCount, "mine completed below requested count");
      }
      if (method === "bot.cutTree") {
        const requestedCount = __readActionCountArg(args, 0);
        const completedCount = __readNumericField(data, "collected_count");
        const target = data?.clusters?.find?.((cluster) => cluster?.collected_count > 0)?.log_block_name ?? data?.clusters?.[0]?.log_block_name ?? "logs";
        if (requestedCount === undefined || completedCount === undefined || !Array.isArray(data?.clusters)) {
          return __createUnknownCompletionFailure(method, args, data, "cutTree result lacks inventory completion proof");
        }
        return completedCount >= requestedCount
          ? result
          : __createSemanticConditionFailure(method, args, data, target, requestedCount, completedCount, "cutTree collected logs below requested count");
      }
      if (method === "bot.equip") {
        return typeof data?.item_name === "string" || typeof data?.itemName === "string"
          ? result
          : __createUnknownCompletionFailure(method, args, data, "equip result lacks equipped item proof");
      }
      if (method === "bot.goTo") {
        return data?.reached === true
          ? result
          : __createUnknownCompletionFailure(method, args, data, "goTo result lacks reached proof");
      }
      if (method === "bot.craft") {
        const requestedCount = __readActionCountArg(args);
        const completedCount = __readNumericField(data, "completed_count");
        const target = typeof args?.[0] === "string" ? args[0] : data?.item_name;
        if (requestedCount === undefined || completedCount === undefined || typeof data?.item_name !== "string") {
          return __createUnknownCompletionFailure(method, args, data, "craft result lacks inventory completion proof");
        }
        return completedCount >= requestedCount
          ? result
          : __createSemanticConditionFailure(method, args, data, target, requestedCount, completedCount, "craft completed below requested count");
      }
      if (method === "bot.place") {
        const completedCount = __readNumericField(data, "completed_count");
        const target = typeof args?.[0] === "string" ? args[0] : data?.block_name;
        if (completedCount === undefined || completedCount < 1 || typeof data?.block_name !== "string") {
          return __createUnknownCompletionFailure(method, args, data, "place result lacks placed block proof");
        }
        return result;
      }
      return result;
    };
  `;
}
