import type { MineflayerMiningPort } from "../types.js";
import { readMineflayerBlockAt } from "../world-reader.js";
/**
 * mine（挖掘） 路径规划：基于真实方块快照与真实 bot 动作集（walk / drop1 / jumpUp /
 * digWalk / digStepDown / digStepUp）的 Dijkstra 搜索。
 *
 * 当前实现的核心边界：
 * - 状态空间是 bot 真实物理可执行的动作集合，而非"楼梯形状"约束；
 * - 目标函数是"是否能从当前 foot 直接挖到任意候选 stone"，而非"y 下降一格"；
 * - 不做 fill / 垫高，远距离接近由 terrain-router 兜底；本模块只负责挖掘动作附近的可达性。
 */
import type { MineBlockFactReader } from "./facts.js";

export interface MineBlockPos {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface MineRouteTarget {
  readonly position: MineBlockPos;
  readonly blockName: string;
}

export type MineRouteDirection = "north" | "east" | "south" | "west";

export type MineRouteAction =
  | { readonly kind: "walk"; readonly toFoot: MineBlockPos; readonly dir: MineRouteDirection }
  | { readonly kind: "drop1"; readonly toFoot: MineBlockPos; readonly dir: MineRouteDirection }
  | { readonly kind: "jumpUp"; readonly toFoot: MineBlockPos; readonly dir: MineRouteDirection }
  | {
      readonly kind: "digWalk";
      readonly toFoot: MineBlockPos;
      readonly dir: MineRouteDirection;
      readonly digs: readonly MineBlockPos[];
    }
  | {
      readonly kind: "digStepDown";
      readonly toFoot: MineBlockPos;
      readonly dir: MineRouteDirection;
      readonly digs: readonly MineBlockPos[];
    }
  | {
      readonly kind: "digStepUp";
      readonly toFoot: MineBlockPos;
      readonly dir: MineRouteDirection;
      readonly digs: readonly MineBlockPos[];
    };

export interface MineRoutePlan {
  readonly actions: readonly MineRouteAction[];
  readonly target: MineBlockPos;
  readonly finalFoot: MineBlockPos;
  readonly cost: number;
}

export interface MineRoutePlanResult {
  readonly plan: MineRoutePlan | null;
  readonly diagnostics: readonly string[];
  readonly expandedStates: number;
}

const DIRECTIONS: readonly MineRouteDirection[] = Object.freeze([
  "north",
  "east",
  "south",
  "west",
] as const);
const DIR_VEC: Readonly<Record<MineRouteDirection, { readonly dx: number; readonly dz: number }>> =
  Object.freeze({
    north: Object.freeze({ dx: 0, dz: -1 }),
    east: Object.freeze({ dx: 1, dz: 0 }),
    south: Object.freeze({ dx: 0, dz: 1 }),
    west: Object.freeze({ dx: -1, dz: 0 }),
  });

const COST_WALK = 10;
const COST_DROP1 = 12;
const COST_JUMP_UP = 14;
const COST_DIG_WALK_BASE = 22;
const COST_DIG_STEP_BASE = 12;
const COST_DIG_PER_BLOCK = 4;
const COST_TURN_PENALTY = 2;

const MAX_REACH = 3.5;
const EYE_OFFSET_Y = 1.62;

const DEFAULT_MAX_EXPANDED = 24_000;
const DEFAULT_MAX_ACTION_DEPTH = 60;
const DEFAULT_MAX_PLANNED_AIR = 16;
const MAX_DYNAMIC_PLANNED_AIR = 96;
const BODY_CLEARANCE = 2;
const JUMP_CLEARANCE = 3;

interface SearchNode {
  readonly foot: MineBlockPos;
  readonly plannedAir: ReadonlySet<string>;
  readonly cost: number;
  readonly parent: SearchNode | null;
  readonly action: MineRouteAction | null;
  readonly lastDir: MineRouteDirection | null;
  readonly lastActionKind: MineRouteAction["kind"] | null;
  readonly depth: number;
}

/** 入口：从 startFoot 找最低代价能挖到任一 target 的动作序列。 */
/** 挖掘路径规划入口：从起点出发寻找到达目标方块的最短路径（A* 搜索）。 */
export function planMineRoute(input: {
  readonly bot: MineflayerMiningPort;
  readonly facts: MineBlockFactReader;
  readonly blockName: string;
  readonly startFoot: MineBlockPos;
  readonly targets: readonly MineRouteTarget[];
  readonly maxExpandedStates?: number;
  readonly maxActionDepth?: number;
  readonly maxPlannedAir?: number;
}): MineRoutePlanResult {
  const diagnostics: string[] = [];
  const verifiedTargets = input.targets
    .filter((target) => verifyTargetIsReadable(input.bot, input.facts, input.blockName, target))
    .sort(
      (left, right) =>
        distance(input.startFoot, left.position) - distance(input.startFoot, right.position),
    );
  diagnostics.push(`mine_bfs_targets:${verifiedTargets.length}`);
  if (verifiedTargets.length === 0) {
    return {
      plan: null,
      diagnostics: Object.freeze(diagnostics),
      expandedStates: 0,
    };
  }

  const maxExpanded = input.maxExpandedStates ?? DEFAULT_MAX_EXPANDED;
  const maxDepth = input.maxActionDepth ?? DEFAULT_MAX_ACTION_DEPTH;
  const maxPlannedAir =
    input.maxPlannedAir ?? deriveMineMaxPlannedAir(input.startFoot, verifiedTargets);
  diagnostics.push(
    `mine_bfs_budget:max_expanded=${maxExpanded};max_depth=${maxDepth};max_air=${maxPlannedAir};heuristic=target_aware`,
  );

  const startNode: SearchNode = {
    foot: freezePos(input.startFoot),
    plannedAir: new Set<string>(),
    cost: 0,
    parent: null,
    action: null,
    lastDir: null,
    lastActionKind: null,
    depth: 0,
  };

  const initialReachable = findReachableTarget(
    input.bot,
    input.facts,
    input.blockName,
    startNode,
    verifiedTargets,
  );
  if (initialReachable !== null) {
    diagnostics.push(
      `mine_bfs_solved:cost=0;actions=0;expanded=0;target=${posLabel(initialReachable)}`,
    );
    return {
      plan: {
        actions: Object.freeze([]),
        target: freezePos(initialReachable),
        finalFoot: freezePos(startNode.foot),
        cost: 0,
      },
      diagnostics: Object.freeze(diagnostics),
      expandedStates: 0,
    };
  }

  const open = new MinHeap<SearchNode>((left, right) => {
    const leftPriority = left.cost + mineRouteHeuristic(left.foot, verifiedTargets);
    const rightPriority = right.cost + mineRouteHeuristic(right.foot, verifiedTargets);
    return leftPriority === rightPriority ? left.cost - right.cost : leftPriority - rightPriority;
  });
  open.push(startNode);
  const visited = new Map<string, number>();
  visited.set(stateKey(startNode), 0);

  let expanded = 0;
  while (!open.isEmpty() && expanded < maxExpanded) {
    const node = open.pop();
    if (node === undefined) break;
    expanded += 1;

    const dugTarget = findDugTarget(node.action, verifiedTargets);
    if (dugTarget !== null) {
      const actions = reconstructActions(node);
      const digStepDownCount = actions.filter((action) => action.kind === "digStepDown").length;
      const digStepUpCount = actions.filter((action) => action.kind === "digStepUp").length;
      diagnostics.push(
        `mine_bfs_solved_by_route_dig:cost=${node.cost};actions=${actions.length};expanded=${expanded};target=${posLabel(dugTarget)};foot=${posLabel(node.foot)}`,
      );
      if (digStepDownCount > 0) {
        diagnostics.push(`mine_bfs_dig_step_down_used:${digStepDownCount}`);
      }
      if (digStepUpCount > 0) {
        diagnostics.push(`mine_bfs_dig_step_up_used:${digStepUpCount}`);
      }
      return {
        plan: {
          actions,
          target: freezePos(dugTarget),
          finalFoot: freezePos(node.foot),
          cost: node.cost,
        },
        diagnostics: Object.freeze(diagnostics),
        expandedStates: expanded,
      };
    }

    const reachable = findReachableTarget(
      input.bot,
      input.facts,
      input.blockName,
      node,
      verifiedTargets,
    );
    if (reachable !== null) {
      const actions = reconstructActions(node);
      const digStepDownCount = actions.filter((action) => action.kind === "digStepDown").length;
      const digStepUpCount = actions.filter((action) => action.kind === "digStepUp").length;
      diagnostics.push(
        `mine_bfs_solved:cost=${node.cost};actions=${actions.length};expanded=${expanded};target=${posLabel(reachable)};foot=${posLabel(node.foot)}`,
      );
      if (digStepDownCount > 0) {
        diagnostics.push(`mine_bfs_dig_step_down_used:${digStepDownCount}`);
      }
      if (digStepUpCount > 0) {
        diagnostics.push(`mine_bfs_dig_step_up_used:${digStepUpCount}`);
      }
      return {
        plan: {
          actions,
          target: freezePos(reachable),
          finalFoot: freezePos(node.foot),
          cost: node.cost,
        },
        diagnostics: Object.freeze(diagnostics),
        expandedStates: expanded,
      };
    }

    if (node.depth >= maxDepth) continue;
    if (node.plannedAir.size >= maxPlannedAir) continue;

    for (const successor of expandSuccessors(input.bot, input.facts, input.blockName, node)) {
      const key = stateKey(successor);
      const seen = visited.get(key);
      if (seen !== undefined && seen <= successor.cost) continue;
      visited.set(key, successor.cost);
      open.push(successor);
    }
  }

  diagnostics.push(`mine_bfs_no_path:expanded=${expanded}`);
  return {
    plan: null,
    diagnostics: Object.freeze(diagnostics),
    expandedStates: expanded,
  };
}

/**
 * 根据起始脚位和目标位置动态计算挖掘搜索的最大空气方块预算。
 * 垂直落差越大，需要挖掘的 stepDown 动作越多，因此需要更大的预算。
 * 返回值被限制在 [DEFAULT_MAX_PLANNED_AIR, MAX_DYNAMIC_PLANNED_AIR] 范围内。
 */
function deriveMineMaxPlannedAir(
  startFoot: MineBlockPos,
  targets: readonly MineRouteTarget[],
): number {
  const deepestTargetY = targets.reduce(
    (lowest, target) => Math.min(lowest, target.position.y),
    startFoot.y,
  );
  const verticalDrop = Math.max(0, startFoot.y - deepestTargetY);
  const estimatedStepDownDigBudget = verticalDrop * (JUMP_CLEARANCE + 1) + 8;
  return Math.min(
    MAX_DYNAMIC_PLANNED_AIR,
    Math.max(DEFAULT_MAX_PLANNED_AIR, estimatedStepDownDigBudget),
  );
}

/**
 * 挖掘路径的 A* 启发式函数。
 * 综合考虑水平距离（超出 MAX_REACH 的部分）和垂直距离（上/下需要不同代价），
 * 返回从当前位置到最近目标的预估最低代价。
 */
function mineRouteHeuristic(foot: MineBlockPos, targets: readonly MineRouteTarget[]): number {
  let best = Number.POSITIVE_INFINITY;
  const eyeY = foot.y + EYE_OFFSET_Y;
  for (const target of targets) {
    const horizontalMiss = Math.max(
      0,
      Math.hypot(foot.x - target.position.x, foot.z - target.position.z) - MAX_REACH,
    );
    const targetCenterY = target.position.y + 0.5;
    const verticalMiss = Math.max(0, Math.abs(eyeY - targetCenterY) - MAX_REACH);
    const rawDy = target.position.y - foot.y;
    const verticalCost = rawDy < 0 ? Math.abs(rawDy) * COST_DIG_STEP_BASE : rawDy * COST_JUMP_UP;
    const score = horizontalMiss * COST_WALK + verticalMiss * COST_DROP1 + verticalCost;
    best = Math.min(best, score);
  }
  return Number.isFinite(best) ? best : 0;
}

/**
 * 展开挖掘搜索节点的所有后继状态。
 * 比 terrain-router 简单，不支持 placeUp（挖掘场景不需要垫脚石），
 * 但额外支持 digStepDown（挖下去一格）和 digStepUp（挖上去一格）。
 */
function expandSuccessors(
  bot: MineflayerMiningPort,
  facts: MineBlockFactReader,
  blockName: string,
  node: SearchNode,
): SearchNode[] {
  const out: SearchNode[] = [];
  const fy = node.foot.y;

  for (const dir of DIRECTIONS) {
    const vec = DIR_VEC[dir];
    const turn = node.lastDir !== null && node.lastDir !== dir ? COST_TURN_PENALTY : 0;
    const fx = node.foot.x + vec.dx;
    const fz = node.foot.z + vec.dz;

    const walkFoot = freezePos({ x: fx, y: fy, z: fz });
    if (
      isWalkableSupport(bot, facts, { x: fx, y: fy - 1, z: fz }, node.plannedAir) &&
      hasClearance(bot, facts, walkFoot, BODY_CLEARANCE, node.plannedAir)
    ) {
      pushSuccessor(out, node, { kind: "walk", toFoot: walkFoot, dir }, COST_WALK + turn);
    }

    const dropFoot = freezePos({ x: fx, y: fy - 1, z: fz });
    if (
      hasClearance(bot, facts, node.foot, JUMP_CLEARANCE, node.plannedAir) &&
      hasClearance(bot, facts, dropFoot, JUMP_CLEARANCE, node.plannedAir) &&
      isWalkableSupport(bot, facts, { x: fx, y: fy - 2, z: fz }, node.plannedAir)
    ) {
      pushSuccessor(out, node, { kind: "drop1", toFoot: dropFoot, dir }, COST_DROP1 + turn);
    }

    const upFoot = freezePos({ x: fx, y: fy + 1, z: fz });
    if (
      hasClearance(bot, facts, node.foot, JUMP_CLEARANCE, node.plannedAir) &&
      isWalkableSupport(bot, facts, { x: fx, y: fy, z: fz }, node.plannedAir) &&
      hasClearance(bot, facts, upFoot, JUMP_CLEARANCE, node.plannedAir)
    ) {
      pushSuccessor(out, node, { kind: "jumpUp", toFoot: upFoot, dir }, COST_JUMP_UP + turn);
    }

    const bodyPos = freezePos({ x: fx, y: fy, z: fz });
    const headPos = freezePos({ x: fx, y: fy + 1, z: fz });
    const supportPos = freezePos({ x: fx, y: fy - 1, z: fz });
    if (isWalkableSupport(bot, facts, supportPos, node.plannedAir)) {
      const digs = collectClearanceDigs(bot, facts, [bodyPos, headPos], node.plannedAir);
      if (digs !== null && digs.length > 0) {
        pushSuccessor(
          out,
          node,
          {
            kind: "digWalk",
            toFoot: bodyPos,
            dir,
            digs,
          },
          COST_DIG_WALK_BASE + COST_DIG_PER_BLOCK * digs.length + turn,
        );
      }
    }

    const currentTop = freezePos({ x: node.foot.x, y: fy + 2, z: node.foot.z });
    const stepDownFoot = freezePos({ x: fx, y: fy - 1, z: fz });
    const stepDownSupport = freezePos({ x: fx, y: fy - 2, z: fz });
    const stepDownDigs = collectClearanceDigs(
      bot,
      facts,
      [currentTop, ...clearancePositions(stepDownFoot, JUMP_CLEARANCE)],
      node.plannedAir,
    );
    if (
      stepDownDigs !== null &&
      stepDownDigs.length > 0 &&
      hasClearance(bot, facts, node.foot, BODY_CLEARANCE, node.plannedAir) &&
      isWalkableSupport(bot, facts, stepDownSupport, node.plannedAir) &&
      !isImmediateReverseVerticalExcavation(node, "digStepDown", dir)
    ) {
      pushSuccessor(
        out,
        node,
        {
          kind: "digStepDown",
          toFoot: stepDownFoot,
          dir,
          digs: stepDownDigs,
        },
        COST_DIG_STEP_BASE + COST_DIG_PER_BLOCK * stepDownDigs.length + turn,
      );
    }

    const stepUpFoot = freezePos({ x: fx, y: fy + 1, z: fz });
    const stepUpSupport = freezePos({ x: fx, y: fy, z: fz });
    const stepUpDigs = collectClearanceDigs(
      bot,
      facts,
      [currentTop, ...clearancePositions(stepUpFoot, JUMP_CLEARANCE)],
      node.plannedAir,
    );
    if (
      stepUpDigs !== null &&
      stepUpDigs.length > 0 &&
      hasClearance(bot, facts, node.foot, BODY_CLEARANCE, node.plannedAir) &&
      isWalkableSupport(bot, facts, stepUpSupport, node.plannedAir) &&
      !isImmediateReverseVerticalExcavation(node, "digStepUp", dir)
    ) {
      pushSuccessor(
        out,
        node,
        {
          kind: "digStepUp",
          toFoot: stepUpFoot,
          dir,
          digs: stepUpDigs,
        },
        COST_DIG_STEP_BASE + COST_DIG_PER_BLOCK * stepUpDigs.length + COST_JUMP_UP + turn,
      );
    }
  }

  return out;
}

/**
 * 将后继动作加入搜索队列，维护 plannedAir 集合。
 * 与 terrain-router 不同，这里没有 noProgressSteps 剪枝（挖掘场景目标更集中）。
 */
function pushSuccessor(
  out: SearchNode[],
  parent: SearchNode,
  action: MineRouteAction,
  cost: number,
): void {
  const digs = "digs" in action ? action.digs : [];
  let plannedAir: ReadonlySet<string> = parent.plannedAir;
  if (digs.length > 0) {
    const next = new Set(parent.plannedAir);
    for (const dig of digs) next.add(positionKey(dig));
    plannedAir = next;
  }
  const lastDir: MineRouteDirection | null = "dir" in action ? action.dir : parent.lastDir;
  out.push({
    foot: action.toFoot,
    plannedAir,
    cost: parent.cost + cost,
    parent,
    action,
    lastDir,
    lastActionKind: action.kind,
    depth: parent.depth + 1,
  });
}

/**
 * 从搜索节点回溯重建完整动作序列。
 * 沿 parent 指针反向遍历直到根节点，然后反转得到从起点到终点的动作列表。
 */
function reconstructActions(node: SearchNode): readonly MineRouteAction[] {
  const actions: MineRouteAction[] = [];
  let current: SearchNode | null = node;
  while (current !== null && current.action !== null) {
    actions.unshift(current.action);
    current = current.parent;
  }
  return Object.freeze(actions);
}

/**
 * 检查上一步动作是否已经挖掉了某个目标方块。
 * 用于在搜索循环中提前终止：如果动作序列中包含对目标的挖掘，就不需要再"到达"目标了。
 */
function findDugTarget(
  action: MineRouteAction | null,
  targets: readonly MineRouteTarget[],
): MineBlockPos | null {
  if (action === null || !("digs" in action)) return null;
  for (const dig of action.digs) {
    const target = targets.find((candidate) => samePos(candidate.position, dig));
    if (target !== undefined) return target.position;
  }
  return null;
}

/**
 * 生成搜索节点的唯一标识，用于 visited 集合去重。
 * 包含脚位坐标、最后朝向、最后动作类型和已计划空气方块集合。
 */
function stateKey(node: SearchNode): string {
  const foot = positionKey(node.foot);
  const dir = node.lastDir ?? "none";
  if (node.plannedAir.size === 0) return `${foot}:${dir}`;
  const sorted = Array.from(node.plannedAir).sort().join("|");
  return `${foot}:${dir}:${node.lastActionKind ?? "none"}#${sorted}`;
}

/** 坐标转字符串键，用于 plannedAir 集合去重。 */
function positionKey(pos: MineBlockPos): string {
  return `${pos.x}:${pos.y}:${pos.z}`;
}

/** 冻结坐标对象为不可变实例。 */
function freezePos(pos: MineBlockPos): MineBlockPos {
  return Object.freeze({ x: pos.x, y: pos.y, z: pos.z });
}

/**
 * 校验目标方块在当前世界快照中是否确实可读、可挖、名称匹配。
 * 过滤掉在搜索开始前就已经被挖掉或不可达的目标。
 */
function verifyTargetIsReadable(
  bot: MineflayerMiningPort,
  facts: MineBlockFactReader,
  blockName: string,
  target: MineRouteTarget,
): boolean {
  if (facts.normalizeName(target.blockName) !== blockName) return false;
  const block = readMineflayerBlockAt(bot, target.position);
  if (block === null || block === undefined) return false;
  if (!facts.isDiggableBlock(block)) return false;
  return facts.normalizeName(block.name) === blockName;
}

/** 在当前节点状态下，检查是否有目标方块位于可达范围内且视线通畅。 */
function findReachableTarget(
  bot: MineflayerMiningPort,
  facts: MineBlockFactReader,
  blockName: string,
  node: SearchNode,
  targets: readonly MineRouteTarget[],
): MineBlockPos | null {
  const eye = {
    x: node.foot.x + 0.5,
    y: node.foot.y + EYE_OFFSET_Y,
    z: node.foot.z + 0.5,
  };
  let best: { readonly position: MineBlockPos; readonly distance: number } | null = null;
  for (const target of targets) {
    const tx = target.position.x;
    const ty = target.position.y;
    const tz = target.position.z;
    const center = { x: tx + 0.5, y: ty + 0.5, z: tz + 0.5 };
    const dist = Math.hypot(eye.x - center.x, eye.y - center.y, eye.z - center.z);
    if (dist > MAX_REACH) continue;
    if (rayClearTo(bot, facts, blockName, eye, center, target.position, node.plannedAir)) {
      if (best === null || dist < best.distance) {
        best = { position: target.position, distance: dist };
      }
    }
  }
  return best?.position ?? null;
}

/**
 * 检查从当前脚位的眼部位置（+1.62 格高）到目标方块中心的视线是否通畅。
 * 使用射线步进（ray marching）沿视线逐格检查，遇到非空气且未计划挖掘的方块就判定为不通。
 */
function rayClearTo(
  bot: MineflayerMiningPort,
  facts: MineBlockFactReader,
  blockName: string,
  from: { readonly x: number; readonly y: number; readonly z: number },
  to: { readonly x: number; readonly y: number; readonly z: number },
  target: MineBlockPos,
  plannedAir: ReadonlySet<string>,
): boolean {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const dist = Math.hypot(dx, dy, dz);
  const steps = Math.max(2, Math.ceil(dist * 4));
  const seen = new Set<string>();
  for (let i = 1; i < steps; i += 1) {
    const t = i / steps;
    const px = Math.floor(from.x + dx * t);
    const py = Math.floor(from.y + dy * t);
    const pz = Math.floor(from.z + dz * t);
    if (px === target.x && py === target.y && pz === target.z) continue;
    const key = `${px}:${py}:${pz}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (plannedAir.has(key)) continue;
    const block = readMineflayerBlockAt(bot, { x: px, y: py, z: pz });
    if (block === null || block === undefined) continue;
    if (facts.isAirBlock(block)) continue;
    void blockName;
    return false;
  }
  return true;
}

/**
 * 判断指定坐标是否可通过（空气方块或已被计划挖掘）。
 * 用于检查身体/头部空间是否足够。
 */
function isPassable(
  bot: MineflayerMiningPort,
  facts: MineBlockFactReader,
  pos: MineBlockPos,
  plannedAir: ReadonlySet<string>,
): boolean {
  if (plannedAir.has(positionKey(pos))) return true;
  const block = readMineflayerBlockAt(bot, pos);
  if (block === null || block === undefined) return false;
  return facts.isAirBlock(block);
}

/** 计算两个坐标的欧几里得距离。 */
function distance(left: MineBlockPos, right: MineBlockPos): number {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

/** 判断两个坐标是否相同。 */
function samePos(left: MineBlockPos, right: MineBlockPos): boolean {
  return left.x === right.x && left.y === right.y && left.z === right.z;
}

/** 判断两个水平方向是否相反（north vs south，east vs west）。 */
function isOppositeDirection(left: MineRouteDirection, right: MineRouteDirection): boolean {
  return (
    (left === "north" && right === "south") ||
    (left === "south" && right === "north") ||
    (left === "east" && right === "west") ||
    (left === "west" && right === "east")
  );
}

/**
 * 防止连续反向垂直挖掘（先挖下去再挖上来，或反之）。
 * 这种模式通常意味着搜索在"原地打转"，应该被剪枝。
 */
function isImmediateReverseVerticalExcavation(
  node: SearchNode,
  nextKind: "digStepDown" | "digStepUp",
  nextDir: MineRouteDirection,
): boolean {
  const previous = node.action;
  if (previous === null) return false;
  if (!isVerticalExcavation(previous.kind) || !isVerticalExcavation(nextKind)) return false;
  return isOppositeDirection(previous.dir, nextDir);
}

/** 判断动作类型是否属于垂直挖掘（digStepDown / digStepUp）。 */
function isVerticalExcavation(kind: MineRouteAction["kind"]): kind is "digStepDown" | "digStepUp" {
  return kind === "digStepDown" || kind === "digStepUp";
}

/** 坐标格式化为日志标签（x,y,z）。 */
function posLabel(pos: MineBlockPos): string {
  return `${pos.x},${pos.y},${pos.z}`;
}

/**
 * 判断指定坐标是否有实体支撑（可以站在上面）。
 * 与 isPassable 互补：isPassable 检查"是否可以穿过"，这里检查"是否可以站立"。
 */
function isWalkableSupport(
  bot: MineflayerMiningPort,
  facts: MineBlockFactReader,
  pos: MineBlockPos,
  plannedAir: ReadonlySet<string>,
): boolean {
  if (plannedAir.has(positionKey(pos))) return false;
  const block = readMineflayerBlockAt(bot, pos);
  if (block === null || block === undefined) return false;
  return facts.isSupportBlock(block);
}

/** 生成脚位上方 height 格的坐标序列，用于净空检查。 */
function clearancePositions(foot: MineBlockPos, height: number): readonly MineBlockPos[] {
  return Object.freeze(
    Array.from({ length: height }, (_, dy) => freezePos({ x: foot.x, y: foot.y + dy, z: foot.z })),
  );
}

/**
 * 检查指定脚位上方 height 格是否全部可通过（用于判断跳跃是否有足够空间）。
 * BODY_CLEARANCE = 2 检查身体两格，JUMP_CLEARANCE = 3 检查跳跃三格。
 */
function hasClearance(
  bot: MineflayerMiningPort,
  facts: MineBlockFactReader,
  foot: MineBlockPos,
  height: number,
  plannedAir: ReadonlySet<string>,
): boolean {
  return clearancePositions(foot, height).every((pos) => isPassable(bot, facts, pos, plannedAir));
}

/**
 * 收集需要挖掘才能通过的方块列表。
 * 如果遇到不可挖掘的方块则返回 null（整个动作不可行）。
 * 用于 digWalk / digStepDown / digStepUp 等需要先挖再走的动作。
 */
function collectClearanceDigs(
  bot: MineflayerMiningPort,
  facts: MineBlockFactReader,
  positions: readonly MineBlockPos[],
  plannedAir: ReadonlySet<string>,
): readonly MineBlockPos[] | null {
  const digs: MineBlockPos[] = [];
  const seen = new Set<string>();
  for (const pos of positions) {
    const key = positionKey(pos);
    if (seen.has(key)) continue;
    seen.add(key);
    if (isPassable(bot, facts, pos, plannedAir)) continue;
    if (!canDigBlock(bot, facts, pos, plannedAir)) return null;
    digs.push(freezePos(pos));
  }
  return Object.freeze(digs);
}

/** 判断方块是否可挖掘：排除已被计划挖掘的方块，检查 minecraft-data 中的 diggable 属性。 */
function canDigBlock(
  bot: MineflayerMiningPort,
  facts: MineBlockFactReader,
  pos: MineBlockPos,
  plannedAir: ReadonlySet<string>,
): boolean {
  if (plannedAir.has(positionKey(pos))) return false;
  const block = readMineflayerBlockAt(bot, pos);
  if (block === null || block === undefined) return false;
  return facts.isDiggableBlock(block);
}

/**
 * 最小堆（优先队列），用于 A* 搜索中按代价排序展开节点。
 * 实现了标准的二叉堆，支持 push / pop / isEmpty 操作。
 */
class MinHeap<T> {
  private readonly data: T[] = [];
  constructor(private readonly compare: (left: T, right: T) => number) {}

  /** 判断堆是否为空。 */
  isEmpty(): boolean {
    return this.data.length === 0;
  }

  /** 将元素插入堆并维护最小堆性质。 */
  push(item: T): void {
    this.data.push(item);
    this.bubbleUp(this.data.length - 1);
  }

  /** 弹出堆顶（最小元素）并维护最小堆性质。 */
  pop(): T | undefined {
    if (this.data.length === 0) return undefined;
    const top = this.data[0];
    const last = this.data.pop();
    if (last === undefined) return top;
    if (this.data.length > 0) {
      this.data[0] = last;
      this.bubbleDown(0);
    }
    return top;
  }

  /** 上浮：将索引处元素向上移动直到满足堆性质。 */
  private bubbleUp(index: number): void {
    let cursor = index;
    while (cursor > 0) {
      const parent = (cursor - 1) >>> 1;
      const cursorValue = this.data[cursor];
      const parentValue = this.data[parent];
      if (cursorValue === undefined || parentValue === undefined) break;
      if (this.compare(cursorValue, parentValue) >= 0) break;
      this.data[cursor] = parentValue;
      this.data[parent] = cursorValue;
      cursor = parent;
    }
  }

  /** 下沉：将索引处元素向下移动直到满足堆性质。 */
  private bubbleDown(index: number): void {
    const length = this.data.length;
    let cursor = index;
    while (true) {
      const left = cursor * 2 + 1;
      const right = cursor * 2 + 2;
      let smallest = cursor;
      const cursorValue = this.data[smallest];
      if (cursorValue === undefined) break;
      if (left < length) {
        const leftValue = this.data[left];
        if (leftValue !== undefined && this.compare(leftValue, this.data[smallest] as T) < 0) {
          smallest = left;
        }
      }
      if (right < length) {
        const rightValue = this.data[right];
        if (rightValue !== undefined && this.compare(rightValue, this.data[smallest] as T) < 0) {
          smallest = right;
        }
      }
      if (smallest === cursor) break;
      const tmp = this.data[cursor] as T;
      this.data[cursor] = this.data[smallest] as T;
      this.data[smallest] = tmp;
      cursor = smallest;
    }
  }
}
