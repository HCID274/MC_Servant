import type { InterruptSource } from "../core-ports/runtime.js";

/** control fast-path（控制快路径） 支持的精确命令。 */
export type InterfaceControlCommand = InterruptSource extends infer TSource
  ? TSource extends { readonly type: "control"; readonly command: infer TCommand }
    ? TCommand
    : never
  : never;

/** control fast-path（控制快路径） 的匹配结果。 */
export interface InterfaceControlFastPathDecision {
  /** 入口层识别出的控制命令。 */
  readonly command: InterfaceControlCommand;
  /** 统一中断原因。 */
  readonly reason: string;
}

const CONTROL_FAST_PATH_COMMANDS = Object.freeze(
  new Map<string, InterfaceControlFastPathDecision>([
    ["停", Object.freeze({ command: "interrupt", reason: "control_interrupt" })],
    ["停止", Object.freeze({ command: "interrupt", reason: "control_interrupt" })],
    ["停下", Object.freeze({ command: "interrupt", reason: "control_interrupt" })],
    ["别动", Object.freeze({ command: "interrupt", reason: "control_interrupt" })],
    ["取消", Object.freeze({ command: "cancel", reason: "control_cancel" })],
  ]),
);

/** 精确匹配 control fast-path（控制快路径） 命令；多一个字就返回 null。 */
export function matchInterfaceControlFastPath(
  content: string,
): InterfaceControlFastPathDecision | null {
  return CONTROL_FAST_PATH_COMMANDS.get(content.trim()) ?? null;
}
