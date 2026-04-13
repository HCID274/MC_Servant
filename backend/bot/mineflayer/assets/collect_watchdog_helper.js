"use strict";

function normalizeName(value) {
  return String(value || "").trim();
}

function inventoryTotalFor(bot, itemNames) {
  const wanted = new Set(
    (Array.isArray(itemNames) ? itemNames : [])
      .map(normalizeName)
      .filter(Boolean),
  );
  if (!wanted.size) {
    return 0;
  }
  const items = bot && bot.inventory && typeof bot.inventory.items === "function"
    ? bot.inventory.items()
    : [];
  let total = 0;
  for (const item of items || []) {
    const name = normalizeName(item?.name);
    if (!wanted.has(name)) {
      continue;
    }
    total += Number(item?.count || 0);
  }
  return total;
}

function inventorySignatureFor(bot) {
  const items = bot && bot.inventory && typeof bot.inventory.items === "function"
    ? bot.inventory.items()
    : [];
  const counts = new Map();
  for (const item of items || []) {
    const name = normalizeName(item?.name);
    if (!name) {
      continue;
    }
    counts.set(name, (counts.get(name) || 0) + Number(item?.count || 0));
  }
  return Array.from(counts.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, count]) => `${name}:${count}`)
    .join("|");
}

function snapshotPosition(bot) {
  const position = bot?.entity?.position;
  if (!position) {
    return null;
  }
  return {
    x: Number(position.x),
    y: Number(position.y),
    z: Number(position.z),
  };
}

function hasMeaningfulMovement(previousPos, currentPos) {
  if (!previousPos || !currentPos) {
    return false;
  }
  const dx = Number(currentPos.x) - Number(previousPos.x);
  const dy = Number(currentPos.y) - Number(previousPos.y);
  const dz = Number(currentPos.z) - Number(previousPos.z);
  const horizontalDistance = Math.hypot(dx, dz);
  return horizontalDistance > 0.35 || Math.abs(dy) > 0.2;
}

function isAirBlockName(name) {
  return name === "air" || name === "cave_air" || name === "void_air";
}

function snapshotVec3(position) {
  if (!position) {
    return null;
  }
  return {
    x: Number(position.x),
    y: Number(position.y),
    z: Number(position.z),
  };
}

function buildDiagnostics(state, extra = {}) {
  return JSON.stringify({
    stall_timeout_ms: state.stallTimeoutMs,
    poll_interval_ms: state.pollIntervalMs,
    progress_event_count: state.progressEventCount,
    last_progress_reason: state.lastProgressReason,
    initial_inventory_count: state.initialInventoryCount,
    last_progress_inventory_count: state.lastProgressInventoryCount,
    current_inventory_count: state.currentInventoryCount,
    initial_inventory_signature: state.initialInventorySignature,
    last_progress_inventory_signature: state.lastProgressInventorySignature,
    current_inventory_signature: state.currentInventorySignature,
    start_position: state.startPosition,
    last_progress_position: state.lastProgressPosition,
    current_position: state.currentPosition,
    block_change_count: state.blockChangeCount,
    last_block_change: state.lastBlockChange,
    elapsed_ms: Date.now() - state.startedAt,
    stalled_for_ms: Date.now() - state.lastProgressAt,
    ...extra,
  });
}

module.exports = function createCollectWatchdogHelper(bot) {
  return {
    async collectBlockWithProgressWatchdog(target, options = {}) {
      const stallTimeoutMs = Math.max(Number(options.stallTimeoutMs || 7000), 1000);
      const pollIntervalMs = Math.max(Number(options.pollIntervalMs || 250), 100);
      const successTargets = Array.isArray(options.successTargets) ? options.successTargets : [];
      const state = {
        startedAt: Date.now(),
        stallTimeoutMs,
        pollIntervalMs,
        progressEventCount: 0,
        lastProgressReason: "start",
        initialInventoryCount: inventoryTotalFor(bot, successTargets),
        lastProgressInventoryCount: inventoryTotalFor(bot, successTargets),
        currentInventoryCount: inventoryTotalFor(bot, successTargets),
        initialInventorySignature: inventorySignatureFor(bot),
        lastProgressInventorySignature: inventorySignatureFor(bot),
        currentInventorySignature: inventorySignatureFor(bot),
        startPosition: snapshotPosition(bot),
        currentPosition: snapshotPosition(bot),
        lastProgressPosition: snapshotPosition(bot),
        blockChangeCount: 0,
        lastBlockChange: null,
        lastProgressAt: Date.now(),
      };

      let stalledError = null;
      let monitorHandle = null;
      let teardownBlockListener = () => {};

      const recordProgress = (reasons) => {
        if (!Array.isArray(reasons) || !reasons.length) {
          return;
        }
        state.progressEventCount += 1;
        state.lastProgressReason = reasons.join("+");
        state.lastProgressAt = Date.now();
        state.lastProgressPosition = state.currentPosition;
        state.lastProgressInventoryCount = state.currentInventoryCount;
        state.lastProgressInventorySignature = state.currentInventorySignature;
      };

      const updateProgressState = () => {
        state.currentPosition = snapshotPosition(bot);
        state.currentInventoryCount = inventoryTotalFor(bot, successTargets);
        state.currentInventorySignature = inventorySignatureFor(bot);

        const reasons = [];
        if (state.currentInventoryCount > state.lastProgressInventoryCount) {
          reasons.push("target_inventory");
        }
        if (state.currentInventorySignature !== state.lastProgressInventorySignature) {
          reasons.push("inventory");
        }
        if (hasMeaningfulMovement(state.lastProgressPosition, state.currentPosition)) {
          reasons.push("position");
        }
        if (!reasons.length) {
          return;
        }
        recordProgress(reasons);
      };

      const registerBlockListener = () => {
        if (!bot || typeof bot.on !== "function") {
          return;
        }
        const handleBlockUpdate = (oldBlock, newBlock) => {
          const oldName = normalizeName(oldBlock?.name);
          const newName = normalizeName(newBlock?.name);
          if (!oldName || oldName === newName || isAirBlockName(oldName)) {
            return;
          }
          state.blockChangeCount += 1;
          state.lastBlockChange = {
            old_name: oldName,
            new_name: newName || "<missing>",
            position: snapshotVec3(newBlock?.position || oldBlock?.position),
            removed: isAirBlockName(newName),
          };
          state.currentPosition = snapshotPosition(bot);
          state.currentInventoryCount = inventoryTotalFor(bot, successTargets);
          state.currentInventorySignature = inventorySignatureFor(bot);
          recordProgress(["block_update"]);
        };
        bot.on("blockUpdate", handleBlockUpdate);
        teardownBlockListener = () => {
          if (typeof bot.off === "function") {
            bot.off("blockUpdate", handleBlockUpdate);
            return;
          }
          if (typeof bot.removeListener === "function") {
            bot.removeListener("blockUpdate", handleBlockUpdate);
          }
        };
      };

      registerBlockListener();

      const collectPromise = bot.collectBlock.collect(
        target,
        { ignoreNoPath: false },
      ).then(() => {
        if (stalledError) {
          throw stalledError;
        }
        return buildDiagnostics(state, { status: "completed" });
      });

      const watchdogPromise = new Promise((_, reject) => {
        monitorHandle = setInterval(async () => {
          try {
            updateProgressState();
            if (Date.now() - state.lastProgressAt < stallTimeoutMs) {
              return;
            }
            stalledError = new Error("Mining made no position, inventory, or block-update progress for 7 seconds");
            stalledError.name = "MineStalledTimeout";
            stalledError.diagnosticsJson = buildDiagnostics(state, { status: "stalled" });
            clearInterval(monitorHandle);
            monitorHandle = null;
            try {
              await bot.collectBlock.cancelTask();
            } catch (_cancelError) {
              // collectBlock may already be unwinding; keep the original timeout reason.
            }
            reject(stalledError);
          } catch (monitorError) {
            clearInterval(monitorHandle);
            monitorHandle = null;
            reject(monitorError);
          }
        }, pollIntervalMs);
      });

      try {
        return await Promise.race([collectPromise, watchdogPromise]);
      } finally {
        if (monitorHandle) {
          clearInterval(monitorHandle);
        }
        teardownBlockListener();
      }
    },
  };
};
