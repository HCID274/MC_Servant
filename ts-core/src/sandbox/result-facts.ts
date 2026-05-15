/**
 * 沙箱结果事实读取脚本。
 *
 * 只提供跨动作 proof 与 goal summary 共用的只读事实访问器；不做完成裁决，
 * 不生成 GoalResult，也不构造用户汇报。
 */
export function createSandboxResultFactsScript(): string {
  return `
    const __isFailedResult = (value) =>
      value !== null && typeof value === "object" && value.ok === false && value.error;
    const __readResultData = (value) => {
      if (value !== null && typeof value === "object" && value.ok === true && value.data) {
        return value.data;
      }
      if (value !== null && typeof value === "object" && value.ok === true && value.result) {
        return __readResultData(value.result);
      }
      return value;
    };
    const __readCompletedCount = (data, condition) => {
      if (data !== null && typeof data === "object") {
        if (typeof data.completed_count === "number") return data.completed_count;
        if (typeof data.collected_count === "number") return data.collected_count;
        if (Array.isArray(data.collected)) {
          return data.collected.reduce((sum, item) => sum + (typeof item?.count === "number" ? item.count : 0), 0);
        }
        if (data.skill === "equip" || data.skill === "goTo") return 1;
      }
      if (condition?.kind === "equipped" || condition?.kind === "placed") return 1;
      return 0;
    };
    const __readTarget = (data, condition) => {
      if (condition?.kind === "gained" || condition?.kind === "has" || condition?.kind === "equipped") return condition.itemName;
      if (condition?.kind === "gainedTag") return condition.tagName;
      if (condition?.kind === "gainedDropOf") return data?.item_name ?? data?.resolved_targets?.[0] ?? condition.blockName;
      if (condition?.kind === "placed") return condition.blockName;
      if (data !== null && typeof data === "object") {
        return data.item_name ?? data.block_name ?? data.collected_item_name ?? data.log_block_name;
      }
      return undefined;
    };
    const __readRequestedCount = (condition, completedCount) => {
      if (condition && typeof condition.count === "number") return condition.count;
      return completedCount > 0 ? completedCount : undefined;
    };
    const __readWorldKey = (data) => {
      if (data !== null && typeof data === "object" && "world_key" in data) {
        return data.world_key ?? null;
      }
      return undefined;
    };
    const __readActionCountArg = (args, index = 1) => {
      const count = Number(args?.[index]);
      return Number.isInteger(count) && count > 0 ? count : undefined;
    };
    const __readNumericField = (data, field) =>
      data !== null && typeof data === "object" && typeof data[field] === "number"
        ? data[field]
        : undefined;
  `;
}
