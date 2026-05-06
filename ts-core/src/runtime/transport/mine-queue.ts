import type { MineSkillTargetCandidate } from "../../core-ports/skills.js";
import type {
  StairBFSBlock,
  StairBFSBlockPos,
  StairBFSDirection,
  StairBFSPlanFailure,
  StairBFSPlanSuccess,
  StairBFSRoute,
  StairBFSWorldScanner,
} from "../../domain/stair-bfs-planner.js";
import {
  createDefaultStairBFSSafetyChecker,
  createStairBFSPlanner,
} from "../../domain/stair-bfs-planner.js";
import type { MineBlockFactReader } from "./mine-block-facts.js";
import type {
  MineflayerInventoryPort,
  MineflayerMiningPort,
  MineflayerMovementPort,
} from "./types.js";
import { readMineflayerBlockAt } from "./world-reader.js";

const STAIR_PLAN_MAX_STEPS = 16;
const STAIR_PLAN_MAX_EXPANDED_STATES = 512;
const MINE_QUEUE_MAX_SEGMENTS = 48;
const EXISTING_TUNNEL_MAX_WALK_STEPS = 32;
const ROUTE_STEP_COST = 10;
const ROUTE_DIG_COST = 120;
const ROUTE_TURN_COST = 6;
const ROUTE_HEIGHT_CHANGE_COST = 4;
const MINE_START_COLUMN_SEARCH_RADIUS = 1;

export interface PlannedMineQueue {
  readonly phase: "no_fill" | "fill";
  readonly actions: readonly PlannedMineAction[];
  readonly targetDigCount: number;
}

export interface PlannedMineAction {
  readonly kind: "move" | "dig";
  readonly pos: StairBFSBlockPos;
  readonly standingPos?: StairBFSBlockPos;
  readonly blockName?: string;
  readonly countsTowardTarget?: boolean;
}

export interface MineQueuePlanResult {
  readonly queue: PlannedMineQueue | null;
  readonly diagnostics: readonly string[];
}

type MineQueueBot = MineflayerMovementPort & MineflayerMiningPort & MineflayerInventoryPort;

/** 构建 mine（挖掘） 队列；ore（矿石）目标由 ResourceService（资源服务）传入，不在 runtime（运行时）重扫。 */
export function planMineQueue(input: {
  readonly bot: MineQueueBot;
  readonly facts: MineBlockFactReader;
  readonly blockName: string;
  readonly requiredTargetCount: number;
  readonly targets?: readonly MineSkillTargetCandidate[];
}): PlannedMineQueue | null {
  return planMineQueueWithDiagnostics(input).queue;
}

export function planMineQueueWithDiagnostics(input: {
  readonly bot: MineQueueBot;
  readonly facts: MineBlockFactReader;
  readonly blockName: string;
  readonly requiredTargetCount: number;
  readonly targets?: readonly MineSkillTargetCandidate[];
}): MineQueuePlanResult {
  const diagnostics: string[] = [];
  const startCandidates = listMineQueueStartFootCandidates(input);
  pushPlanDiagnostic(
    diagnostics,
    `mine_queue_start_candidates:${startCandidates.map(positionKey).join("|")}`,
  );
  const targets = input.targets;
  const queue =
    targets === undefined
      ? planOrdinaryMineQueue({ ...input, startCandidates, diagnostics })
      : planTargetedMineQueue({ ...input, targets, startCandidates, diagnostics });

  return Object.freeze({
    queue,
    diagnostics: Object.freeze(diagnostics),
  });
}

export function readBotFootPosition(bot: MineQueueBot): StairBFSBlockPos {
  const position = bot.entity?.position ?? { x: 0, y: 0, z: 0 };
  return freezePos({
    x: Math.floor(position.x),
    y: Math.floor(position.y),
    z: Math.floor(position.z),
  });
}

function planTargetedMineQueue(input: {
  readonly bot: MineQueueBot;
  readonly facts: MineBlockFactReader;
  readonly blockName: string;
  readonly requiredTargetCount: number;
  readonly targets: readonly MineSkillTargetCandidate[];
  readonly startCandidates: readonly StairBFSBlockPos[];
  readonly diagnostics: string[];
}): PlannedMineQueue | null {
  let bestPartial: PlannedMineQueue | null = null;
  for (const origin of input.startCandidates) {
    const queue = planTargetedMineQueueFromOrigin(input, origin, input.diagnostics);
    if (queue === null) {
      pushPlanDiagnostic(
        input.diagnostics,
        `mine_queue_target_origin_failed:${positionKey(origin)}`,
      );
      continue;
    }
    if (queue.targetDigCount >= input.requiredTargetCount) {
      return queue;
    }
    bestPartial = bestPartial ?? queue;
  }

  return bestPartial;
}

function planTargetedMineQueueFromOrigin(
  input: {
    readonly bot: MineQueueBot;
    readonly facts: MineBlockFactReader;
    readonly blockName: string;
    readonly requiredTargetCount: number;
    readonly targets: readonly MineSkillTargetCandidate[];
  },
  origin: StairBFSBlockPos,
  diagnostics: string[],
): PlannedMineQueue | null {
  const targets = input.targets
    .filter((target) => input.facts.normalizeName(target.block_name) === input.blockName)
    .filter((target) => {
      const block = readMineflayerBlockAt(input.bot, target.position);
      return input.facts.normalizeName(block?.name) === input.blockName;
    })
    .sort((left, right) => distance(origin, left.position) - distance(origin, right.position));
  const plannedAir = new Set<string>();
  const actions: PlannedMineAction[] = [];
  let current = origin;
  let targetDigCount = 0;
  let phase: PlannedMineQueue["phase"] = "no_fill";

  for (const target of targets) {
    const plan = planRouteToTargetStandingPosition({
      bot: input.bot,
      facts: input.facts,
      blockName: input.blockName,
      startFoot: current,
      target: freezePos(target.position),
      plannedAir,
      diagnostics,
    });
    if (plan === null) {
      continue;
    }
    phase = plan.route.phase;
    actions.push(...plan.actions);
    actions.push({
      kind: "dig",
      pos: freezePos(target.position),
      standingPos: plan.standingPos,
      blockName: input.blockName,
      countsTowardTarget: true,
    });
    plannedAir.add(positionKey(target.position));
    current = plan.standingPos;
    targetDigCount += 1;
    if (targetDigCount >= input.requiredTargetCount) {
      break;
    }
  }

  if (targetDigCount <= 0) {
    return null;
  }

  return Object.freeze({
    phase,
    actions: Object.freeze(actions),
    targetDigCount,
  });
}

function planOrdinaryMineQueue(input: {
  readonly bot: MineQueueBot;
  readonly facts: MineBlockFactReader;
  readonly blockName: string;
  readonly requiredTargetCount: number;
  readonly startCandidates: readonly StairBFSBlockPos[];
  readonly diagnostics: string[];
}): PlannedMineQueue | null {
  for (const origin of input.startCandidates) {
    const queue = planOrdinaryMineQueueFromOrigin(input, origin, input.diagnostics);
    if (queue !== null) {
      return queue;
    }
    pushPlanDiagnostic(input.diagnostics, `mine_queue_origin_failed:${positionKey(origin)}`);
  }

  return null;
}

function planOrdinaryMineQueueFromOrigin(
  input: {
    readonly bot: MineQueueBot;
    readonly facts: MineBlockFactReader;
    readonly blockName: string;
    readonly requiredTargetCount: number;
  },
  origin: StairBFSBlockPos,
  diagnostics: string[],
): PlannedMineQueue | null {
  const plannedAir = new Set<string>();
  const actions: PlannedMineAction[] = [];
  let current = origin;
  let currentDir: StairBFSDirection | null = null;
  let reusedTunnelWalkSteps = 0;
  let allowExistingTunnelWalk = true;
  let phase: PlannedMineQueue["phase"] = "no_fill";
  let targetDigCount = 0;

  for (
    let segmentIndex = 0;
    segmentIndex < MINE_QUEUE_MAX_SEGMENTS && targetDigCount < input.requiredTargetCount;
    segmentIndex += 1
  ) {
    const segment = findNextExplorationSegment({
      ...input,
      startFoot: current,
      startDirections: currentDir === null ? STAIR_EXPLORATION_DIRECTIONS : [currentDir],
      plannedAir,
      rejectExistingTunnelRoute: !allowExistingTunnelWalk,
      diagnostics,
    });
    if (segment === null) {
      break;
    }
    phase = segment.phase;
    const segmentTargetDigCount = countRouteTargetDigs(segment, input);
    const reusesExistingTunnel =
      usesExistingTunnelRoute(segment.route) ||
      (reusedTunnelWalkSteps > 0 && segmentTargetDigCount === 0);
    if (
      allowExistingTunnelWalk &&
      reusesExistingTunnel &&
      reusedTunnelWalkSteps + segment.route.steps.length > EXISTING_TUNNEL_MAX_WALK_STEPS
    ) {
      plannedAir.clear();
      actions.splice(0, actions.length);
      current = origin;
      currentDir = null;
      reusedTunnelWalkSteps = 0;
      allowExistingTunnelWalk = false;
      targetDigCount = 0;
      phase = "no_fill";
      continue;
    }

    const queue = appendPlanActions({
      bot: input.bot,
      facts: input.facts,
      blockName: input.blockName,
      plan: segment,
      requiredTargetCount: input.requiredTargetCount - targetDigCount,
      plannedAir,
    });
    if (queue === null) {
      return null;
    }

    actions.push(...queue.actions);
    targetDigCount += queue.targetDigCount;
    current = queue.endFoot;
    currentDir = segment.route.states.at(-1)?.dir ?? currentDir;
    if (reusesExistingTunnel) {
      reusedTunnelWalkSteps += segment.route.steps.length;
    } else {
      reusedTunnelWalkSteps = 0;
    }
  }

  if (targetDigCount < input.requiredTargetCount) {
    return null;
  }

  return Object.freeze({
    phase,
    actions: Object.freeze(actions),
    targetDigCount,
  });
}

function findNextExplorationSegment(input: {
  readonly bot: MineQueueBot;
  readonly facts: MineBlockFactReader;
  readonly blockName: string;
  readonly startFoot: StairBFSBlockPos;
  readonly startDirections: readonly StairBFSDirection[];
  readonly plannedAir: ReadonlySet<string>;
  readonly rejectExistingTunnelRoute: boolean;
  readonly diagnostics?: string[];
}): StairBFSPlanSuccess | null {
  const plans = input.startDirections.flatMap((direction) => {
    const plan = createStairBFSPlanner().plan({
      scanner: createMineflayerStairScanner(
        input.bot,
        input.facts,
        input.blockName,
        input.plannedAir,
      ),
      start: {
        pos: input.startFoot,
        dir: direction,
        mode: "down",
        usedFill: 0,
      },
      goal: {
        yAtMost: input.startFoot.y - 1,
        minSteps: 1,
      },
      maxSteps: STAIR_PLAN_MAX_STEPS,
      maxExpandedStates: STAIR_PLAN_MAX_EXPANDED_STATES,
      maxFillBlocks: 0,
    });

    if (!plan.ok) {
      pushPlanFailureDiagnostic(input.diagnostics, input.startFoot, direction, plan);
      return [];
    }
    if (input.rejectExistingTunnelRoute && usesExistingTunnelRoute(plan.route)) {
      return [];
    }

    return [plan];
  });

  return (
    plans.sort((left, right) => {
      const costDelta = calculateRouteCost(left.route) - calculateRouteCost(right.route);
      if (costDelta !== 0) {
        return costDelta;
      }

      const targetCountDelta =
        countRouteTargetDigs(right, input) - countRouteTargetDigs(left, input);
      if (targetCountDelta !== 0) {
        return targetCountDelta;
      }

      return left.route.steps.length - right.route.steps.length;
    })[0] ?? null
  );
}

function appendPlanActions(input: {
  readonly bot: MineQueueBot;
  readonly facts: MineBlockFactReader;
  readonly blockName: string;
  readonly plan: StairBFSPlanSuccess;
  readonly requiredTargetCount: number;
  readonly plannedAir: Set<string>;
}): {
  readonly actions: readonly PlannedMineAction[];
  readonly targetDigCount: number;
  readonly endFoot: StairBFSBlockPos;
} | null {
  const actions: PlannedMineAction[] = [];
  let targetDigCount = 0;
  let endFoot = input.plan.route.steps[0]?.from.pos ?? readBotFootPosition(input.bot);

  for (const step of input.plan.route.steps) {
    if (step.fill.length > 0) {
      return null;
    }

    actions.push({ kind: "move", pos: step.from.pos });
    let completedTargetCount = false;
    let stoppedBeforeStepClear = false;
    for (const [digIndex, digPosition] of sortDigPositionsForExecution(step.dig).entries()) {
      const key = positionKey(digPosition);
      if (input.plannedAir.has(key)) {
        continue;
      }

      const block = readMineflayerBlockAt(input.bot, digPosition);
      const currentBlockName = input.facts.normalizeName(block?.name);
      if (block === null || block === undefined || currentBlockName === "air") {
        input.plannedAir.add(key);
        continue;
      }

      const countsTowardTarget = currentBlockName === input.blockName;
      if (countsTowardTarget && targetDigCount >= input.requiredTargetCount) {
        completedTargetCount = true;
        stoppedBeforeStepClear = true;
        break;
      }

      actions.push({
        kind: "dig",
        pos: freezePos(digPosition),
        blockName: currentBlockName,
        countsTowardTarget,
      });
      input.plannedAir.add(key);
      if (countsTowardTarget) {
        targetDigCount += 1;
      }
      if (targetDigCount >= input.requiredTargetCount) {
        completedTargetCount = true;
        stoppedBeforeStepClear = digIndex < step.dig.length - 1;
        break;
      }
    }
    if (completedTargetCount) {
      if (!stoppedBeforeStepClear) {
        actions.push({ kind: "move", pos: step.to.pos });
        endFoot = step.to.pos;
      }
      break;
    }
    actions.push({ kind: "move", pos: step.to.pos });
    endFoot = step.to.pos;
  }

  return Object.freeze({
    actions: Object.freeze(actions),
    targetDigCount,
    endFoot,
  });
}

function planRouteToTargetStandingPosition(input: {
  readonly bot: MineQueueBot;
  readonly facts: MineBlockFactReader;
  readonly blockName: string;
  readonly startFoot: StairBFSBlockPos;
  readonly target: StairBFSBlockPos;
  readonly plannedAir: Set<string>;
  readonly diagnostics: string[];
}): {
  readonly route: StairBFSPlanSuccess;
  readonly standingPos: StairBFSBlockPos;
  readonly actions: readonly PlannedMineAction[];
} | null {
  for (const standingPos of listTargetStandingPositions(input.target, input.startFoot)) {
    if (samePos(standingPos, input.startFoot)) {
      const startState = Object.freeze({
        pos: freezePos(input.startFoot),
        dir: chooseDirectionToward(input.startFoot, input.target),
        mode: "down" as const,
        usedFill: 0,
      });

      return Object.freeze({
        route: Object.freeze({
          ok: true as const,
          phase: "no_fill" as const,
          route: Object.freeze({
            states: Object.freeze([startState]),
            steps: Object.freeze([]),
          }),
          diagnostics: Object.freeze({
            exploredStates: 0,
            rejectedSteps: Object.freeze([]),
          }),
        }),
        standingPos,
        actions: Object.freeze([]),
      });
    }

    const route = createStairBFSPlanner().plan({
      scanner: createMineflayerStairScanner(
        input.bot,
        input.facts,
        input.blockName,
        input.plannedAir,
      ),
      start: {
        pos: input.startFoot,
        dir: chooseDirectionToward(input.startFoot, standingPos),
        mode: standingPos.y >= input.startFoot.y ? "up" : "down",
        usedFill: 0,
      },
      goal: {
        target: standingPos,
      },
      maxSteps: STAIR_PLAN_MAX_STEPS,
      maxExpandedStates: STAIR_PLAN_MAX_EXPANDED_STATES,
      maxFillBlocks: 0,
    });
    if (!route.ok) {
      pushPlanFailureDiagnostic(
        input.diagnostics,
        input.startFoot,
        chooseDirectionToward(input.startFoot, standingPos),
        route,
      );
      continue;
    }

    const actions = appendRouteClearActions({
      bot: input.bot,
      facts: input.facts,
      plan: route,
      plannedAir: input.plannedAir,
      forbiddenDig: input.target,
    });
    if (actions === null) {
      continue;
    }

    return Object.freeze({
      route,
      standingPos,
      actions,
    });
  }

  return null;
}

function appendRouteClearActions(input: {
  readonly bot: MineQueueBot;
  readonly facts: MineBlockFactReader;
  readonly plan: StairBFSPlanSuccess;
  readonly plannedAir: Set<string>;
  readonly forbiddenDig: StairBFSBlockPos;
}): readonly PlannedMineAction[] | null {
  const actions: PlannedMineAction[] = [];

  for (const step of input.plan.route.steps) {
    if (step.fill.length > 0) {
      return null;
    }

    actions.push({ kind: "move", pos: step.from.pos });
    for (const digPosition of sortDigPositionsForExecution(step.dig)) {
      if (samePos(digPosition, input.forbiddenDig)) {
        return null;
      }

      const key = positionKey(digPosition);
      if (input.plannedAir.has(key)) {
        continue;
      }

      const block = readMineflayerBlockAt(input.bot, digPosition);
      const currentBlockName = input.facts.normalizeName(block?.name);
      if (block === null || block === undefined || currentBlockName === "air") {
        input.plannedAir.add(key);
        continue;
      }

      actions.push({
        kind: "dig",
        pos: freezePos(digPosition),
        blockName: currentBlockName,
        countsTowardTarget: false,
      });
      input.plannedAir.add(key);
    }
    actions.push({ kind: "move", pos: step.to.pos });
  }

  return Object.freeze(actions);
}

function createMineflayerStairScanner(
  bot: MineQueueBot,
  facts: MineBlockFactReader,
  targetBlockName: string,
  plannedAir: ReadonlySet<string> = new Set(),
): StairBFSWorldScanner {
  return Object.freeze({
    getBlock(pos: Readonly<StairBFSBlockPos>): StairBFSBlock | undefined {
      if (plannedAir.has(positionKey(pos))) {
        return Object.freeze({
          pos: freezePos(pos),
          role: "air",
        });
      }

      const block = readMineflayerBlockAt(bot, pos);
      if (block === null || block === undefined) {
        return undefined;
      }

      return Object.freeze({
        pos: freezePos(pos),
        role: facts.classifyBlockRole(block, targetBlockName),
      });
    },
  });
}

function listMineQueueStartFootCandidates(input: {
  readonly bot: MineQueueBot;
  readonly facts: MineBlockFactReader;
  readonly blockName: string;
}): readonly StairBFSBlockPos[] {
  const base = readBotFootPosition(input.bot);
  const position = input.bot.entity?.position;
  if (position === undefined) {
    return Object.freeze([base]);
  }

  const scanner = createMineflayerStairScanner(input.bot, input.facts, input.blockName);
  const checker = createDefaultStairBFSSafetyChecker();
  const candidates = listNearbyStartFootCandidates(position, base).filter((candidate) =>
    STAIR_EXPLORATION_DIRECTIONS.some((direction) => {
      const validation = checker.isValidStep({
        scanner,
        current: {
          pos: candidate,
          dir: direction,
          mode: "down",
          usedFill: 0,
        },
        next: candidate,
        nextDir: direction,
        heightDelta: 0,
        allowFill: false,
        maxFillBlocks: 0,
      });
      return validation.ok && validation.dig.length === 0 && validation.fill.length === 0;
    }),
  );

  return candidates.length > 0 ? Object.freeze(candidates) : Object.freeze([base]);
}

function listNearbyStartFootCandidates(
  position: Readonly<{ readonly x: number; readonly y: number; readonly z: number }>,
  base: Readonly<StairBFSBlockPos>,
): readonly StairBFSBlockPos[] {
  const candidates: StairBFSBlockPos[] = [];
  const seen = new Set<string>();
  const minY = Math.floor(position.y) - 1;
  const maxY = Math.ceil(position.y) + 1;
  for (let y = minY; y <= maxY; y += 1) {
    for (
      let dx = -MINE_START_COLUMN_SEARCH_RADIUS;
      dx <= MINE_START_COLUMN_SEARCH_RADIUS;
      dx += 1
    ) {
      for (
        let dz = -MINE_START_COLUMN_SEARCH_RADIUS;
        dz <= MINE_START_COLUMN_SEARCH_RADIUS;
        dz += 1
      ) {
        const candidate = freezePos({ x: base.x + dx, y, z: base.z + dz });
        const key = positionKey(candidate);
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        candidates.push(candidate);
      }
    }
  }

  return Object.freeze(
    candidates.sort((left, right) => {
      const distanceDelta =
        distanceToFootCenter(position, left) - distanceToFootCenter(position, right);
      if (distanceDelta !== 0) {
        return distanceDelta;
      }
      return samePos(left, base) ? -1 : samePos(right, base) ? 1 : 0;
    }),
  );
}

function distanceToFootCenter(
  position: Readonly<{ readonly x: number; readonly y: number; readonly z: number }>,
  foot: Readonly<StairBFSBlockPos>,
): number {
  return Math.hypot(position.x - (foot.x + 0.5), position.y - foot.y, position.z - (foot.z + 0.5));
}

function chooseDirectionToward(
  from: Readonly<StairBFSBlockPos>,
  to: Readonly<StairBFSBlockPos>,
): StairBFSDirection {
  const dx = to.x - from.x;
  const dz = to.z - from.z;

  if (Math.abs(dx) >= Math.abs(dz)) {
    return dx >= 0 ? "east" : "west";
  }

  return dz >= 0 ? "south" : "north";
}

function distance(left: Readonly<StairBFSBlockPos>, right: Readonly<StairBFSBlockPos>): number {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

function calculateRouteCost(route: Readonly<StairBFSRoute>): number {
  return route.steps.reduce(
    (sum, step) =>
      sum +
      ROUTE_STEP_COST +
      step.dig.length * ROUTE_DIG_COST +
      (step.from.dir === step.to.dir ? 0 : ROUTE_TURN_COST) +
      (step.heightDelta === 0 ? 0 : ROUTE_HEIGHT_CHANGE_COST),
    0,
  );
}

function usesExistingTunnelRoute(route: Readonly<StairBFSRoute>): boolean {
  return route.steps.some((step) => step.dig.length === 0);
}

function listTargetStandingPositions(
  target: StairBFSBlockPos,
  origin: StairBFSBlockPos,
): readonly StairBFSBlockPos[] {
  const positions: StairBFSBlockPos[] = [];
  for (const offset of TARGET_STANDING_OFFSETS) {
    positions.push(
      freezePos({
        x: target.x + offset.x,
        y: target.y + offset.y,
        z: target.z + offset.z,
      }),
    );
  }

  return Object.freeze(
    positions
      .filter((position) => !samePos(position, target))
      .sort((left, right) => distance(origin, left) - distance(origin, right)),
  );
}

function freezePos(pos: Readonly<StairBFSBlockPos>): StairBFSBlockPos {
  return Object.freeze({
    x: pos.x,
    y: pos.y,
    z: pos.z,
  });
}

const STAIR_EXPLORATION_DIRECTIONS = Object.freeze([
  "north",
  "east",
  "south",
  "west",
] as const satisfies readonly StairBFSDirection[]);

const TARGET_STANDING_OFFSETS = Object.freeze([
  { x: -1, y: 0, z: 0 },
  { x: 1, y: 0, z: 0 },
  { x: 0, y: 0, z: -1 },
  { x: 0, y: 0, z: 1 },
  { x: -1, y: 1, z: 0 },
  { x: 1, y: 1, z: 0 },
  { x: 0, y: 1, z: -1 },
  { x: 0, y: 1, z: 1 },
  { x: -1, y: -1, z: 0 },
  { x: 1, y: -1, z: 0 },
  { x: 0, y: -1, z: -1 },
  { x: 0, y: -1, z: 1 },
] as const);

function countRouteTargetDigs(
  plan: Readonly<StairBFSPlanSuccess>,
  input: {
    readonly bot: MineQueueBot;
    readonly facts: MineBlockFactReader;
    readonly blockName: string;
  },
): number {
  return plan.route.steps.reduce(
    (count, step) =>
      count +
      step.dig.filter((position) => {
        const block = readMineflayerBlockAt(input.bot, position);
        return input.facts.normalizeName(block?.name) === input.blockName;
      }).length,
    0,
  );
}

function sortDigPositionsForExecution(
  positions: readonly StairBFSBlockPos[],
): readonly StairBFSBlockPos[] {
  return Object.freeze([...positions].sort((left, right) => right.y - left.y));
}

function pushPlanFailureDiagnostic(
  diagnostics: string[] | undefined,
  origin: Readonly<StairBFSBlockPos>,
  direction: StairBFSDirection,
  failure: StairBFSPlanFailure,
): void {
  pushPlanDiagnostic(
    diagnostics,
    [
      `mine_queue_plan_rejected:${positionKey(origin)}`,
      `dir=${direction}`,
      `reason=${failure.reason}`,
      `expanded=${failure.diagnostics.exploredStates}`,
      `rejects=${summarizeRejectedSteps(failure.diagnostics.rejectedSteps)}`,
    ].join(";"),
  );
}

function pushPlanDiagnostic(diagnostics: string[] | undefined, text: string): void {
  if (diagnostics === undefined || diagnostics.length >= 80) {
    return;
  }
  diagnostics.push(text);
}

function summarizeRejectedSteps(
  rejectedSteps: readonly {
    readonly reason: string;
  }[],
): string {
  if (rejectedSteps.length === 0) {
    return "none";
  }

  const counts = new Map<string, number>();
  for (const step of rejectedSteps) {
    counts.set(step.reason, (counts.get(step.reason) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 4)
    .map(([reason, count]) => `${reason}:${count}`)
    .join(",");
}

function positionKey(pos: Readonly<StairBFSBlockPos>): string {
  return `${pos.x}:${pos.y}:${pos.z}`;
}

function samePos(left: Readonly<StairBFSBlockPos>, right: Readonly<StairBFSBlockPos>): boolean {
  return left.x === right.x && left.y === right.y && left.z === right.z;
}
