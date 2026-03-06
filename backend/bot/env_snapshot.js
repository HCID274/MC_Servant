"use strict";

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
    Object.entries(summary).sort((a, b) => a[0].localeCompare(b[0]))
  );
}

function getNearbyBlocksSummary(bot, options = {}) {
  const center = bot && bot.entity ? bot.entity.position : null;
  if (!center || typeof bot.findBlocks !== "function") {
    return [];
  }

  const horizontalRadius = Number(options.horizontalRadius || 6);
  const verticalRadius = Number(options.verticalRadius || 2);
  const maxEntries = Number(options.maxEntries || 20);
  const findCount = Number(options.findCount || Math.max(maxEntries * 32, 256));
  const airNames = new Set(["air", "cave_air", "void_air"]);

  const positions = bot.findBlocks({
    matching: (block) => Boolean(block && block.name && !airNames.has(block.name)),
    maxDistance: horizontalRadius,
    count: findCount,
  });

  const summary = new Map();
  for (const pos of positions) {
    if (!pos || Math.abs(Number(pos.y) - Number(center.y)) > verticalRadius) {
      continue;
    }

    const block = bot.blockAt(pos);
    if (!block || !block.name || airNames.has(block.name)) {
      continue;
    }

    const distance = Number(center.distanceTo(pos).toFixed(2));
    const current = summary.get(block.name);
    if (!current) {
      summary.set(block.name, {
        name: block.name,
        count: 1,
        nearest: toPlainPosition(pos),
        distance,
      });
      continue;
    }

    current.count += 1;
    if (distance < current.distance) {
      current.distance = distance;
      current.nearest = toPlainPosition(pos);
    }
  }

  return Array.from(summary.values())
    .sort((a, b) => {
      if (a.distance !== b.distance) {
        return a.distance - b.distance;
      }
      if (a.count !== b.count) {
        return b.count - a.count;
      }
      return String(a.name).localeCompare(String(b.name));
    })
    .slice(0, maxEntries);
}

function getEnvironmentSnapshot(bot, options = {}) {
  const playerEntity = resolvePlayerEntity(bot, options.playerName);
  const snapshot = {
    bot_pos: bot && bot.entity ? toPlainPosition(bot.entity.position) : {},
    player_pos: playerEntity ? toPlainPosition(playerEntity.position) : {},
    inventory: getInventorySummary(bot),
    nearby_blocks: getNearbyBlocksSummary(bot, options),
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
