"use strict";

const Vec3 = require("vec3");

function toIntPosition(value) {
  return {
    x: Math.floor(Number(value?.x || 0)),
    y: Math.floor(Number(value?.y || 0)),
    z: Math.floor(Number(value?.z || 0)),
  };
}

function toFeetPosition(bot) {
  return toIntPosition(bot?.entity?.position);
}

function keyOf(position) {
  return `${position.x},${position.y},${position.z}`;
}

function stateKeyOf(position, moveMeta) {
  return `${keyOf(position)}|${String(moveMeta?.dir || "none")}|${Number(moveMeta?.dy || 0)}`;
}

function samePosition(left, right) {
  return !!left && !!right
    && Number(left.x) === Number(right.x)
    && Number(left.y) === Number(right.y)
    && Number(left.z) === Number(right.z);
}

function blockAt(bot, position) {
  return bot.blockAt(Vec3(position.x, position.y, position.z));
}

function blockPayload(block) {
  if (!block) {
    return null;
  }
  return {
    name: String(block.name || ""),
    diggable: Boolean(block.diggable),
    bounding_box: String(block.boundingBox || ""),
    position: {
      x: Number(block.position?.x || 0),
      y: Number(block.position?.y || 0),
      z: Number(block.position?.z || 0),
    },
  };
}

function isSolidBlock(block) {
  return !!block && String(block.boundingBox || "") === "block";
}

function isLiquidBlock(block) {
  return Boolean(block?.liquid);
}

function isPassableBlock(block) {
  return !block || (!isSolidBlock(block) && !isLiquidBlock(block));
}

function isDigClearableBlock(block) {
  return isPassableBlock(block) || Boolean(block?.diggable);
}

function distanceSquared(left, right) {
  const dx = Number(left.x) - Number(right.x);
  const dy = Number(left.y) - Number(right.y);
  const dz = Number(left.z) - Number(right.z);
  return (dx * dx) + (dy * dy) + (dz * dz);
}

function oppositeDirection(direction) {
  if (direction === "east") {
    return "west";
  }
  if (direction === "west") {
    return "east";
  }
  if (direction === "north") {
    return "south";
  }
  if (direction === "south") {
    return "north";
  }
  return "";
}

function cardinalDirection(dx, dz) {
  if (dx > 0) {
    return "east";
  }
  if (dx < 0) {
    return "west";
  }
  if (dz > 0) {
    return "south";
  }
  if (dz < 0) {
    return "north";
  }
  return "";
}

function isGoalStand(position, target) {
  const dx = Math.abs(Number(position.x) - Number(target.x));
  const dy = Math.abs(Number(position.y) - Number(target.y));
  const dz = Math.abs(Number(position.z) - Number(target.z));
  return (dx + dz) === 1 && dy <= 1;
}

function inventorySummary(bot) {
  const items = bot?.inventory && typeof bot.inventory.items === "function"
    ? bot.inventory.items()
    : [];
  const counts = {};
  for (const item of items || []) {
    const name = String(item?.name || "").trim();
    if (!name) {
      continue;
    }
    counts[name] = (counts[name] || 0) + Number(item?.count || 0);
  }
  return Object.fromEntries(
    Object.entries(counts).sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
  );
}

function buildBounds(start, target, options = {}) {
  const horizontalPadding = Math.max(Number(options.horizontalPadding || 8), 3);
  const verticalPadding = Math.max(Number(options.verticalPadding || 6), 2);
  return {
    minX: Math.min(start.x, target.x) - horizontalPadding,
    maxX: Math.max(start.x, target.x) + horizontalPadding,
    minY: Math.min(start.y, target.y) - verticalPadding,
    maxY: Math.max(start.y, target.y) + verticalPadding,
    minZ: Math.min(start.z, target.z) - horizontalPadding,
    maxZ: Math.max(start.z, target.z) + horizontalPadding,
  };
}

function withinBounds(position, bounds) {
  return position.x >= bounds.minX
    && position.x <= bounds.maxX
    && position.y >= bounds.minY
    && position.y <= bounds.maxY
    && position.z >= bounds.minZ
    && position.z <= bounds.maxZ;
}

function positionPayload(position) {
  return {
    x: Number(position.x),
    y: Number(position.y),
    z: Number(position.z),
  };
}

function digBlockCandidates(position) {
  return [
    { x: position.x, y: position.y + 1, z: position.z, role: "head" },
    { x: position.x, y: position.y, z: position.z, role: "feet" },
  ];
}

function evaluateStandCandidate(bot, position, target, counters) {
  const support = { x: position.x, y: position.y - 1, z: position.z };
  if (samePosition(support, target)) {
    counters.support_is_target = (counters.support_is_target || 0) + 1;
    return { ok: false, reason: "support_is_target" };
  }

  const supportBlock = blockAt(bot, support);
  if (!isSolidBlock(supportBlock)) {
    counters.no_support = (counters.no_support || 0) + 1;
    return { ok: false, reason: "no_support" };
  }

  const clearBlocks = [];
  for (const candidate of digBlockCandidates(position)) {
    if (samePosition(candidate, target)) {
      counters.target_in_corridor = (counters.target_in_corridor || 0) + 1;
      return { ok: false, reason: "target_in_corridor" };
    }
    const block = blockAt(bot, candidate);
    if (isPassableBlock(block)) {
      continue;
    }
    if (!isDigClearableBlock(block)) {
      const counterKey = candidate.role === "head" ? "blocked_head_undiggable" : "blocked_feet_undiggable";
      counters[counterKey] = (counters[counterKey] || 0) + 1;
      return { ok: false, reason: counterKey };
    }
    clearBlocks.push({
      x: candidate.x,
      y: candidate.y,
      z: candidate.z,
      role: candidate.role,
      block: blockPayload(block),
    });
  }

  return {
    ok: true,
    clearBlocks,
    support: blockPayload(supportBlock),
  };
}

function reconstructPath(nodes, endKey) {
  const path = [];
  let cursor = endKey;
  while (cursor) {
    const node = nodes.get(cursor);
    if (!node) {
      break;
    }
    path.push({
      position: positionPayload(node.position),
      clear_blocks: Array.isArray(node.clearBlocks) ? node.clearBlocks : [],
      support: node.support || null,
    });
    cursor = node.prevStateKey;
  }
  path.reverse();
  return path;
}

function buildNeighborMoves(current) {
  const candidates = [
    { x: current.x + 1, y: current.y, z: current.z, dx: 1, dy: 0, dz: 0 },
    { x: current.x - 1, y: current.y, z: current.z, dx: -1, dy: 0, dz: 0 },
    { x: current.x, y: current.y, z: current.z + 1, dx: 0, dy: 0, dz: 1 },
    { x: current.x, y: current.y, z: current.z - 1, dx: 0, dy: 0, dz: -1 },
    { x: current.x + 1, y: current.y + 1, z: current.z, dx: 1, dy: 1, dz: 0 },
    { x: current.x - 1, y: current.y + 1, z: current.z, dx: -1, dy: 1, dz: 0 },
    { x: current.x, y: current.y + 1, z: current.z + 1, dx: 0, dy: 1, dz: 1 },
    { x: current.x, y: current.y + 1, z: current.z - 1, dx: 0, dy: 1, dz: -1 },
    { x: current.x + 1, y: current.y - 1, z: current.z, dx: 1, dy: -1, dz: 0 },
    { x: current.x - 1, y: current.y - 1, z: current.z, dx: -1, dy: -1, dz: 0 },
    { x: current.x, y: current.y - 1, z: current.z + 1, dx: 0, dy: -1, dz: 1 },
    { x: current.x, y: current.y - 1, z: current.z - 1, dx: 0, dy: -1, dz: -1 },
  ];
  return candidates.map((item) => ({
    x: item.x,
    y: item.y,
    z: item.z,
    moveMeta: {
      dx: item.dx,
      dy: item.dy,
      dz: item.dz,
      dir: cardinalDirection(item.dx, item.dz),
    },
  }));
}

function shouldUseSpiralDescent(start, target, options = {}) {
  const verticalDelta = Math.abs(Number(start.y) - Number(target.y));
  const threshold = Math.max(Number(options.spiralThreshold || 6), 4);
  return verticalDelta >= threshold;
}

function descendingPatternPenalty(previousMove, nextMove) {
  if (!previousMove || previousMove.dy >= 0 || nextMove.dy >= 0) {
    return 0;
  }
  if (!previousMove.dir || !nextMove.dir) {
    return 0;
  }
  if (nextMove.dir === oppositeDirection(previousMove.dir)) {
    return 99;
  }
  if (nextMove.dir === previousMove.dir) {
    return 2;
  }
  return 0;
}

function sortedNeighbors(currentState, target, options = {}) {
  const spiralDescent = shouldUseSpiralDescent(currentState.position, target, options);
  const previousMove = currentState.moveMeta || null;
  return buildNeighborMoves(currentState.position)
    .filter((candidate) => {
      if (!spiralDescent) {
        return true;
      }
      const penalty = descendingPatternPenalty(previousMove, candidate.moveMeta);
      return penalty < 99;
    })
    .sort((left, right) => {
      const leftPenalty = spiralDescent ? descendingPatternPenalty(previousMove, left.moveMeta) : 0;
      const rightPenalty = spiralDescent ? descendingPatternPenalty(previousMove, right.moveMeta) : 0;
      if (leftPenalty !== rightPenalty) {
        return leftPenalty - rightPenalty;
      }
      return distanceSquared(left, target) - distanceSquared(right, target);
    });
}

function planStairPath(bot, targetInput, options = {}) {
  const start = toFeetPosition(bot);
  const target = toIntPosition(targetInput);
  const bounds = buildBounds(start, target, options);
  const maxNodes = Math.max(Number(options.maxNodes || 20000), 64);
  const counters = {};

  if (samePosition(start, target)) {
    return {
      ok: false,
      error: "Bot 当前正站在目标方块坐标上，无法对脚下目标做楼梯式接近",
      start: positionPayload(start),
      target: positionPayload(target),
      bounds,
      rejection_counts: counters,
    };
  }

  const startStateKey = stateKeyOf(start, null);
  const queue = [{
    position: start,
    moveMeta: null,
    stateKey: startStateKey,
  }];
  const visited = new Set([startStateKey]);
  const nodes = new Map([
    [startStateKey, { position: start, prevStateKey: null, clearBlocks: [], support: null, moveMeta: null }],
  ]);

  let expandedNodes = 0;
  let goalKey = null;

  while (queue.length) {
    const currentState = queue.shift();
    const current = currentState.position;
    expandedNodes += 1;

    if (isGoalStand(current, target)) {
      goalKey = currentState.stateKey;
      break;
    }
    if (visited.size >= maxNodes) {
      counters.max_nodes_reached = (counters.max_nodes_reached || 0) + 1;
      break;
    }

    for (const next of sortedNeighbors(currentState, target, options)) {
      if (!withinBounds(next, bounds)) {
        counters.out_of_bounds = (counters.out_of_bounds || 0) + 1;
        continue;
      }
      const nextStateKey = stateKeyOf(next, next.moveMeta);
      if (visited.has(nextStateKey)) {
        counters.visited_skip = (counters.visited_skip || 0) + 1;
        continue;
      }

      const evaluated = evaluateStandCandidate(bot, next, target, counters);
      if (!evaluated.ok) {
        continue;
      }

      visited.add(nextStateKey);
      nodes.set(nextStateKey, {
        position: next,
        prevStateKey: currentState.stateKey,
        clearBlocks: evaluated.clearBlocks,
        support: evaluated.support,
        moveMeta: next.moveMeta,
      });
      queue.push({
        position: next,
        moveMeta: next.moveMeta,
        stateKey: nextStateKey,
      });
    }
  }

  if (!goalKey) {
    return {
      ok: false,
      error: "未找到满足楼梯约束的可达路径",
      start: positionPayload(start),
      target: positionPayload(target),
      bounds,
      expanded_nodes: expandedNodes,
      visited_nodes: visited.size,
      rejection_counts: counters,
    };
  }

  const path = reconstructPath(nodes, goalKey);
  return {
    ok: true,
    start: positionPayload(start),
    target: positionPayload(target),
    goal_stand: path[path.length - 1]?.position || positionPayload(start),
    bounds,
    expanded_nodes: expandedNodes,
    visited_nodes: visited.size,
    rejection_counts: counters,
    path,
  };
}

async function ensureTool(bot, block) {
  const equipForBlock = bot?.tool && typeof bot.tool.equipForBlock === "function"
    ? bot.tool.equipForBlock.bind(bot.tool)
    : null;
  if (!equipForBlock || !block) {
    return;
  }
  await equipForBlock(block, {
    requireHarvest: true,
    getFromChest: false,
    maxTools: 2,
  });
}

async function digIfNeeded(bot, position, trace) {
  const liveBlock = blockAt(bot, position);
  if (isPassableBlock(liveBlock)) {
    return;
  }
  if (!Boolean(liveBlock?.diggable)) {
    throw new Error(`Block at ${keyOf(position)} is not diggable`);
  }
  await ensureTool(bot, liveBlock);
  await bot.dig(liveBlock);
  trace.dug_blocks.push({
    position: positionPayload(position),
    block: blockPayload(liveBlock),
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function blockAroundPayload(bot, position) {
  return {
    feet: blockPayload(blockAt(bot, position)),
    head: blockPayload(blockAt(bot, { x: position.x, y: position.y + 1, z: position.z })),
    support: blockPayload(blockAt(bot, { x: position.x, y: position.y - 1, z: position.z })),
  };
}

function clearMotion(bot) {
  if (!bot || typeof bot.setControlState !== "function") {
    return;
  }
  for (const state of ["forward", "back", "left", "right", "jump", "sneak", "sprint"]) {
    try {
      bot.setControlState(state, false);
    } catch (_error) {
      // Best effort cleanup only.
    }
  }
}

function reachedStand(bot, targetPosition) {
  const current = bot?.entity?.position;
  if (!current) {
    return false;
  }
  const dx = Math.abs((Number(current.x) - 0.5) - Number(targetPosition.x));
  const dz = Math.abs((Number(current.z) - 0.5) - Number(targetPosition.z));
  const dy = Math.abs(Number(current.y) - Number(targetPosition.y));
  return samePosition(toFeetPosition(bot), targetPosition) || (dx <= 0.45 && dz <= 0.45 && dy <= 0.8);
}

async function orientTowards(bot, targetPosition) {
  if (!bot || typeof bot.lookAt !== "function") {
    return;
  }
  const eyeTarget = Vec3(
    Number(targetPosition.x) + 0.5,
    Number(targetPosition.y) + 0.5,
    Number(targetPosition.z) + 0.5,
  );
  try {
    await bot.lookAt(eyeTarget, true);
  } catch (_error) {
    // Some servers/versions may reject repeated lookAt calls; movement can still proceed.
  }
}

function transitionClearCandidates(fromPosition, targetPosition) {
  const dx = Number(targetPosition.x) - Number(fromPosition.x);
  const dy = Number(targetPosition.y) - Number(fromPosition.y);
  const dz = Number(targetPosition.z) - Number(fromPosition.z);
  const candidates = [];

  if (dy > 0) {
    candidates.push({ x: fromPosition.x, y: fromPosition.y + 2, z: fromPosition.z, role: "jump_head" });
  }
  if (dy < 0) {
    candidates.push({ x: fromPosition.x + dx, y: fromPosition.y + 1, z: fromPosition.z + dz, role: "drop_head" });
  }
  return candidates;
}

async function moveOneStep(bot, fromPosition, targetPosition, timeoutMs, trace) {
  const dy = Number(targetPosition.y) - Number(fromPosition.y);
  const startedAt = Date.now();
  const checkpoints = [];
  const hasTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0;

  try {
    while (!hasTimeout || (Date.now() - startedAt < timeoutMs)) {
      if (reachedStand(bot, targetPosition)) {
        return {
          duration_ms: Date.now() - startedAt,
          checkpoints,
        };
      }

      await orientTowards(bot, targetPosition);

      try {
        bot.setControlState("forward", true);
        bot.setControlState("jump", dy > 0);
        bot.setControlState("sprint", false);
        bot.setControlState("sneak", false);
      } catch (_error) {
        // Keep retrying until timeout.
      }

      checkpoints.push({
        at_ms: Date.now() - startedAt,
        bot_position: positionPayload(bot.entity.position),
        bot_feet: positionPayload(toFeetPosition(bot)),
      });
      if (checkpoints.length > 10) {
        checkpoints.shift();
      }
      await sleep(50);
    }
  } finally {
    clearMotion(bot);
  }

  throw new Error(
    JSON.stringify({
      message: `Step movement timeout for ${keyOf(targetPosition)}`,
      from: positionPayload(fromPosition),
      target: positionPayload(targetPosition),
      current_feet: positionPayload(toFeetPosition(bot)),
      current_position: positionPayload(bot?.entity?.position || toFeetPosition(bot)),
      current_blocks: blockAroundPayload(bot, toFeetPosition(bot)),
      target_blocks: blockAroundPayload(bot, targetPosition),
      checkpoints,
    }),
  );
}

module.exports = function createStairMiningHelper(bot, pathfinderModule, mcData) {
  return {
    planStairPathToBlockJson(target, options = {}) {
      return JSON.stringify(planStairPath(bot, target, options));
    },

    async executeStairPathToBlockJson(target, options = {}) {
      const plan = planStairPath(bot, target, options);
      if (!plan.ok) {
        return JSON.stringify({
          ...plan,
          phase: "plan",
        });
      }

      const trace = {
        dug_blocks: [],
        visited_steps: [],
      };
      const configuredStepTimeoutMs = Number(options.stepTimeoutMs);
      const stepTimeoutMs = Number.isFinite(configuredStepTimeoutMs) ? configuredStepTimeoutMs : 8000;
      const path = Array.isArray(plan.path) ? plan.path : [];

      try {
        for (let index = 1; index < path.length; index += 1) {
          const step = path[index];
          const previous = path[index - 1];
          for (const clearBlock of transitionClearCandidates(previous.position, step.position)) {
            await digIfNeeded(bot, clearBlock, trace);
          }
          for (const clearBlock of step.clear_blocks || []) {
            await digIfNeeded(bot, clearBlock, trace);
          }
          const movement = await moveOneStep(bot, previous.position, step.position, stepTimeoutMs, trace);
          trace.visited_steps.push({
            index,
            target: step.position,
            actual_bot_position: positionPayload(toFeetPosition(bot)),
            movement,
          });
        }

        const targetBlock = blockAt(bot, toIntPosition(target));
        if (!targetBlock) {
          throw new Error(`Target block missing at ${keyOf(target)}`);
        }
        if (!Boolean(targetBlock?.diggable)) {
          throw new Error(`Target block ${String(targetBlock?.name || "")} is not diggable`);
        }
        await ensureTool(bot, targetBlock);
        await bot.dig(targetBlock);

        return JSON.stringify({
          ok: true,
          phase: "execute",
          start: plan.start,
          target: plan.target,
          goal_stand: plan.goal_stand,
          expanded_nodes: plan.expanded_nodes,
          visited_nodes: plan.visited_nodes,
          rejection_counts: plan.rejection_counts,
          path,
          trace,
          final_bot_position: positionPayload(toFeetPosition(bot)),
          inventory_after: inventorySummary(bot),
          target_after: blockPayload(blockAt(bot, toIntPosition(target))),
        });
      } catch (error) {
        let errorType = String(error?.name || "StairMiningFailed");
        let errorMessage = String(error?.message || error || "stair mining failed");
        try {
          const parsed = JSON.parse(errorMessage);
          errorType = "StepMovementFailed";
          errorMessage = JSON.stringify(parsed);
        } catch (_parseError) {
          // Keep the original error message.
        }
        return JSON.stringify({
          ok: false,
          phase: "execute",
          error_type: errorType,
          error_message: errorMessage,
          start: plan.start,
          target: plan.target,
          goal_stand: plan.goal_stand,
          expanded_nodes: plan.expanded_nodes,
          visited_nodes: plan.visited_nodes,
          rejection_counts: plan.rejection_counts,
          path,
          trace,
          final_bot_position: positionPayload(toFeetPosition(bot)),
          inventory_after: inventorySummary(bot),
          target_after: blockPayload(blockAt(bot, toIntPosition(target))),
        });
      } finally {
        clearMotion(bot);
      }
    },
  };
};
