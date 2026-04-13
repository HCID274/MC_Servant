"use strict";

const createResourceCache = require("./resource_cache.js");

function toPlainPosition(pos) {
  if (!pos) {
    return {};
  }
  return {
    x: Number(pos.x.toFixed(2)),
    y: Number(pos.y.toFixed(2)),
    z: Number(pos.z.toFixed(2)),
  };
}

function resolvePlayerEntity(bot, playerName) {
  const players = bot && bot.players ? bot.players : {};
  const names = [];

  if (playerName) {
    names.push(String(playerName));
  }

  for (const name of Object.keys(players)) {
    if (String(name).toLowerCase() === String(bot.username || "").toLowerCase()) {
      continue;
    }
    if (!names.includes(name)) {
      names.push(name);
    }
  }

  for (const name of names) {
    const player = players[name];
    if (player && player.entity) {
      return player.entity;
    }
  }

  return null;
}

function getInventorySummary(bot) {
  const items = bot && bot.inventory && typeof bot.inventory.items === "function"
    ? bot.inventory.items()
    : [];
  const summary = {};

  for (const item of items) {
    if (!item || !item.name) {
      continue;
    }
    summary[item.name] = (summary[item.name] || 0) + Number(item.count || 0);
  }

  return Object.fromEntries(
    Object.entries(summary).sort((a, b) => a[0].localeCompare(b[0])),
  );
}

function getNearbyBlocksSummary(bot, options = {}) {
  const cache = createResourceCache(bot?.version);
  const snapshot = cache.getResourceCacheSnapshotJson(bot);
  const parsed = JSON.parse(String(snapshot || "{}"));
  const summary = Array.isArray(parsed?.summary) ? parsed.summary : [];
  const maxEntries = Number(options.maxEntries || 20);

  return summary
    .map((entry) => ({
      name: String(entry?.name || ""),
      count: Number(entry?.count || 0),
      cluster_count: Number(entry?.cluster_count || 0),
    }))
    .filter((entry) => entry.name)
    .sort((a, b) => {
      if (a.count !== b.count) {
        return b.count - a.count;
      }
      if (a.cluster_count !== b.cluster_count) {
        return b.cluster_count - a.cluster_count;
      }
      return String(a.name).localeCompare(String(b.name));
    })
    .slice(0, maxEntries);
}

function hasNearbyBlockExact(bot, blockName, options = {}) {
  const normalized = String(blockName || '').trim().toLowerCase()
  if (!normalized || !bot || typeof bot.findBlock !== 'function' || !bot.registry) {
    return false
  }
  const blocksByName = bot.registry.blocksByName || {}
  const blockInfo = blocksByName[normalized]
  if (!blockInfo || blockInfo.id == null) {
    return false
  }
  const maxDistance = Number(options.maxDistance || 8)
  try {
    const match = bot.findBlock({
      matching: blockInfo.id,
      maxDistance,
    })
    return !!match
  } catch (_err) {
    return false
  }
}

function getEnvironmentSnapshot(bot, options = {}) {
  const playerEntity = resolvePlayerEntity(bot, options.playerName);
  const cache = createResourceCache(bot?.version);
  const snapshotPayload = cache.getResourceCacheSnapshotJson(bot);
  const parsedCache = JSON.parse(String(snapshotPayload || "{}"));
  const hasCache = Array.isArray(parsedCache?.summary) && parsedCache.summary.length > 0;

  if (!hasCache) {
    cache.refreshResourceCacheJson(bot, {
      radius: Number(options.resourceRadius || 32),
    });
  }

  const snapshot = {
    bot_pos: bot && bot.entity ? toPlainPosition(bot.entity.position) : {},
    player_pos: playerEntity ? toPlainPosition(playerEntity.position) : {},
    inventory: getInventorySummary(bot),
    nearby_blocks: getNearbyBlocksSummary(bot, options),
    nearby_crafting_table: hasNearbyBlockExact(bot, 'crafting_table', { maxDistance: Number(options.workstationRadius || 8) }),
    equipped: bot && bot.heldItem && bot.heldItem.name ? bot.heldItem.name : null,
    health: typeof bot.health === "number" ? Number(bot.health.toFixed(2)) : null,
    food: typeof bot.food === "number" ? Number(bot.food) : null,
  };

  return JSON.stringify(snapshot);
}

module.exports = {
  getEnvironmentSnapshot,
  getNearbyBlocksSummary,
};
