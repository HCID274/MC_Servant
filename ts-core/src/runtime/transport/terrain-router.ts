import type { MineBlockFactReader } from "./mine-block-facts.js";
import { isSelfPlacedTerrainBlock } from "./terrain-self-placed-memory.js";
import type {
  MineflayerLifecyclePort,
  MineflayerMiningPort,
  MineflayerPlacementPort,
} from "./types.js";
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
    }
  | {
      readonly kind: "digDropSelfPlaced";
      readonly toFoot: TerrainBlockPos;
      readonly dir: TerrainRouteDirection;
      readonly digs: readonly TerrainBlockPos[];
    };

type TerrainRouteBot = MineflayerLifecyclePort & MineflayerMiningPort & MineflayerPlacementPort;

export interface TerrainRoutePlan {
  readonly actions: readonly TerrainRouteAction[];
  readonly finalFoot: TerrainBlockPos;
  readonly cost: number;
}

export interface TerrainRoutePlanResult {
  readonly plan: TerrainRoutePlan | null;
  readonly diagnostics: readonly string[];
  readonly expandedStates: number;
  readonly budgetExhausted: boolean;
}

export type TerrainRouteProfile = "normal" | "mining";
export type TerrainRouteSearchPhaseName = "natural" | "light_dig" | "light_place" | "relaxed";

export interface TerrainRouteBudget {
  readonly maxTotalExpandedStates?: number;
  readonly maxPhaseExpandedStates?: number;
  readonly phaseMaxExpandedStates?: Partial<Record<TerrainRouteSearchPhaseName, number>>;
  readonly maxPlanningMs?: number;
  readonly noProgressStepLimit?: number;
  readonly phaseNoProgressStepLimits?: Partial<Record<TerrainRouteSearchPhaseName, number>>;
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

const COST_WALK = 6;
const COST_DROP1 = 7;
const COST_JUMP_UP = 7;
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

interface TerrainSearchPhase {
  readonly name: TerrainRouteSearchPhaseName;
  readonly solvedDiagnostic: string;
  readonly failedDiagnostic: string;
  readonly allowDig: boolean;
  readonly allowPlaceUp: boolean;
  readonly maxDigBlocks: number;
  readonly maxPlaceBlocks: number;
  readonly maxDropBlocks: number;
  readonly maxExpandedStates: number;
  readonly maxNoProgressSteps: number;
}

interface SearchNode {
  readonly foot: TerrainBlockPos;
  readonly plannedAir: ReadonlySet<string>;
  readonly plannedSolid: ReadonlySet<string>;
  readonly cost: number;
  readonly priority: number;
  readonly parent: SearchNode | null;
  readonly action: TerrainRouteAction | null;
  readonly lastDir: TerrainRouteDirection | null;
  readonly lastActionKind: TerrainRouteAction["kind"] | null;
  readonly depth: number;
  readonly digCount: number;
  readonly placeCount: number;
  readonly dropCount: number;
  readonly noProgressSteps: number;
}

export function planTerrainRoute(input: {
  readonly bot: TerrainRouteBot;
  readonly facts: MineBlockFactReader;
  readonly startFoot: TerrainBlockPos;
  readonly targetFoot: TerrainBlockPos;
  readonly goalRange?: number;
  readonly goalYRange?: number;
  readonly allowPlaceUp?: boolean;
  readonly allowDig?: boolean;
  readonly maxExpandedStates?: number;
  readonly maxActionDepth?: number;
  readonly routeProfile?: TerrainRouteProfile;
  readonly routeBudget?: TerrainRouteBudget;
}): TerrainRoutePlanResult {
  const diagnostics: string[] = [];
  const startedAtMs = Date.now();
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
  const goalYRange = Math.max(0, Math.floor(input.goalYRange ?? 0));
  const phases = createSearchPhases({
    profile: input.routeProfile ?? "normal",
    allowDig: input.allowDig ?? true,
    allowPlaceUp: input.allowPlaceUp ?? true,
    maxPlannedSolid,
    ...(input.maxExpandedStates === undefined
      ? {}
      : { legacyMaxExpanded: input.maxExpandedStates }),
    ...(input.routeBudget === undefined ? {} : { routeBudget: input.routeBudget }),
  });

  const startNode: SearchNode = {
    foot: freezePos(input.startFoot),
    plannedAir: new Set<string>(),
    plannedSolid: new Set<string>(),
    cost: 0,
    priority: routeHeuristic(input.startFoot, input.targetFoot, goalRange, goalYRange),
    parent: null,
    action: null,
    lastDir: null,
    lastActionKind: null,
    depth: 0,
    digCount: 0,
    placeCount: 0,
    dropCount: 0,
    noProgressSteps: 0,
  };

  if (isGoal(startNode.foot, input.targetFoot, goalRange, goalYRange)) {
    diagnostics.push("terrain_bfs_solved:cost=0;actions=0;expanded=0");
    return {
      plan: {
        actions: Object.freeze([]),
        finalFoot: freezePos(startNode.foot),
        cost: 0,
      },
      diagnostics: Object.freeze(diagnostics),
      expandedStates: 0,
      budgetExhausted: false,
    };
  }

  let totalExpanded = 0;
  let budgetExhausted = false;
  for (const phase of phases) {
    if (
      input.routeBudget?.maxTotalExpandedStates !== undefined &&
      totalExpanded >= input.routeBudget.maxTotalExpandedStates
    ) {
      budgetExhausted = true;
      diagnostics.push(
        `terrain_route_budget_exhausted:expanded=${totalExpanded};max_total=${input.routeBudget.maxTotalExpandedStates}`,
      );
      break;
    }
    const phaseResult = searchTerrainPhase({
      input,
      phase,
      startNode,
      goalRange,
      goalYRange,
      maxDepth,
      maxPlannedSolid,
      startedAtMs,
      ...(input.routeBudget?.maxPlanningMs === undefined
        ? {}
        : { maxPlanningMs: input.routeBudget.maxPlanningMs }),
      ...(input.routeBudget?.maxTotalExpandedStates === undefined
        ? {}
        : {
            remainingExpandedStates: Math.max(
              0,
              input.routeBudget.maxTotalExpandedStates - totalExpanded,
            ),
          }),
    });
    totalExpanded += phaseResult.expandedStates;
    budgetExhausted = budgetExhausted || phaseResult.budgetExhausted;
    diagnostics.push(...phaseResult.diagnostics);
    if (phaseResult.plan !== null) {
      return {
        plan: phaseResult.plan,
        diagnostics: Object.freeze(diagnostics),
        expandedStates: totalExpanded,
        budgetExhausted,
      };
    }
    if (
      input.routeBudget?.maxPlanningMs !== undefined &&
      Date.now() - startedAtMs >= input.routeBudget.maxPlanningMs
    ) {
      diagnostics.push(
        `terrain_route_time_budget_exhausted:elapsed_ms=${Date.now() - startedAtMs};max_ms=${input.routeBudget.maxPlanningMs}`,
      );
      break;
    }
  }

  diagnostics.push(
    `terrain_bfs_no_path:expanded=${totalExpanded};phases=${phases.length};budget_exhausted=${budgetExhausted}`,
  );
  return {
    plan: null,
    diagnostics: Object.freeze(diagnostics),
    expandedStates: totalExpanded,
    budgetExhausted,
  };
}

function searchTerrainPhase(input: {
  readonly input: {
    readonly bot: TerrainRouteBot;
    readonly facts: MineBlockFactReader;
    readonly startFoot: TerrainBlockPos;
    readonly targetFoot: TerrainBlockPos;
  };
  readonly phase: TerrainSearchPhase;
  readonly startNode: SearchNode;
  readonly goalRange: number;
  readonly goalYRange: number;
  readonly maxDepth: number;
  readonly maxPlannedSolid: number;
  readonly startedAtMs: number;
  readonly maxPlanningMs?: number;
  readonly remainingExpandedStates?: number;
}): TerrainRoutePlanResult {
  const diagnostics: string[] = [];
  const maxExpandedStates =
    input.remainingExpandedStates === undefined
      ? input.phase.maxExpandedStates
      : Math.min(input.phase.maxExpandedStates, input.remainingExpandedStates);
  const open = new MinHeap<SearchNode>((left, right) =>
    left.priority === right.priority ? left.cost - right.cost : left.priority - right.priority,
  );
  open.push(input.startNode);
  const visited = new Map<string, number>();
  visited.set(stateKey(input.startNode), 0);

  let expanded = 0;
  let bestNode = input.startNode;
  let bestScore = goalDistanceScore(
    input.startNode.foot,
    input.input.targetFoot,
    input.goalRange,
    input.goalYRange,
  );
  let prunedNoProgress = 0;
  let terminationReason = "open_exhausted";
  while (!open.isEmpty() && expanded < maxExpandedStates) {
    if (
      input.maxPlanningMs !== undefined &&
      expanded > 0 &&
      expanded % 64 === 0 &&
      Date.now() - input.startedAtMs >= input.maxPlanningMs
    ) {
      terminationReason = "time_budget";
      break;
    }
    const node = open.pop();
    if (node === undefined) break;
    expanded += 1;
    const nodeScore = goalDistanceScore(
      node.foot,
      input.input.targetFoot,
      input.goalRange,
      input.goalYRange,
    );
    if (nodeScore < bestScore || (nodeScore === bestScore && node.cost < bestNode.cost)) {
      bestNode = node;
      bestScore = nodeScore;
    }

    if (isGoal(node.foot, input.input.targetFoot, input.goalRange, input.goalYRange)) {
      const actions = reconstructActions(node);
      diagnostics.push(
        `${input.phase.solvedDiagnostic}:cost=${node.cost};actions=${actions.length};expanded=${expanded};foot=${posLabel(node.foot)};dig=${node.digCount};place=${node.placeCount};drop=${node.dropCount}`,
      );
      diagnostics.push(
        `terrain_bfs_solved:phase=${input.phase.name};cost=${node.cost};actions=${actions.length};expanded=${expanded};foot=${posLabel(node.foot)}`,
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
        budgetExhausted: false,
      };
    }

    if (node.depth >= input.maxDepth) continue;
    if (node.plannedAir.size >= DEFAULT_MAX_PLANNED_AIR) continue;
    if (node.plannedSolid.size >= input.maxPlannedSolid) continue;
    if (node.plannedAir.size + node.plannedSolid.size >= DEFAULT_MAX_TOTAL_PLANNED_CHANGES) {
      continue;
    }

    const expansion = expandSuccessors(
      {
        bot: input.input.bot,
        facts: input.input.facts,
        targetFoot: input.input.targetFoot,
        phase: input.phase,
      },
      node,
      input.goalRange,
      input.goalYRange,
    );
    prunedNoProgress += expansion.prunedNoProgress;
    for (const successor of expansion.successors) {
      const key = stateKey(successor);
      const seen = visited.get(key);
      if (seen !== undefined && seen <= successor.cost) continue;
      visited.set(key, successor.cost);
      open.push(successor);
    }
  }

  if (!open.isEmpty() && expanded >= maxExpandedStates) terminationReason = "expanded_budget";
  const budgetExhausted =
    terminationReason === "expanded_budget" || terminationReason === "time_budget";
  if (prunedNoProgress > 0) {
    diagnostics.push(
      `terrain_pruned_no_progress:phase=${input.phase.name};count=${prunedNoProgress};max_steps=${input.phase.maxNoProgressSteps}`,
    );
  }
  diagnostics.push(
    `${input.phase.failedDiagnostic}:expanded=${expanded};max_expanded=${maxExpandedStates};open=${open.size()};best=${posLabel(bestNode.foot)};best_score=${bestScore};best_cost=${bestNode.cost};max_depth=${input.maxDepth};max_dig=${input.phase.maxDigBlocks};max_place=${input.phase.maxPlaceBlocks};max_drop=${input.phase.maxDropBlocks};max_no_progress=${input.phase.maxNoProgressSteps};termination=${terminationReason};goal_y_range=${input.goalYRange};max_air=${DEFAULT_MAX_PLANNED_AIR};max_solid=${input.maxPlannedSolid};max_total=${DEFAULT_MAX_TOTAL_PLANNED_CHANGES}`,
  );
  return {
    plan: null,
    diagnostics: Object.freeze(diagnostics),
    expandedStates: expanded,
    budgetExhausted,
  };
}

function expandSuccessors(
  input: {
    readonly bot: TerrainRouteBot;
    readonly facts: MineBlockFactReader;
    readonly targetFoot: TerrainBlockPos;
    readonly phase: TerrainSearchPhase;
  },
  node: SearchNode,
  goalRange: number,
  goalYRange: number,
): { readonly successors: SearchNode[]; readonly prunedNoProgress: number } {
  const out: SearchNode[] = [];
  let prunedNoProgress = 0;
  const fy = node.foot.y;
  const allowDig = input.phase.allowDig;
  const allowPlaceUp = input.phase.allowPlaceUp;

  if (allowDig) {
    const selfPlacedSupport = freezePos({
      x: node.foot.x,
      y: fy - 1,
      z: node.foot.z,
    });
    const selfPlacedDropFoot = freezePos({
      x: node.foot.x,
      y: fy - 1,
      z: node.foot.z,
    });
    const selfPlacedDropSupport = freezePos({
      x: node.foot.x,
      y: fy - 2,
      z: node.foot.z,
    });
    if (
      canDigSelfPlacedSupport(input.bot, input.facts, selfPlacedSupport, node) &&
      node.digCount + 1 <= input.phase.maxDigBlocks &&
      node.dropCount + 1 <= input.phase.maxDropBlocks &&
      hasClearance(input.bot, input.facts, node.foot, BODY_CLEARANCE, node) &&
      isWalkableSupport(input.bot, input.facts, selfPlacedDropSupport, node) &&
      !isImmediateReverseVerticalExcavation(node, "digDropSelfPlaced", node.lastDir ?? "north")
    ) {
      if (
        !pushSuccessor(
          out,
          node,
          {
            kind: "digDropSelfPlaced",
            toFoot: selfPlacedDropFoot,
            dir: node.lastDir ?? "north",
            digs: Object.freeze([selfPlacedSupport]),
          },
          COST_DROP1 + COST_TERRAIN_CHANGE_PER_BLOCK,
          input.targetFoot,
          goalRange,
          goalYRange,
          input.phase.maxNoProgressSteps,
        )
      )
        prunedNoProgress += 1;
    }
  }

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
      if (
        !pushSuccessor(
          out,
          node,
          { kind: "walk", toFoot: walkFoot, dir },
          COST_WALK + turn,
          input.targetFoot,
          goalRange,
          goalYRange,
          input.phase.maxNoProgressSteps,
        )
      )
        prunedNoProgress += 1;
    }

    const dropFoot = freezePos({ x: fx, y: fy - 1, z: fz });
    if (
      hasClearance(input.bot, input.facts, node.foot, JUMP_CLEARANCE, node) &&
      hasClearance(input.bot, input.facts, dropFoot, JUMP_CLEARANCE, node) &&
      isWalkableSupport(input.bot, input.facts, { x: fx, y: fy - 2, z: fz }, node) &&
      node.dropCount + 1 <= input.phase.maxDropBlocks
    ) {
      if (
        !pushSuccessor(
          out,
          node,
          { kind: "drop1", toFoot: dropFoot, dir },
          COST_DROP1 + turn,
          input.targetFoot,
          goalRange,
          goalYRange,
          input.phase.maxNoProgressSteps,
        )
      )
        prunedNoProgress += 1;
    }

    const upFoot = freezePos({ x: fx, y: fy + 1, z: fz });
    if (
      hasClearance(input.bot, input.facts, node.foot, JUMP_CLEARANCE, node) &&
      isWalkableSupport(input.bot, input.facts, { x: fx, y: fy, z: fz }, node) &&
      hasClearance(input.bot, input.facts, upFoot, JUMP_CLEARANCE, node)
    ) {
      if (
        !pushSuccessor(
          out,
          node,
          { kind: "jumpUp", toFoot: upFoot, dir },
          COST_JUMP_UP + turn,
          input.targetFoot,
          goalRange,
          goalYRange,
          input.phase.maxNoProgressSteps,
        )
      )
        prunedNoProgress += 1;
    }

    const placeAt = freezePos({ x: node.foot.x, y: fy, z: node.foot.z });
    const placeSupport = freezePos({ x: node.foot.x, y: fy - 1, z: node.foot.z });
    const placeTargetFoot = freezePos({ x: node.foot.x, y: fy + 1, z: node.foot.z });
    if (
      allowPlaceUp &&
      node.placeCount + 1 <= input.phase.maxPlaceBlocks &&
      isWalkableSupport(input.bot, input.facts, placeSupport, node)
    ) {
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
        node.digCount + placeDigs.length <= input.phase.maxDigBlocks &&
        hasClearance(input.bot, input.facts, node.foot, BODY_CLEARANCE, node)
      ) {
        if (
          !pushSuccessor(
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
            goalYRange,
            input.phase.maxNoProgressSteps,
          )
        )
          prunedNoProgress += 1;
      }
    }

    if (!allowDig) continue;

    const bodyPos = freezePos({ x: fx, y: fy, z: fz });
    const headPos = freezePos({ x: fx, y: fy + 1, z: fz });
    const supportPos = freezePos({ x: fx, y: fy - 1, z: fz });
    if (isWalkableSupport(input.bot, input.facts, supportPos, node)) {
      const digs = collectClearanceDigs(input.bot, input.facts, [bodyPos, headPos], node);
      if (
        digs !== null &&
        digs.length > 0 &&
        node.digCount + digs.length <= input.phase.maxDigBlocks
      ) {
        if (
          !pushSuccessor(
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
            goalYRange,
            input.phase.maxNoProgressSteps,
          )
        )
          prunedNoProgress += 1;
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
      node.digCount + stepDownDigs.length <= input.phase.maxDigBlocks &&
      hasClearance(input.bot, input.facts, node.foot, BODY_CLEARANCE, node) &&
      isWalkableSupport(input.bot, input.facts, stepDownSupport, node) &&
      !isImmediateReverseVerticalExcavation(node, "digStepDown", dir)
    ) {
      if (
        !pushSuccessor(
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
          goalYRange,
          input.phase.maxNoProgressSteps,
        )
      )
        prunedNoProgress += 1;
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
      node.digCount + stepUpDigs.length <= input.phase.maxDigBlocks &&
      hasClearance(input.bot, input.facts, node.foot, BODY_CLEARANCE, node) &&
      isWalkableSupport(input.bot, input.facts, stepUpSupport, node) &&
      !isImmediateReverseVerticalExcavation(node, "digStepUp", dir)
    ) {
      if (
        !pushSuccessor(
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
          goalYRange,
          input.phase.maxNoProgressSteps,
        )
      )
        prunedNoProgress += 1;
    }
  }

  return { successors: out, prunedNoProgress };
}

function createSearchPhases(input: {
  readonly profile: TerrainRouteProfile;
  readonly allowDig: boolean;
  readonly allowPlaceUp: boolean;
  readonly legacyMaxExpanded?: number;
  readonly routeBudget?: TerrainRouteBudget;
  readonly maxPlannedSolid: number;
}): readonly TerrainSearchPhase[] {
  const expanded = (phase: TerrainRouteSearchPhaseName, fallback: number) =>
    input.routeBudget?.phaseMaxExpandedStates?.[phase] ??
    input.routeBudget?.maxPhaseExpandedStates ??
    input.legacyMaxExpanded ??
    fallback;
  const noProgress = (phase: TerrainRouteSearchPhaseName, fallback: number) =>
    input.routeBudget?.phaseNoProgressStepLimits?.[phase] ??
    input.routeBudget?.noProgressStepLimit ??
    fallback;
  const relaxedDig = input.profile === "mining" ? DEFAULT_MAX_PLANNED_AIR : 16;
  const relaxedPlace = input.maxPlannedSolid;
  const phases: TerrainSearchPhase[] = [
    {
      name: "natural",
      solvedDiagnostic: "terrain_phase1_solved_natural_path",
      failedDiagnostic: "terrain_phase1_no_natural_path",
      allowDig: false,
      allowPlaceUp: false,
      maxDigBlocks: 0,
      maxPlaceBlocks: 0,
      maxDropBlocks: 5,
      maxExpandedStates: expanded("natural", input.profile === "mining" ? 2_000 : 3_000),
      maxNoProgressSteps: noProgress("natural", input.profile === "mining" ? 6 : 3),
    },
  ];

  if (input.allowDig) {
    phases.push({
      name: "light_dig",
      solvedDiagnostic: "terrain_phase2_solved_with_dig",
      failedDiagnostic: "terrain_phase2_no_path_with_dig",
      allowDig: true,
      allowPlaceUp: false,
      maxDigBlocks: input.profile === "mining" ? 8 : 2,
      maxPlaceBlocks: 0,
      maxDropBlocks: input.profile === "mining" ? 16 : 8,
      maxExpandedStates: expanded("light_dig", input.profile === "mining" ? 6_000 : 4_000),
      maxNoProgressSteps: noProgress("light_dig", input.profile === "mining" ? 10 : 5),
    });
  }

  if (input.allowPlaceUp) {
    phases.push({
      name: "light_place",
      solvedDiagnostic: "terrain_phase3_solved_with_place",
      failedDiagnostic: "terrain_phase3_no_path_with_place",
      allowDig: input.allowDig,
      allowPlaceUp: true,
      maxDigBlocks: input.profile === "mining" ? 12 : 2,
      maxPlaceBlocks: 1,
      maxDropBlocks: input.profile === "mining" ? 24 : 8,
      maxExpandedStates: expanded("light_place", input.profile === "mining" ? 8_000 : 5_000),
      maxNoProgressSteps: noProgress("light_place", input.profile === "mining" ? 12 : 5),
    });
  }

  phases.push({
    name: "relaxed",
    solvedDiagnostic: "terrain_phase4_solved_relaxed_path",
    failedDiagnostic: "terrain_phase4_no_relaxed_path",
    allowDig: input.allowDig,
    allowPlaceUp: input.allowPlaceUp,
    maxDigBlocks: input.allowDig ? relaxedDig : 0,
    maxPlaceBlocks: input.allowPlaceUp ? relaxedPlace : 0,
    maxDropBlocks: input.profile === "mining" ? 64 : 16,
    maxExpandedStates: expanded("relaxed", DEFAULT_MAX_EXPANDED),
    maxNoProgressSteps: noProgress("relaxed", input.profile === "mining" ? 16 : 8),
  });

  return Object.freeze(phases);
}

function pushSuccessor(
  out: SearchNode[],
  parent: SearchNode,
  action: TerrainRouteAction,
  cost: number,
  targetFoot: TerrainBlockPos,
  goalRange: number,
  goalYRange: number,
  maxNoProgressSteps: number,
): boolean {
  const previousScore = goalDistanceScore(parent.foot, targetFoot, goalRange, goalYRange);
  const nextScore = goalDistanceScore(action.toFoot, targetFoot, goalRange, goalYRange);
  const noProgressSteps = nextScore < previousScore ? 0 : parent.noProgressSteps + 1;
  if (noProgressSteps > maxNoProgressSteps) return false;

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
  const digCount = parent.digCount + digs.length;
  const placeCount = parent.placeCount + (action.kind === "placeUp1" ? 1 : 0);
  const dropCount =
    parent.dropCount + (action.kind === "drop1" || action.kind === "digDropSelfPlaced" ? 1 : 0);
  out.push({
    foot: action.toFoot,
    plannedAir,
    plannedSolid,
    cost: nextCost,
    priority: nextCost + routeHeuristic(action.toFoot, targetFoot, goalRange, goalYRange),
    parent,
    action,
    lastDir: action.dir,
    lastActionKind: action.kind,
    depth: parent.depth + 1,
    digCount,
    placeCount,
    dropCount,
    noProgressSteps,
  });
  return true;
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

function isGoal(
  current: TerrainBlockPos,
  target: TerrainBlockPos,
  range: number,
  yRange: number,
): boolean {
  return (
    Math.hypot(current.x - target.x, current.z - target.z) <= range &&
    Math.abs(current.y - target.y) <= yRange
  );
}

function routeHeuristic(
  current: TerrainBlockPos,
  target: TerrainBlockPos,
  range: number,
  yRange: number,
): number {
  const horizontalSteps = Math.max(
    0,
    Math.ceil(Math.hypot(current.x - target.x, current.z - target.z) - range),
  );
  const rawDy = target.y - current.y;
  const dy = Math.abs(rawDy) <= yRange ? 0 : rawDy > 0 ? rawDy - yRange : rawDy + yRange;
  const placeUpCost = COST_TERRAIN_CHANGE_BASE + COST_PLACE_UP_ITEM_PENALTY;
  const verticalCost = dy > 0 ? dy * placeUpCost : Math.abs(dy) * COST_DROP1;
  return horizontalSteps * COST_WALK + verticalCost;
}

function goalDistanceScore(
  current: TerrainBlockPos,
  target: TerrainBlockPos,
  range: number,
  yRange: number,
): number {
  const horizontalMiss = Math.max(
    0,
    Math.hypot(current.x - target.x, current.z - target.z) - range,
  );
  const verticalMiss = Math.max(0, Math.abs(current.y - target.y) - yRange);
  return verticalMiss * 1000 + horizontalMiss;
}

function stateKey(node: SearchNode): string {
  const foot = positionKey(node.foot);
  const air = node.plannedAir.size === 0 ? "" : `a=${Array.from(node.plannedAir).sort().join("|")}`;
  const solid =
    node.plannedSolid.size === 0 ? "" : `s=${Array.from(node.plannedSolid).sort().join("|")}`;
  return `${foot}#${air}#${solid}#last=${node.lastActionKind ?? "none"}#dig=${node.digCount};place=${node.placeCount};drop=${node.dropCount};np=${node.noProgressSteps}`;
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

function canDigSelfPlacedSupport(
  bot: TerrainRouteBot,
  facts: MineBlockFactReader,
  pos: TerrainBlockPos,
  node: SearchNode,
): boolean {
  const key = positionKey(pos);
  if (node.plannedAir.has(key) || node.plannedSolid.has(key)) return false;
  if (!isSelfPlacedTerrainBlock(bot, pos)) return false;
  const block = readMineflayerBlockAt(bot, pos);
  if (block === null || block === undefined) return false;
  return facts.isSupportBlock(block) && facts.isDiggableBlock(block);
}

function isOppositeDirection(left: TerrainRouteDirection, right: TerrainRouteDirection): boolean {
  return (
    (left === "north" && right === "south") ||
    (left === "south" && right === "north") ||
    (left === "east" && right === "west") ||
    (left === "west" && right === "east")
  );
}

function isImmediateReverseVerticalExcavation(
  node: SearchNode,
  nextKind: "digDropSelfPlaced" | "digStepDown" | "digStepUp",
  nextDir: TerrainRouteDirection,
): boolean {
  const previous = node.action;
  if (previous === null) return false;
  if (!isVerticalExcavation(previous.kind) || !isVerticalExcavation(nextKind)) return false;
  return isOppositeDirection(previous.dir, nextDir);
}

function isVerticalExcavation(
  kind: TerrainRouteAction["kind"],
): kind is "digDropSelfPlaced" | "digStepDown" | "digStepUp" {
  return kind === "digDropSelfPlaced" || kind === "digStepDown" || kind === "digStepUp";
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
