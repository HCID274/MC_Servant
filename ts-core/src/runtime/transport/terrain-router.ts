import type { MineBlockFactReader } from "./mine-block-facts.js";
import type { MineflayerMiningPort, MineflayerPlacementPort } from "./types.js";
import { readMineflayerBlockAt } from "./world-reader.js";

export interface TerrainBlockPos {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export type TerrainRouteDirection = "north" | "east" | "south" | "west";

export type TerrainRouteAction =
  | { readonly kind: "walk"; readonly toFoot: TerrainBlockPos; readonly dir: TerrainRouteDirection }
  | {
      readonly kind: "drop1";
      readonly toFoot: TerrainBlockPos;
      readonly dir: TerrainRouteDirection;
    }
  | {
      readonly kind: "jumpUp";
      readonly toFoot: TerrainBlockPos;
      readonly dir: TerrainRouteDirection;
    }
  | {
      readonly kind: "placeUp1";
      readonly toFoot: TerrainBlockPos;
      readonly dir: TerrainRouteDirection;
      readonly placeAt: TerrainBlockPos;
      readonly support: TerrainBlockPos;
      readonly digs: readonly TerrainBlockPos[];
    }
  | {
      readonly kind: "digWalk";
      readonly toFoot: TerrainBlockPos;
      readonly dir: TerrainRouteDirection;
      readonly digs: readonly TerrainBlockPos[];
    }
  | {
      readonly kind: "digStepDown";
      readonly toFoot: TerrainBlockPos;
      readonly dir: TerrainRouteDirection;
      readonly digs: readonly TerrainBlockPos[];
    }
  | {
      readonly kind: "digStepUp";
      readonly toFoot: TerrainBlockPos;
      readonly dir: TerrainRouteDirection;
      readonly digs: readonly TerrainBlockPos[];
    };

export interface TerrainRoutePlan {
  readonly actions: readonly TerrainRouteAction[];
  readonly finalFoot: TerrainBlockPos;
  readonly cost: number;
}

export interface TerrainRoutePlanResult {
  readonly plan: TerrainRoutePlan | null;
  readonly diagnostics: readonly string[];
  readonly expandedStates: number;
}

const DIRECTIONS: readonly TerrainRouteDirection[] = Object.freeze([
  "north",
  "east",
  "south",
  "west",
] as const);
const DIR_VEC: Readonly<
  Record<TerrainRouteDirection, { readonly dx: number; readonly dz: number }>
> = Object.freeze({
  north: Object.freeze({ dx: 0, dz: -1 }),
  east: Object.freeze({ dx: 1, dz: 0 }),
  south: Object.freeze({ dx: 0, dz: 1 }),
  west: Object.freeze({ dx: -1, dz: 0 }),
});

const COST_WALK = 10;
const COST_DROP1 = 12;
const COST_JUMP_UP = 14;
const COST_TERRAIN_CHANGE_BASE = 24;
const COST_TERRAIN_CHANGE_PER_BLOCK = 6;
const COST_PLACE_UP_ITEM_PENALTY = 6;
const COST_TURN_PENALTY = 2;

const DEFAULT_MAX_EXPANDED = 14_000;
const DEFAULT_MAX_ACTION_DEPTH = 80;
const DEFAULT_MAX_PLANNED_AIR = 48;
const DEFAULT_MAX_PLANNED_SOLID = 160;
const DEFAULT_MAX_TOTAL_PLANNED_CHANGES = 192;
const BODY_CLEARANCE = 2;
const JUMP_CLEARANCE = 3;

interface SearchNode {
  readonly foot: TerrainBlockPos;
  readonly plannedAir: ReadonlySet<string>;
  readonly plannedSolid: ReadonlySet<string>;
  readonly cost: number;
  readonly priority: number;
  readonly parent: SearchNode | null;
  readonly action: TerrainRouteAction | null;
  readonly lastDir: TerrainRouteDirection | null;
  readonly depth: number;
}

export function planTerrainRoute(input: {
  readonly bot: MineflayerMiningPort & MineflayerPlacementPort;
  readonly facts: MineBlockFactReader;
  readonly startFoot: TerrainBlockPos;
  readonly targetFoot: TerrainBlockPos;
  readonly goalRange?: number;
  readonly allowPlaceUp?: boolean;
  readonly allowDig?: boolean;
  readonly maxExpandedStates?: number;
  readonly maxActionDepth?: number;
}): TerrainRoutePlanResult {
  const diagnostics: string[] = [];
  const maxExpanded = input.maxExpandedStates ?? DEFAULT_MAX_EXPANDED;
  const minActionDepth =
    Math.ceil(
      Math.hypot(input.targetFoot.x - input.startFoot.x, input.targetFoot.z - input.startFoot.z),
    ) +
    Math.abs(input.targetFoot.y - input.startFoot.y) +
    24;
  const maxDepth = input.maxActionDepth ?? Math.max(DEFAULT_MAX_ACTION_DEPTH, minActionDepth);
  const minVerticalBudget = Math.abs(input.targetFoot.y - input.startFoot.y) + 16;
  const maxPlannedSolid = Math.max(DEFAULT_MAX_PLANNED_SOLID, minVerticalBudget);
  const goalRange = input.goalRange ?? 1.5;

  const startNode: SearchNode = {
    foot: freezePos(input.startFoot),
    plannedAir: new Set<string>(),
    plannedSolid: new Set<string>(),
    cost: 0,
    priority: routeHeuristic(input.startFoot, input.targetFoot, goalRange),
    parent: null,
    action: null,
    lastDir: null,
    depth: 0,
  };

  if (isGoal(startNode.foot, input.targetFoot, goalRange)) {
    diagnostics.push("terrain_bfs_solved:cost=0;actions=0;expanded=0");
    return {
      plan: {
        actions: Object.freeze([]),
        finalFoot: freezePos(startNode.foot),
        cost: 0,
      },
      diagnostics: Object.freeze(diagnostics),
      expandedStates: 0,
    };
  }

  const open = new MinHeap<SearchNode>((left, right) =>
    left.priority === right.priority ? left.cost - right.cost : left.priority - right.priority,
  );
  open.push(startNode);
  const visited = new Map<string, number>();
  visited.set(stateKey(startNode), 0);

  let expanded = 0;
  let bestNode = startNode;
  let bestScore = goalDistanceScore(startNode.foot, input.targetFoot, goalRange);
  while (!open.isEmpty() && expanded < maxExpanded) {
    const node = open.pop();
    if (node === undefined) break;
    expanded += 1;
    const nodeScore = goalDistanceScore(node.foot, input.targetFoot, goalRange);
    if (nodeScore < bestScore || (nodeScore === bestScore && node.cost < bestNode.cost)) {
      bestNode = node;
      bestScore = nodeScore;
    }

    if (isGoal(node.foot, input.targetFoot, goalRange)) {
      const actions = reconstructActions(node);
      diagnostics.push(
        `terrain_bfs_solved:cost=${node.cost};actions=${actions.length};expanded=${expanded};foot=${posLabel(node.foot)}`,
      );
      diagnostics.push(...summarizeActions(actions));
      return {
        plan: {
          actions,
          finalFoot: freezePos(node.foot),
          cost: node.cost,
        },
        diagnostics: Object.freeze(diagnostics),
        expandedStates: expanded,
      };
    }

    if (node.depth >= maxDepth) continue;
    if (node.plannedAir.size >= DEFAULT_MAX_PLANNED_AIR) continue;
    if (node.plannedSolid.size >= maxPlannedSolid) continue;
    if (node.plannedAir.size + node.plannedSolid.size >= DEFAULT_MAX_TOTAL_PLANNED_CHANGES) {
      continue;
    }

    for (const successor of expandSuccessors(input, node, goalRange)) {
      const key = stateKey(successor);
      const seen = visited.get(key);
      if (seen !== undefined && seen <= successor.cost) continue;
      visited.set(key, successor.cost);
      open.push(successor);
    }
  }

  diagnostics.push(
    `terrain_bfs_no_path:expanded=${expanded};max_expanded=${maxExpanded};open=${open.size()};best=${posLabel(bestNode.foot)};best_score=${bestScore};best_cost=${bestNode.cost};max_depth=${maxDepth};max_air=${DEFAULT_MAX_PLANNED_AIR};max_solid=${maxPlannedSolid};max_total=${DEFAULT_MAX_TOTAL_PLANNED_CHANGES};costs=walk:${COST_WALK},drop1:${COST_DROP1},jumpUp:${COST_JUMP_UP},terrainChangeBase:${COST_TERRAIN_CHANGE_BASE},terrainChangePerBlock:${COST_TERRAIN_CHANGE_PER_BLOCK},placeItemPenalty:${COST_PLACE_UP_ITEM_PENALTY}`,
  );
  return {
    plan: null,
    diagnostics: Object.freeze(diagnostics),
    expandedStates: expanded,
  };
}

function expandSuccessors(
  input: {
    readonly bot: MineflayerMiningPort & MineflayerPlacementPort;
    readonly facts: MineBlockFactReader;
    readonly targetFoot: TerrainBlockPos;
    readonly allowPlaceUp?: boolean;
    readonly allowDig?: boolean;
  },
  node: SearchNode,
  goalRange: number,
): SearchNode[] {
  const out: SearchNode[] = [];
  const fy = node.foot.y;
  const allowDig = input.allowDig ?? true;
  const allowPlaceUp = input.allowPlaceUp ?? true;

  for (const dir of DIRECTIONS) {
    const vec = DIR_VEC[dir];
    const turn = node.lastDir !== null && node.lastDir !== dir ? COST_TURN_PENALTY : 0;
    const fx = node.foot.x + vec.dx;
    const fz = node.foot.z + vec.dz;

    const walkFoot = freezePos({ x: fx, y: fy, z: fz });
    if (
      isWalkableSupport(input.bot, input.facts, { x: fx, y: fy - 1, z: fz }, node) &&
      hasClearance(input.bot, input.facts, walkFoot, BODY_CLEARANCE, node)
    ) {
      pushSuccessor(
        out,
        node,
        { kind: "walk", toFoot: walkFoot, dir },
        COST_WALK + turn,
        input.targetFoot,
        goalRange,
      );
    }

    const dropFoot = freezePos({ x: fx, y: fy - 1, z: fz });
    if (
      hasClearance(input.bot, input.facts, node.foot, JUMP_CLEARANCE, node) &&
      hasClearance(input.bot, input.facts, dropFoot, JUMP_CLEARANCE, node) &&
      isWalkableSupport(input.bot, input.facts, { x: fx, y: fy - 2, z: fz }, node)
    ) {
      pushSuccessor(
        out,
        node,
        { kind: "drop1", toFoot: dropFoot, dir },
        COST_DROP1 + turn,
        input.targetFoot,
        goalRange,
      );
    }

    const upFoot = freezePos({ x: fx, y: fy + 1, z: fz });
    if (
      hasClearance(input.bot, input.facts, node.foot, JUMP_CLEARANCE, node) &&
      isWalkableSupport(input.bot, input.facts, { x: fx, y: fy, z: fz }, node) &&
      hasClearance(input.bot, input.facts, upFoot, JUMP_CLEARANCE, node)
    ) {
      pushSuccessor(
        out,
        node,
        { kind: "jumpUp", toFoot: upFoot, dir },
        COST_JUMP_UP + turn,
        input.targetFoot,
        goalRange,
      );
    }

    const placeAt = freezePos({ x: node.foot.x, y: fy, z: node.foot.z });
    const placeSupport = freezePos({ x: node.foot.x, y: fy - 1, z: node.foot.z });
    const placeTargetFoot = freezePos({ x: node.foot.x, y: fy + 1, z: node.foot.z });
    if (allowPlaceUp && isWalkableSupport(input.bot, input.facts, placeSupport, node)) {
      const placeDigs = allowDig
        ? collectClearanceDigs(
            input.bot,
            input.facts,
            [
              ...clearancePositions(node.foot, JUMP_CLEARANCE),
              ...clearancePositions(placeTargetFoot, JUMP_CLEARANCE),
            ],
            node,
          )
        : hasClearance(input.bot, input.facts, node.foot, JUMP_CLEARANCE, node) &&
            hasClearance(input.bot, input.facts, placeTargetFoot, JUMP_CLEARANCE, node)
          ? Object.freeze([])
          : null;

      if (
        placeDigs !== null &&
        hasClearance(input.bot, input.facts, node.foot, BODY_CLEARANCE, node)
      ) {
        pushSuccessor(
          out,
          node,
          {
            kind: "placeUp1",
            toFoot: placeTargetFoot,
            dir,
            placeAt,
            support: placeSupport,
            digs: placeDigs,
          },
          COST_TERRAIN_CHANGE_BASE +
            COST_TERRAIN_CHANGE_PER_BLOCK * placeDigs.length +
            COST_PLACE_UP_ITEM_PENALTY +
            turn,
          input.targetFoot,
          goalRange,
        );
      }
    }

    if (!allowDig) continue;

    const bodyPos = freezePos({ x: fx, y: fy, z: fz });
    const headPos = freezePos({ x: fx, y: fy + 1, z: fz });
    const supportPos = freezePos({ x: fx, y: fy - 1, z: fz });
    if (isWalkableSupport(input.bot, input.facts, supportPos, node)) {
      const digs = collectClearanceDigs(input.bot, input.facts, [bodyPos, headPos], node);
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
          COST_TERRAIN_CHANGE_BASE + COST_TERRAIN_CHANGE_PER_BLOCK * digs.length + turn,
          input.targetFoot,
          goalRange,
        );
      }
    }

    const currentTop = freezePos({ x: node.foot.x, y: fy + 2, z: node.foot.z });
    const stepDownFoot = freezePos({ x: fx, y: fy - 1, z: fz });
    const stepDownSupport = freezePos({ x: fx, y: fy - 2, z: fz });
    const stepDownDigs = collectClearanceDigs(
      input.bot,
      input.facts,
      [currentTop, ...clearancePositions(stepDownFoot, JUMP_CLEARANCE)],
      node,
    );
    if (
      stepDownDigs !== null &&
      stepDownDigs.length > 0 &&
      hasClearance(input.bot, input.facts, node.foot, BODY_CLEARANCE, node) &&
      isWalkableSupport(input.bot, input.facts, stepDownSupport, node)
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
        COST_TERRAIN_CHANGE_BASE +
          COST_TERRAIN_CHANGE_PER_BLOCK * stepDownDigs.length +
          COST_DROP1 +
          turn,
        input.targetFoot,
        goalRange,
      );
    }

    const stepUpFoot = freezePos({ x: fx, y: fy + 1, z: fz });
    const stepUpSupport = freezePos({ x: fx, y: fy, z: fz });
    const stepUpDigs = collectClearanceDigs(
      input.bot,
      input.facts,
      [currentTop, ...clearancePositions(stepUpFoot, JUMP_CLEARANCE)],
      node,
    );
    if (
      stepUpDigs !== null &&
      stepUpDigs.length > 0 &&
      hasClearance(input.bot, input.facts, node.foot, BODY_CLEARANCE, node) &&
      isWalkableSupport(input.bot, input.facts, stepUpSupport, node)
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
        COST_TERRAIN_CHANGE_BASE +
          COST_TERRAIN_CHANGE_PER_BLOCK * stepUpDigs.length +
          COST_JUMP_UP +
          turn,
        input.targetFoot,
        goalRange,
      );
    }
  }

  return out;
}

function pushSuccessor(
  out: SearchNode[],
  parent: SearchNode,
  action: TerrainRouteAction,
  cost: number,
  targetFoot: TerrainBlockPos,
  goalRange: number,
): void {
  const digs = "digs" in action ? action.digs : [];
  let plannedAir: ReadonlySet<string> = parent.plannedAir;
  if (digs.length > 0) {
    const next = new Set(parent.plannedAir);
    for (const dig of digs) next.add(positionKey(dig));
    plannedAir = next;
  }

  let plannedSolid: ReadonlySet<string> = parent.plannedSolid;
  if (action.kind === "placeUp1") {
    const placeKey = positionKey(action.placeAt);
    const nextAir = new Set(plannedAir);
    nextAir.delete(placeKey);
    plannedAir = nextAir;

    const next = new Set(parent.plannedSolid);
    next.add(placeKey);
    plannedSolid = next;
  }

  const nextCost = parent.cost + cost;
  out.push({
    foot: action.toFoot,
    plannedAir,
    plannedSolid,
    cost: nextCost,
    priority: nextCost + routeHeuristic(action.toFoot, targetFoot, goalRange),
    parent,
    action,
    lastDir: action.dir,
    depth: parent.depth + 1,
  });
}

function reconstructActions(node: SearchNode): readonly TerrainRouteAction[] {
  const actions: TerrainRouteAction[] = [];
  let current: SearchNode | null = node;
  while (current !== null && current.action !== null) {
    actions.unshift(current.action);
    current = current.parent;
  }
  return Object.freeze(actions);
}

function summarizeActions(actions: readonly TerrainRouteAction[]): readonly string[] {
  const counts = new Map<string, number>();
  for (const action of actions) {
    counts.set(action.kind, (counts.get(action.kind) ?? 0) + 1);
  }
  return Object.freeze(
    [...counts.entries()].map(([kind, count]) => `terrain_bfs_action:${kind}:${count}`),
  );
}

function isGoal(current: TerrainBlockPos, target: TerrainBlockPos, range: number): boolean {
  return Math.hypot(current.x - target.x, current.z - target.z) <= range && current.y === target.y;
}

function routeHeuristic(current: TerrainBlockPos, target: TerrainBlockPos, range: number): number {
  const horizontalSteps = Math.max(
    0,
    Math.ceil(Math.hypot(current.x - target.x, current.z - target.z) - range),
  );
  const dy = target.y - current.y;
  const placeUpCost = COST_TERRAIN_CHANGE_BASE + COST_PLACE_UP_ITEM_PENALTY;
  const verticalCost = dy > 0 ? dy * placeUpCost : Math.abs(dy) * COST_DROP1;
  return horizontalSteps * COST_WALK + verticalCost;
}

function goalDistanceScore(
  current: TerrainBlockPos,
  target: TerrainBlockPos,
  range: number,
): number {
  const horizontalMiss = Math.max(
    0,
    Math.hypot(current.x - target.x, current.z - target.z) - range,
  );
  return Math.abs(current.y - target.y) * 1000 + horizontalMiss;
}

function stateKey(node: SearchNode): string {
  const foot = positionKey(node.foot);
  const air = node.plannedAir.size === 0 ? "" : `a=${Array.from(node.plannedAir).sort().join("|")}`;
  const solid =
    node.plannedSolid.size === 0 ? "" : `s=${Array.from(node.plannedSolid).sort().join("|")}`;
  return `${foot}#${air}#${solid}`;
}

function positionKey(pos: TerrainBlockPos): string {
  return `${pos.x}:${pos.y}:${pos.z}`;
}

function freezePos(pos: TerrainBlockPos): TerrainBlockPos {
  return Object.freeze({ x: pos.x, y: pos.y, z: pos.z });
}

function isPassable(
  bot: MineflayerMiningPort,
  facts: MineBlockFactReader,
  pos: TerrainBlockPos,
  node: SearchNode,
): boolean {
  const key = positionKey(pos);
  if (node.plannedSolid.has(key)) return false;
  if (node.plannedAir.has(key)) return true;
  const block = readMineflayerBlockAt(bot, pos);
  if (block === null || block === undefined) return false;
  return facts.isAirBlock(block);
}

function isWalkableSupport(
  bot: MineflayerMiningPort,
  facts: MineBlockFactReader,
  pos: TerrainBlockPos,
  node: SearchNode,
): boolean {
  const key = positionKey(pos);
  if (node.plannedSolid.has(key)) return true;
  if (node.plannedAir.has(key)) return false;
  const block = readMineflayerBlockAt(bot, pos);
  if (block === null || block === undefined) return false;
  return facts.isSupportBlock(block);
}

function clearancePositions(foot: TerrainBlockPos, height: number): readonly TerrainBlockPos[] {
  return Object.freeze(
    Array.from({ length: height }, (_, dy) => freezePos({ x: foot.x, y: foot.y + dy, z: foot.z })),
  );
}

function hasClearance(
  bot: MineflayerMiningPort,
  facts: MineBlockFactReader,
  foot: TerrainBlockPos,
  height: number,
  node: SearchNode,
): boolean {
  return clearancePositions(foot, height).every((pos) => isPassable(bot, facts, pos, node));
}

function collectClearanceDigs(
  bot: MineflayerMiningPort,
  facts: MineBlockFactReader,
  positions: readonly TerrainBlockPos[],
  node: SearchNode,
): readonly TerrainBlockPos[] | null {
  const digs: TerrainBlockPos[] = [];
  const seen = new Set<string>();
  for (const pos of positions) {
    const key = positionKey(pos);
    if (seen.has(key)) continue;
    seen.add(key);
    if (isPassable(bot, facts, pos, node)) continue;
    if (!canDigBlock(bot, facts, pos, node)) return null;
    digs.push(freezePos(pos));
  }
  return Object.freeze(digs);
}

function canDigBlock(
  bot: MineflayerMiningPort,
  facts: MineBlockFactReader,
  pos: TerrainBlockPos,
  node: SearchNode,
): boolean {
  const key = positionKey(pos);
  if (node.plannedAir.has(key) || node.plannedSolid.has(key)) return false;
  const block = readMineflayerBlockAt(bot, pos);
  if (block === null || block === undefined) return false;
  return facts.isDiggableBlock(block);
}

function posLabel(pos: TerrainBlockPos): string {
  return `${pos.x},${pos.y},${pos.z}`;
}

class MinHeap<T> {
  private readonly data: T[] = [];
  constructor(private readonly compare: (left: T, right: T) => number) {}

  isEmpty(): boolean {
    return this.data.length === 0;
  }

  size(): number {
    return this.data.length;
  }

  push(item: T): void {
    this.data.push(item);
    this.bubbleUp(this.data.length - 1);
  }

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

  private bubbleDown(index: number): void {
    const length = this.data.length;
    let cursor = index;
    while (true) {
      const left = cursor * 2 + 1;
      const right = cursor * 2 + 2;
      let smallest = cursor;
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
