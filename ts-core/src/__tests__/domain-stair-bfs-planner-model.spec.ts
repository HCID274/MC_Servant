import { describe, expect, it } from "vitest";

import {
  type StairBFSBlock,
  type StairBFSBlockPos,
  type StairBFSBlockRole,
  type StairBFSState,
  createDefaultStairBFSSafetyChecker,
  createNoopStairBFSOreHandler,
  createStairBFSPlanner,
} from "../domain/index.js";

class FakeStairBFSWorld {
  private readonly blocks = new Map<string, StairBFSBlockRole>();
  private readonly unknownBlocks = new Set<string>();

  public constructor(private readonly defaultRole: StairBFSBlockRole = "solid") {}

  public set(pos: Readonly<StairBFSBlockPos>, role: StairBFSBlockRole): void {
    this.blocks.set(posKey(pos), role);
    this.unknownBlocks.delete(posKey(pos));
  }

  public setUnknown(pos: Readonly<StairBFSBlockPos>): void {
    const key = posKey(pos);
    this.blocks.delete(key);
    this.unknownBlocks.add(key);
  }

  public setBody(
    pos: Readonly<StairBFSBlockPos>,
    foot: StairBFSBlockRole,
    head: StairBFSBlockRole,
    top: StairBFSBlockRole = "air",
  ): void {
    this.set(pos, foot);
    this.set({ x: pos.x, y: pos.y + 1, z: pos.z }, head);
    this.set({ x: pos.x, y: pos.y + 2, z: pos.z }, top);
  }

  public setFloor(pos: Readonly<StairBFSBlockPos>, role: StairBFSBlockRole): void {
    this.set({ x: pos.x, y: pos.y - 1, z: pos.z }, role);
  }

  public getBlock(pos: Readonly<StairBFSBlockPos>): StairBFSBlock | undefined {
    if (this.unknownBlocks.has(posKey(pos))) {
      return undefined;
    }

    return Object.freeze({
      pos: Object.freeze({ x: pos.x, y: pos.y, z: pos.z }),
      role: this.blocks.get(posKey(pos)) ?? this.defaultRole,
    });
  }
}

const planner = createStairBFSPlanner();
const startDown: StairBFSState = {
  pos: { x: 0, y: 10, z: 0 },
  dir: "north",
  mode: "down",
  usedFill: 0,
};
const startUp: StairBFSState = {
  pos: { x: 0, y: 8, z: 0 },
  dir: "north",
  mode: "up",
  usedFill: 0,
};

describe("StairBFSPlanner（阶梯广度优先规划器）", () => {
  it("应规划挖开三格通行空间的安全下降短段", () => {
    const world = createBaseWorld(startDown);
    setDescendingStep(world, { x: 0, y: 9, z: -1 }, "mineable", "mineable", "solid");
    setDescendingStep(world, { x: 0, y: 8, z: -2 }, "mineable", "mineable", "solid");

    const result = planner.plan({
      scanner: world,
      start: startDown,
      goal: { yAtMost: 8 },
      maxSteps: 8,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.phase).toBe("no_fill");
    expect(result.route.steps).toHaveLength(2);
    expect(result.route.steps[0].heightDelta).toBe(-1);
    expect(result.route.steps[0].dig).toEqual([
      { x: 0, y: 9, z: -1 },
      { x: 0, y: 10, z: -1 },
      { x: 0, y: 11, z: -1 },
    ]);
    expect(result.route.steps[0].fill).toEqual([]);
    expect(result.route.states.at(-1)?.pos).toEqual({ x: 0, y: 8, z: -2 });
  });

  it("应规划安全上升短段并保留 nextFloor（下一地板）", () => {
    const world = createBaseWorld(startUp);
    setAscendingStep(world, { x: 0, y: 9, z: -1 }, "mineable", "mineable", "solid");
    setAscendingStep(world, { x: 0, y: 10, z: -2 }, "mineable", "mineable", "solid");

    const result = planner.plan({
      scanner: world,
      start: startUp,
      goal: { yAtLeast: 10 },
      maxSteps: 8,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.phase).toBe("no_fill");
    expect(result.route.steps.map((step) => step.heightDelta)).toEqual([1, 1]);
    expect(result.route.steps[0].dig).toEqual([
      { x: 0, y: 9, z: -1 },
      { x: 0, y: 10, z: -1 },
      { x: 0, y: 11, z: -1 },
    ]);
    expect(result.route.steps[0].fill).toEqual([]);
  });

  it("应在直线路线遇到 lava（岩浆） 风险时用 BFS（广度优先搜索） 绕路", () => {
    const world = createBaseWorld(startDown);
    setDescendingStep(world, { x: 0, y: 9, z: -1 }, "mineable", "mineable", "solid");
    setDescendingStep(world, { x: 0, y: 8, z: -2 }, "mineable", "mineable", "solid");
    world.set({ x: 0, y: 7, z: -2 }, "lava");
    setDescendingStep(world, { x: -1, y: 9, z: 0 }, "mineable", "mineable", "solid");
    setDescendingStep(world, { x: -2, y: 8, z: 0 }, "mineable", "mineable", "solid");

    const result = planner.plan({
      scanner: world,
      start: startDown,
      goal: { target: { x: -2, y: 8, z: 0 } },
      maxSteps: 8,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.route.steps.map((step) => step.action)).toEqual(["turn_left", "forward"]);
    expect(result.route.states.at(-1)?.pos).toEqual({ x: -2, y: 8, z: 0 });
    expect(result.diagnostics.rejectedSteps.map((step) => step.reason)).toContain("lava_risk");
  });

  it("应在第一阶段失败后第二阶段才允许低价值方块补路", () => {
    const world = createBaseWorld(startDown);
    setDescendingStep(world, { x: 0, y: 9, z: -1 }, "mineable", "mineable", "air");

    const firstPhase = planner.plan({
      scanner: world,
      start: startDown,
      goal: { target: { x: 0, y: 9, z: -1 } },
      maxSteps: 8,
    });
    const secondPhase = planner.plan({
      scanner: world,
      start: startDown,
      goal: { target: { x: 0, y: 9, z: -1 } },
      maxSteps: 8,
      maxFillBlocks: 1,
    });

    expect(firstPhase.ok).toBe(false);
    expect(firstPhase.diagnostics.rejectedSteps.map((step) => step.reason)).toContain(
      "fill_not_allowed",
    );
    expect(secondPhase.ok).toBe(true);
    if (!secondPhase.ok) {
      return;
    }
    expect(secondPhase.phase).toBe("fill");
    expect(secondPhase.route.steps[0].fill).toEqual([{ x: 0, y: 8, z: -1 }]);
  });

  it("应拒绝 lava（岩浆） 邻近风险", () => {
    const world = createBaseWorld(startDown);
    setDescendingStep(world, { x: 0, y: 9, z: -1 }, "mineable", "mineable", "solid");
    setDescendingStep(world, { x: 0, y: 8, z: -2 }, "mineable", "mineable", "solid");
    world.set({ x: 0, y: 7, z: -2 }, "lava");

    const result = planner.plan({
      scanner: world,
      start: startDown,
      goal: { target: { x: 0, y: 8, z: -2 } },
      maxSteps: 2,
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics.rejectedSteps.map((step) => step.reason)).toContain("lava_risk");
  });

  it("应拒绝 unknown block（未知方块） 邻近风险，不能把未加载区域当作安全", () => {
    const world = createBaseWorld(startDown);
    setDescendingStep(world, { x: 0, y: 9, z: -1 }, "mineable", "mineable", "solid");
    world.setUnknown({ x: 1, y: 9, z: -1 });
    const checker = createDefaultStairBFSSafetyChecker();

    const validation = checker.isValidStep({
      scanner: world,
      current: startDown,
      next: { x: 0, y: 9, z: -1 },
      nextDir: "north",
      heightDelta: -1,
      allowFill: false,
      maxFillBlocks: 0,
    });

    expect(validation.ok).toBe(false);
    expect(validation.reason).toBe("unknown_block");
  });

  it("应拒绝深坑和悬空地面风险", () => {
    const world = createBaseWorld(startDown);
    setDescendingStep(world, { x: 0, y: 9, z: -1 }, "mineable", "mineable", "solid");
    world.set({ x: 0, y: 7, z: -1 }, "air");
    world.set({ x: 0, y: 6, z: -1 }, "air");

    const result = planner.plan({
      scanner: world,
      start: startDown,
      goal: { target: { x: 0, y: 9, z: -1 } },
      maxSteps: 1,
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics.rejectedSteps.map((step) => step.reason)).toContain("deep_pit_risk");
  });

  it("应直接拒绝反向下降，避免垂直翻折破坏可返回阶梯", () => {
    const world = createBaseWorld(startDown);
    setDescendingStep(world, { x: 0, y: 9, z: 1 }, "mineable", "mineable", "solid");
    const checker = createDefaultStairBFSSafetyChecker();

    const validation = checker.isValidStep({
      scanner: world,
      current: startDown,
      next: { x: 0, y: 9, z: 1 },
      nextDir: "south",
      heightDelta: -1,
      allowFill: false,
      maxFillBlocks: 0,
    });

    expect(validation.ok).toBe(false);
    expect(validation.reason).toBe("reverse_down_step");
  });

  it("应优先复用当前快照中已成型的低挖掘代价阶梯", () => {
    const world = createBaseWorld(startDown);
    setDescendingStep(world, { x: 0, y: 9, z: -1 }, "mineable", "mineable", "solid");
    setDescendingStep(world, { x: 0, y: 8, z: -2 }, "mineable", "mineable", "solid");
    setDescendingStep(world, { x: 1, y: 9, z: 0 }, "air", "air", "solid");
    setDescendingStep(world, { x: 2, y: 8, z: 0 }, "air", "air", "solid");

    const result = planner.plan({
      scanner: world,
      start: startDown,
      goal: { yAtMost: 8 },
      maxSteps: 8,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.route.steps.map((step) => step.action)).toEqual(["turn_right", "forward"]);
    expect(result.route.steps.flatMap((step) => step.dig)).toEqual([]);
    expect(result.route.states.at(-1)?.pos).toEqual({ x: 2, y: 8, z: 0 });
  });

  it("应提供 OreHandler（矿石处理器） 只读契约占位而不执行采矿", () => {
    const oreHandler = createNoopStairBFSOreHandler();

    expect(
      oreHandler.findReachableOreTargets({
        states: [startDown],
        steps: [],
      }),
    ).toEqual([]);
  });
});

function createBaseWorld(start: Readonly<StairBFSState>): FakeStairBFSWorld {
  const world = new FakeStairBFSWorld("solid");
  world.setBody(start.pos, "air", "air");
  world.setFloor(start.pos, "solid");
  return world;
}

function setDescendingStep(
  world: FakeStairBFSWorld,
  next: Readonly<StairBFSBlockPos>,
  foot: StairBFSBlockRole,
  head: StairBFSBlockRole,
  floor: StairBFSBlockRole,
): void {
  world.setBody(next, foot, head, head);
  world.set({ x: next.x, y: next.y - 1, z: next.z }, floor);
}

function setAscendingStep(
  world: FakeStairBFSWorld,
  next: Readonly<StairBFSBlockPos>,
  foot: StairBFSBlockRole,
  head: StairBFSBlockRole,
  floor: StairBFSBlockRole,
): void {
  world.setBody(next, foot, head, head);
  world.set({ x: next.x, y: next.y - 1, z: next.z }, floor);
}

function posKey(pos: Readonly<StairBFSBlockPos>): string {
  return `${pos.x},${pos.y},${pos.z}`;
}
