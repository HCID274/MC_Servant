/** StairBFSPlanner（阶梯广度优先规划器） 的纯领域核心。 */

export interface StairBFSBlockPos {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export const STAIR_BFS_DIRECTIONS = Object.freeze(["north", "east", "south", "west"] as const);
export type StairBFSDirection = (typeof STAIR_BFS_DIRECTIONS)[number];

export const STAIR_BFS_MODES = Object.freeze(["down", "up"] as const);
export type StairBFSMode = (typeof STAIR_BFS_MODES)[number];

export const STAIR_BFS_BLOCK_ROLES = Object.freeze([
  "air",
  "solid",
  "mineable",
  "ore",
  "low_value_fill",
  "lava",
  "water",
  "falling",
  "hazard",
] as const);
export type StairBFSBlockRole = (typeof STAIR_BFS_BLOCK_ROLES)[number];

export interface StairBFSBlock {
  readonly pos: StairBFSBlockPos;
  /** 方块角色由 runtime（运行时）/world scanner（世界扫描器） 基于真实事实预分类，domain（领域） 不猜 MC 规则。 */
  readonly role: StairBFSBlockRole;
}

export interface StairBFSState {
  readonly pos: StairBFSBlockPos;
  readonly dir: StairBFSDirection;
  readonly mode: StairBFSMode;
  readonly usedFill: number;
}

export interface StairBFSGoal {
  readonly target?: StairBFSBlockPos;
  readonly yAtMost?: number;
  readonly yAtLeast?: number;
  readonly minSteps?: number;
}

export interface StairBFSStep {
  readonly from: StairBFSState;
  readonly to: StairBFSState;
  readonly action:
    | "forward"
    | "turn_left"
    | "turn_right"
    | "cave_forward"
    | "cave_left"
    | "cave_right";
  readonly heightDelta: -1 | 0 | 1;
  readonly dig: readonly StairBFSBlockPos[];
  readonly fill: readonly StairBFSBlockPos[];
}

export interface StairBFSRoute {
  readonly states: readonly StairBFSState[];
  readonly steps: readonly StairBFSStep[];
}

export interface StairBFSPlanSuccess {
  readonly ok: true;
  readonly phase: "no_fill" | "fill";
  readonly route: StairBFSRoute;
  readonly diagnostics: StairBFSPlanDiagnostics;
}

export interface StairBFSPlanFailure {
  readonly ok: false;
  readonly reason: "invalid_start" | "no_safe_route" | "goal_not_reached" | "invalid_planner_input";
  readonly diagnostics: StairBFSPlanDiagnostics;
}

export type StairBFSPlanResult = StairBFSPlanSuccess | StairBFSPlanFailure;

export interface StairBFSPlanDiagnostics {
  readonly exploredStates: number;
  readonly rejectedSteps: readonly StairBFSRejectedStep[];
}

export interface StairBFSRejectedStep {
  readonly from: StairBFSState;
  readonly next: StairBFSBlockPos;
  readonly reason: StairBFSStepRejectReason;
}

export type StairBFSStepRejectReason =
  | "height_delta_out_of_range"
  | "body_space_blocked"
  | "floor_missing"
  | "floor_unsafe"
  | "lava_risk"
  | "water_risk"
  | "falling_block_risk"
  | "deep_pit_risk"
  | "reverse_down_step"
  | "fill_not_allowed"
  | "fill_budget_exhausted"
  | "unknown_block";

export interface StairBFSStepValidation {
  readonly ok: boolean;
  readonly reason?: StairBFSStepRejectReason;
  readonly dig: readonly StairBFSBlockPos[];
  readonly fill: readonly StairBFSBlockPos[];
}

export interface StairBFSWorldScanner {
  getBlock(pos: Readonly<StairBFSBlockPos>): StairBFSBlock | undefined;
}

export interface StairBFSSafetyChecker {
  isValidStep(input: Readonly<StairBFSStepValidationInput>): StairBFSStepValidation;
}

export interface StairBFSStepValidationInput {
  readonly scanner: StairBFSWorldScanner;
  readonly current: StairBFSState;
  readonly next: StairBFSBlockPos;
  readonly nextDir: StairBFSDirection;
  readonly heightDelta: -1 | 0 | 1;
  readonly allowFill: boolean;
  readonly maxFillBlocks: number;
}

export interface StairBFSPlanner {
  plan(input: Readonly<StairBFSPlanInput>): StairBFSPlanResult;
}

export interface StairBFSPlanInput {
  readonly scanner: StairBFSWorldScanner;
  readonly start: StairBFSState;
  readonly goal: StairBFSGoal;
  readonly maxSteps?: number;
  readonly maxExpandedStates?: number;
  readonly maxFillBlocks?: number;
  readonly safetyChecker?: StairBFSSafetyChecker;
}

export interface StairBFSOreTarget {
  readonly ore: StairBFSBlockPos;
  readonly standingPos: StairBFSBlockPos;
}

export interface StairBFSOreHandler {
  findReachableOreTargets(route: Readonly<StairBFSRoute>): readonly StairBFSOreTarget[];
}

interface SearchNode {
  readonly state: StairBFSState;
  readonly states: readonly StairBFSState[];
  readonly steps: readonly StairBFSStep[];
  readonly cost: number;
}

interface SearchResult {
  readonly route?: StairBFSRoute;
  readonly diagnostics: StairBFSPlanDiagnostics;
}

const DEFAULT_MAX_STEPS = 12;
const MAX_SHORT_SEGMENT_STEPS = 16;
const DEFAULT_MAX_EXPANDED_STATES = 512;
const STEP_BASE_COST = 10;
const STEP_DIG_COST = 120;
const STEP_FILL_COST = 240;
const STEP_TURN_COST = 6;
const STEP_HEIGHT_CHANGE_COST = 4;

/** 创建默认 SafetyChecker（安全检查器），只依赖 scanner（扫描器） 提供的预分类方块角色。 */
export function createDefaultStairBFSSafetyChecker(): StairBFSSafetyChecker {
  return Object.freeze({
    isValidStep(input: Readonly<StairBFSStepValidationInput>): StairBFSStepValidation {
      if (input.heightDelta === -1 && isOppositeDirection(input.current.dir, input.nextDir)) {
        return invalidStep("reverse_down_step");
      }

      const nextFoot = input.next;
      const nextHead = addY(input.next, 1);
      const nextTop = addY(input.next, 2);
      const nextFloor = addY(input.next, -1);
      const bodyBlocks = [nextFoot, nextHead, nextTop] as const;

      for (const bodyPos of bodyBlocks) {
        const block = readKnownBlock(input.scanner, bodyPos);
        if (block === undefined) {
          return invalidStep("unknown_block");
        }
        if (isLava(block)) {
          return invalidStep("lava_risk");
        }
        if (isWater(block)) {
          return invalidStep("water_risk");
        }
        if (!isBodySpaceClearOrMineable(block)) {
          return invalidStep("body_space_blocked");
        }
      }

      const lavaRisk = hasNearbyRole(
        input.scanner,
        [nextFoot, nextHead, nextTop],
        "lava",
        "lava_risk",
      );
      if (lavaRisk !== undefined) {
        return invalidStep(lavaRisk);
      }
      const waterRisk = hasNearbyRole(
        input.scanner,
        [nextFoot, nextHead, nextTop],
        "water",
        "water_risk",
      );
      if (waterRisk !== undefined) {
        return invalidStep(waterRisk);
      }

      const dig = bodyBlocks.filter((pos) =>
        shouldDigForBodySpace(readRequiredBlock(input.scanner, pos)),
      );
      for (const digPos of dig) {
        const above = readKnownBlock(input.scanner, addY(digPos, 1));
        if (above === undefined) {
          return invalidStep("unknown_block");
        }
        if (above.role === "falling") {
          return invalidStep("falling_block_risk");
        }
      }

      const floor = readKnownBlock(input.scanner, nextFloor);
      if (floor === undefined) {
        return invalidStep("unknown_block");
      }
      if (isLava(floor)) {
        return invalidStep("lava_risk");
      }
      if (isWater(floor)) {
        return invalidStep("water_risk");
      }
      if (floor.role === "hazard" || floor.role === "falling") {
        return invalidStep("floor_unsafe");
      }
      if (isSupportBlock(floor)) {
        if (hasDeepPitRisk(input.scanner, nextFloor)) {
          return invalidStep("deep_pit_risk");
        }
        return validStep(dig, []);
      }
      if (floor.role !== "air") {
        return invalidStep("floor_unsafe");
      }
      if (!input.allowFill) {
        return invalidStep("fill_not_allowed");
      }
      if (input.current.usedFill >= input.maxFillBlocks) {
        return invalidStep("fill_budget_exhausted");
      }
      if (hasDeepPitRisk(input.scanner, nextFloor)) {
        return invalidStep("deep_pit_risk");
      }

      return validStep(dig, [nextFloor]);
    },
  });
}

/** 创建 StairBFSPlanner（阶梯广度优先规划器）。 */
export function createStairBFSPlanner(): StairBFSPlanner {
  return Object.freeze({
    plan(input: Readonly<StairBFSPlanInput>): StairBFSPlanResult {
      const maxSteps = normalizeMaxSteps(input.maxSteps);
      if (
        maxSteps === undefined ||
        (input.maxFillBlocks !== undefined && input.maxFillBlocks < 0)
      ) {
        return freezeFailure("invalid_planner_input", emptyDiagnostics());
      }

      const maxExpandedStates = input.maxExpandedStates ?? DEFAULT_MAX_EXPANDED_STATES;
      if (!Number.isInteger(maxExpandedStates) || maxExpandedStates <= 0) {
        return freezeFailure("invalid_planner_input", emptyDiagnostics());
      }

      const safetyChecker = input.safetyChecker ?? createDefaultStairBFSSafetyChecker();
      if (!isStartStateValid(input.scanner, input.start, safetyChecker)) {
        return freezeFailure("invalid_start", emptyDiagnostics());
      }

      const firstPhase = search({
        scanner: input.scanner,
        start: input.start,
        goal: input.goal,
        maxSteps,
        maxExpandedStates,
        maxFillBlocks: 0,
        allowFill: false,
        safetyChecker,
      });
      if (firstPhase.route !== undefined) {
        return freezeSuccess("no_fill", firstPhase.route, firstPhase.diagnostics);
      }

      const maxFillBlocks = input.maxFillBlocks ?? 0;
      if (maxFillBlocks <= 0) {
        return freezeFailure("no_safe_route", firstPhase.diagnostics);
      }

      const secondPhase = search({
        scanner: input.scanner,
        start: input.start,
        goal: input.goal,
        maxSteps,
        maxExpandedStates,
        maxFillBlocks,
        allowFill: true,
        safetyChecker,
      });
      if (secondPhase.route !== undefined) {
        return freezeSuccess(
          "fill",
          secondPhase.route,
          mergeDiagnostics(firstPhase.diagnostics, secondPhase.diagnostics),
        );
      }

      return freezeFailure(
        "no_safe_route",
        mergeDiagnostics(firstPhase.diagnostics, secondPhase.diagnostics),
      );
    },
  });
}

/** OreHandler（矿石处理器） 占位为只读接口，T-058（任务） 不做局部采矿执行。 */
export function createNoopStairBFSOreHandler(): StairBFSOreHandler {
  return Object.freeze({
    findReachableOreTargets(): readonly StairBFSOreTarget[] {
      return Object.freeze([]);
    },
  });
}

function search(input: {
  readonly scanner: StairBFSWorldScanner;
  readonly start: StairBFSState;
  readonly goal: StairBFSGoal;
  readonly maxSteps: number;
  readonly maxExpandedStates: number;
  readonly maxFillBlocks: number;
  readonly allowFill: boolean;
  readonly safetyChecker: StairBFSSafetyChecker;
}): SearchResult {
  const queue: SearchNode[] = [
    {
      state: freezeState(input.start),
      states: Object.freeze([freezeState(input.start)]),
      steps: Object.freeze([]),
      cost: 0,
    },
  ];
  const bestCostByState = new Map<string, number>([[stateKey(input.start), 0]]);
  const rejectedSteps: StairBFSRejectedStep[] = [];
  let exploredStates = 0;

  while (queue.length > 0 && exploredStates < input.maxExpandedStates) {
    const node = queue.shift();
    if (node === undefined) {
      break;
    }
    exploredStates += 1;

    if (node.steps.length > 0 && isGoalReached(node.state, input.goal, node.steps.length)) {
      return {
        route: freezeRoute({ states: node.states, steps: node.steps }),
        diagnostics: freezeDiagnostics({ exploredStates, rejectedSteps }),
      };
    }
    if (node.steps.length >= input.maxSteps) {
      continue;
    }

    for (const candidate of listCandidates(node.state)) {
      const validation = input.safetyChecker.isValidStep({
        scanner: input.scanner,
        current: node.state,
        next: candidate.next,
        nextDir: candidate.nextDir,
        heightDelta: candidate.heightDelta,
        allowFill: input.allowFill,
        maxFillBlocks: input.maxFillBlocks,
      });

      if (!validation.ok) {
        rejectedSteps.push(
          freezeRejectedStep({
            from: node.state,
            next: candidate.next,
            reason: validation.reason ?? "body_space_blocked",
          }),
        );
        continue;
      }

      const nextState = freezeState({
        pos: candidate.next,
        dir: candidate.nextDir,
        mode: node.state.mode,
        usedFill: node.state.usedFill + validation.fill.length,
      });
      const stepCost = calculateStepCost(node.state, candidate, validation);
      const nextCost = node.cost + stepCost;
      const key = stateKey(nextState);
      const bestKnownCost = bestCostByState.get(key);
      if (bestKnownCost !== undefined && bestKnownCost <= nextCost) {
        continue;
      }
      bestCostByState.set(key, nextCost);
      const step = freezeStep({
        from: node.state,
        to: nextState,
        action: candidate.action,
        heightDelta: candidate.heightDelta,
        dig: validation.dig,
        fill: validation.fill,
      });
      queue.push({
        state: nextState,
        states: Object.freeze([...node.states, nextState]),
        steps: Object.freeze([...node.steps, step]),
        cost: nextCost,
      });
      queue.sort(compareSearchNodeCost);
    }
  }

  return {
    diagnostics: freezeDiagnostics({ exploredStates, rejectedSteps }),
  };
}

function calculateStepCost(
  current: Readonly<StairBFSState>,
  candidate: Readonly<{
    readonly nextDir: StairBFSDirection;
    readonly heightDelta: -1 | 0 | 1;
  }>,
  validation: Readonly<StairBFSStepValidation>,
): number {
  return (
    STEP_BASE_COST +
    validation.dig.length * STEP_DIG_COST +
    validation.fill.length * STEP_FILL_COST +
    (current.dir === candidate.nextDir ? 0 : STEP_TURN_COST) +
    (candidate.heightDelta === 0 ? 0 : STEP_HEIGHT_CHANGE_COST)
  );
}

function compareSearchNodeCost(left: Readonly<SearchNode>, right: Readonly<SearchNode>): number {
  const costDelta = left.cost - right.cost;
  if (costDelta !== 0) {
    return costDelta;
  }

  return left.steps.length - right.steps.length;
}

function listCandidates(state: StairBFSState): readonly {
  readonly action: StairBFSStep["action"];
  readonly nextDir: StairBFSDirection;
  readonly heightDelta: -1 | 0 | 1;
  readonly next: StairBFSBlockPos;
}[] {
  const straight = state.dir;
  const left = turnLeft(state.dir);
  const right = turnRight(state.dir);
  const stairDelta = state.mode === "down" ? -1 : 1;
  return Object.freeze([
    createCandidate(state, straight, stairDelta, "forward"),
    createCandidate(state, left, stairDelta, "turn_left"),
    createCandidate(state, right, stairDelta, "turn_right"),
    createCandidate(state, straight, 0, "cave_forward"),
    createCandidate(state, left, 0, "cave_left"),
    createCandidate(state, right, 0, "cave_right"),
  ]);
}

function createCandidate(
  state: StairBFSState,
  nextDir: StairBFSDirection,
  heightDelta: -1 | 0 | 1,
  action: StairBFSStep["action"],
): {
  readonly action: StairBFSStep["action"];
  readonly nextDir: StairBFSDirection;
  readonly heightDelta: -1 | 0 | 1;
  readonly next: StairBFSBlockPos;
} {
  const vector = directionVector(nextDir);
  return Object.freeze({
    action,
    nextDir,
    heightDelta,
    next: freezePos({
      x: state.pos.x + vector.x,
      y: state.pos.y + heightDelta,
      z: state.pos.z + vector.z,
    }),
  });
}

function isStartStateValid(
  scanner: StairBFSWorldScanner,
  start: StairBFSState,
  safetyChecker: StairBFSSafetyChecker,
): boolean {
  const validation = safetyChecker.isValidStep({
    scanner,
    current: start,
    next: start.pos,
    nextDir: start.dir,
    heightDelta: 0,
    allowFill: false,
    maxFillBlocks: 0,
  });
  return validation.ok && validation.dig.length === 0 && validation.fill.length === 0;
}

function isGoalReached(state: StairBFSState, goal: StairBFSGoal, steps: number): boolean {
  if (goal.minSteps !== undefined && steps < goal.minSteps) {
    return false;
  }
  if (goal.target !== undefined && !samePos(state.pos, goal.target)) {
    return false;
  }
  if (goal.yAtMost !== undefined && state.pos.y > goal.yAtMost) {
    return false;
  }
  if (goal.yAtLeast !== undefined && state.pos.y < goal.yAtLeast) {
    return false;
  }
  return (
    goal.target !== undefined ||
    goal.yAtMost !== undefined ||
    goal.yAtLeast !== undefined ||
    goal.minSteps !== undefined
  );
}

function normalizeMaxSteps(value: number | undefined): number | undefined {
  const maxSteps = value ?? DEFAULT_MAX_STEPS;
  if (!Number.isInteger(maxSteps) || maxSteps <= 0 || maxSteps > MAX_SHORT_SEGMENT_STEPS) {
    return undefined;
  }
  return maxSteps;
}

function directionVector(dir: StairBFSDirection): { readonly x: number; readonly z: number } {
  switch (dir) {
    case "north":
      return { x: 0, z: -1 };
    case "east":
      return { x: 1, z: 0 };
    case "south":
      return { x: 0, z: 1 };
    case "west":
      return { x: -1, z: 0 };
  }
}

function turnLeft(dir: StairBFSDirection): StairBFSDirection {
  switch (dir) {
    case "north":
      return "west";
    case "west":
      return "south";
    case "south":
      return "east";
    case "east":
      return "north";
  }
}

function turnRight(dir: StairBFSDirection): StairBFSDirection {
  switch (dir) {
    case "north":
      return "east";
    case "east":
      return "south";
    case "south":
      return "west";
    case "west":
      return "north";
  }
}

function isOppositeDirection(left: StairBFSDirection, right: StairBFSDirection): boolean {
  return (
    (left === "north" && right === "south") ||
    (left === "south" && right === "north") ||
    (left === "east" && right === "west") ||
    (left === "west" && right === "east")
  );
}

function readKnownBlock(
  scanner: StairBFSWorldScanner,
  pos: Readonly<StairBFSBlockPos>,
): StairBFSBlock | undefined {
  return scanner.getBlock(pos);
}

function readRequiredBlock(
  scanner: StairBFSWorldScanner,
  pos: Readonly<StairBFSBlockPos>,
): StairBFSBlock {
  const block = readKnownBlock(scanner, pos);
  if (block === undefined) {
    throw new Error(`StairBFS block is unknown at ${posKey(pos)}`);
  }
  return block;
}

function hasNearbyRole(
  scanner: StairBFSWorldScanner,
  centers: readonly StairBFSBlockPos[],
  role: StairBFSBlockRole,
  riskReason: StairBFSStepRejectReason,
): StairBFSStepRejectReason | undefined {
  for (const center of centers) {
    for (const neighbor of neighborsWithinOne(center)) {
      const block = readKnownBlock(scanner, neighbor);
      if (block === undefined) {
        return "unknown_block";
      }
      if (block.role === role) {
        return riskReason;
      }
    }
  }
  return undefined;
}

function hasDeepPitRisk(scanner: StairBFSWorldScanner, floor: StairBFSBlockPos): boolean {
  const belowOne = readKnownBlock(scanner, addY(floor, -1));
  const belowTwo = readKnownBlock(scanner, addY(floor, -2));
  return (
    belowOne === undefined ||
    belowTwo === undefined ||
    (belowOne.role === "air" && belowTwo.role === "air")
  );
}

function neighborsWithinOne(center: StairBFSBlockPos): readonly StairBFSBlockPos[] {
  const neighbors: StairBFSBlockPos[] = [];
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dz = -1; dz <= 1; dz += 1) {
        if (dx === 0 && dy === 0 && dz === 0) {
          continue;
        }
        neighbors.push(freezePos({ x: center.x + dx, y: center.y + dy, z: center.z + dz }));
      }
    }
  }
  return Object.freeze(neighbors);
}

function isBodySpaceClearOrMineable(block: StairBFSBlock): boolean {
  return block.role === "air" || block.role === "mineable" || block.role === "ore";
}

function shouldDigForBodySpace(block: StairBFSBlock): boolean {
  return block.role === "mineable" || block.role === "ore";
}

function isSupportBlock(block: StairBFSBlock): boolean {
  return (
    block.role === "solid" ||
    block.role === "mineable" ||
    block.role === "ore" ||
    block.role === "low_value_fill"
  );
}

function isLava(block: StairBFSBlock): boolean {
  return block.role === "lava";
}

function isWater(block: StairBFSBlock): boolean {
  return block.role === "water";
}

function addY(pos: Readonly<StairBFSBlockPos>, dy: number): StairBFSBlockPos {
  return freezePos({ x: pos.x, y: pos.y + dy, z: pos.z });
}

function samePos(left: Readonly<StairBFSBlockPos>, right: Readonly<StairBFSBlockPos>): boolean {
  return left.x === right.x && left.y === right.y && left.z === right.z;
}

function posKey(pos: Readonly<StairBFSBlockPos>): string {
  return `${pos.x},${pos.y},${pos.z}`;
}

function stateKey(state: Readonly<StairBFSState>): string {
  return `${posKey(state.pos)},${state.dir},${state.mode},${state.usedFill}`;
}

function invalidStep(reason: StairBFSStepRejectReason): StairBFSStepValidation {
  return Object.freeze({
    ok: false,
    reason,
    dig: Object.freeze([]),
    fill: Object.freeze([]),
  });
}

function validStep(
  dig: readonly StairBFSBlockPos[],
  fill: readonly StairBFSBlockPos[],
): StairBFSStepValidation {
  return Object.freeze({
    ok: true,
    dig: Object.freeze(dig.map(freezePos)),
    fill: Object.freeze(fill.map(freezePos)),
  });
}

function emptyDiagnostics(): StairBFSPlanDiagnostics {
  return freezeDiagnostics({ exploredStates: 0, rejectedSteps: [] });
}

function mergeDiagnostics(
  first: Readonly<StairBFSPlanDiagnostics>,
  second: Readonly<StairBFSPlanDiagnostics>,
): StairBFSPlanDiagnostics {
  return freezeDiagnostics({
    exploredStates: first.exploredStates + second.exploredStates,
    rejectedSteps: [...first.rejectedSteps, ...second.rejectedSteps],
  });
}

function freezeSuccess(
  phase: StairBFSPlanSuccess["phase"],
  route: Readonly<StairBFSRoute>,
  diagnostics: Readonly<StairBFSPlanDiagnostics>,
): StairBFSPlanSuccess {
  return Object.freeze({
    ok: true,
    phase,
    route: freezeRoute(route),
    diagnostics: freezeDiagnostics(diagnostics),
  });
}

function freezeFailure(
  reason: StairBFSPlanFailure["reason"],
  diagnostics: Readonly<StairBFSPlanDiagnostics>,
): StairBFSPlanFailure {
  return Object.freeze({
    ok: false,
    reason,
    diagnostics: freezeDiagnostics(diagnostics),
  });
}

function freezeDiagnostics(input: Readonly<StairBFSPlanDiagnostics>): StairBFSPlanDiagnostics {
  return Object.freeze({
    exploredStates: input.exploredStates,
    rejectedSteps: Object.freeze(input.rejectedSteps.map(freezeRejectedStep)),
  });
}

function freezeRejectedStep(input: Readonly<StairBFSRejectedStep>): StairBFSRejectedStep {
  return Object.freeze({
    from: freezeState(input.from),
    next: freezePos(input.next),
    reason: input.reason,
  });
}

function freezeRoute(input: Readonly<StairBFSRoute>): StairBFSRoute {
  return Object.freeze({
    states: Object.freeze(input.states.map(freezeState)),
    steps: Object.freeze(input.steps.map(freezeStep)),
  });
}

function freezeStep(input: Readonly<StairBFSStep>): StairBFSStep {
  return Object.freeze({
    from: freezeState(input.from),
    to: freezeState(input.to),
    action: input.action,
    heightDelta: input.heightDelta,
    dig: Object.freeze(input.dig.map(freezePos)),
    fill: Object.freeze(input.fill.map(freezePos)),
  });
}

function freezeState(input: Readonly<StairBFSState>): StairBFSState {
  return Object.freeze({
    pos: freezePos(input.pos),
    dir: input.dir,
    mode: input.mode,
    usedFill: input.usedFill,
  });
}

function freezePos(input: Readonly<StairBFSBlockPos>): StairBFSBlockPos {
  return Object.freeze({
    x: input.x,
    y: input.y,
    z: input.z,
  });
}
