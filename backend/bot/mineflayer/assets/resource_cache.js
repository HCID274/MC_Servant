"use strict";

const createResourceProfiles = require("./resource_profiles.js");

function toJson(value) {
  return JSON.stringify(value ?? null);
}

function toPlainPosition(pos) {
  if (!pos) {
    return {};
  }
  return {
    x: Number(Number(pos.x || 0).toFixed(2)),
    y: Number(Number(pos.y || 0).toFixed(2)),
    z: Number(Number(pos.z || 0).toFixed(2)),
  };
}

function normalizeName(value) {
  return String(value ?? "").trim().toLowerCase();
}

function resolvePlayerEntity(bot, playerName) {
  const players = bot && bot.players ? bot.players : {};
  const candidates = [];

  if (playerName) {
    candidates.push(String(playerName));
  }

  for (const name of Object.keys(players)) {
    if (String(name).toLowerCase() === String(bot?.username || "").toLowerCase()) {
      continue;
    }
    if (!candidates.includes(name)) {
      candidates.push(name);
    }
  }

  for (const name of candidates) {
    const player = players[name];
    if (player && player.entity) {
      return player.entity;
    }
  }

  return null;
}

function distanceSquaredTo(pos, x, y, z) {
  const dx = Number(pos?.x || 0) - Number(x || 0);
  const dy = Number(pos?.y || 0) - Number(y || 0);
  const dz = Number(pos?.z || 0) - Number(z || 0);
  return dx * dx + dy * dy + dz * dz;
}

function packedCoordinate(x, y, z) {
  const X_OFFSET = 30000000n;
  const Y_OFFSET = 2048n;
  return ((BigInt(x) + X_OFFSET) << 38n) | ((BigInt(y) + Y_OFFSET) << 26n) | (BigInt(z) + X_OFFSET);
}

function neighborOffsets(rule) {
  const offsets = [];
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dz = -1; dz <= 1; dz += 1) {
        if (dx === 0 && dy === 0 && dz === 0) {
          continue;
        }
        const manhattan = Math.abs(dx) + Math.abs(dy) + Math.abs(dz);
        if (rule === "face") {
          if (manhattan === 1) {
            offsets.push([dx, dy, dz]);
          }
          continue;
        }
        offsets.push([dx, dy, dz]);
      }
    }
  }
  return offsets;
}

function getState(bot) {
  if (!bot.__mcServantResourceCacheState) {
    bot.__mcServantResourceCacheState = {
      anchor: null,
      radius: 32,
      version: 0,
      updated_at: 0,
      clusters: [],
      summary: {},
    };
  }
  return bot.__mcServantResourceCacheState;
}

function collectCandidateBlocks(bot, profile) {
  if (!bot || typeof bot.findBlocks !== "function") {
    return [];
  }
  const blockIds = Array.isArray(profile?.candidate_block_ids) ? profile.candidate_block_ids : [];
  if (!blockIds.length) {
    return [];
  }

  const positions = bot.findBlocks({
    matching: blockIds,
    maxDistance: Number(profile.radius || 32),
    count: Number(profile.max_find_count || 5000),
  });

  const blockMap = new Map();
  for (const pos of positions || []) {
    if (!pos) {
      continue;
    }
    const block = bot.blockAt(pos);
    if (!block || !block.name) {
      continue;
    }
    const name = normalizeName(block.name);
    if (!profile.candidate_block_names.includes(name)) {
      continue;
    }
    const x = Number(pos.x);
    const y = Number(pos.y);
    const z = Number(pos.z);
    const key = packedCoordinate(x, y, z);
    blockMap.set(key, { x, y, z, name });
  }
  return Array.from(blockMap.values());
}

function buildClusters(blocks, connectivityRule, clusterIdPrefix) {
  const offsets = neighborOffsets(connectivityRule);
  const byKey = new Map();
  const visited = new Set();
  const clusters = [];

  for (const block of blocks) {
    byKey.set(packedCoordinate(block.x, block.y, block.z), block);
  }

  let clusterIndex = 0;
  for (const root of blocks) {
    const rootKey = packedCoordinate(root.x, root.y, root.z);
    if (visited.has(rootKey)) {
      continue;
    }

    const queue = [root];
    let queueIndex = 0;
    visited.add(rootKey);
    const clusterBlocks = [];

    while (queueIndex < queue.length) {
      const current = queue[queueIndex];
      queueIndex += 1;
      clusterBlocks.push(current);

      for (const [dx, dy, dz] of offsets) {
        const nextKey = packedCoordinate(current.x + dx, current.y + dy, current.z + dz);
        if (visited.has(nextKey)) {
          continue;
        }
        const nextBlock = byKey.get(nextKey);
        if (!nextBlock) {
          continue;
        }
        visited.add(nextKey);
        queue.push(nextBlock);
      }
    }

    clusterIndex += 1;
    const center = {
      x: Number((clusterBlocks.reduce((sum, block) => sum + block.x, 0) / clusterBlocks.length).toFixed(2)),
      y: Number((clusterBlocks.reduce((sum, block) => sum + block.y, 0) / clusterBlocks.length).toFixed(2)),
      z: Number((clusterBlocks.reduce((sum, block) => sum + block.z, 0) / clusterBlocks.length).toFixed(2)),
    };

    clusters.push({
      cluster_id: `${clusterIdPrefix}_${String(clusterIndex).padStart(3, "0")}`,
      blocks: clusterBlocks,
      count: clusterBlocks.length,
      center,
      block_names: Array.from(new Set(clusterBlocks.map((item) => item.name))).sort(),
    });
  }

  return clusters;
}

function buildSummary(clusters) {
  const summary = new Map();
  for (const cluster of clusters) {
    const namesInCluster = new Set();
    for (const block of cluster.blocks || []) {
      const name = normalizeName(block.name);
      if (!name) {
        continue;
      }
      const current = summary.get(name) || { name, count: 0, cluster_count: 0 };
      current.count += 1;
      summary.set(name, current);
      namesInCluster.add(name);
    }
    for (const name of namesInCluster) {
      const current = summary.get(name);
      if (current) {
        current.cluster_count += 1;
      }
    }
  }
  return Array.from(summary.values()).sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

function selectAnchorPosition(bot, anchorMode, playerName) {
  const botPos = bot?.entity?.position || null;
  const playerPos = resolvePlayerEntity(bot, playerName)?.position || null;
  if (anchorMode === "player") {
    return playerPos || botPos || null;
  }
  if (anchorMode === "shared") {
    return playerPos || botPos || null;
  }
  return botPos || playerPos || null;
}

function selectBestBlock(cluster, currentPos, strategy) {
  const blocks = Array.isArray(cluster?.blocks) ? cluster.blocks : [];
  if (!blocks.length || !currentPos) {
    return null;
  }
  const ordered = blocks
    .slice()
    .sort((left, right) => {
      const leftScore = distanceSquaredTo(currentPos, left.x, left.y, left.z);
      const rightScore = distanceSquaredTo(currentPos, right.x, right.y, right.z);
      if (leftScore !== rightScore) {
        return leftScore - rightScore;
      }
      if (strategy === "nearest") {
        return left.y - right.y;
      }
      return left.y - right.y;
    });
  return ordered[0] || null;
}

function refreshResourceCache(bot, options = {}) {
  const state = getState(bot);
  const profiles = createResourceProfiles(bot?.version);
  const entries = profiles.listResourceProfiles();
  const anchor = toPlainPosition(bot?.entity?.position);
  const allClusters = [];

  for (const entry of entries) {
    const blocks = collectCandidateBlocks(bot, entry);
    const clusters = buildClusters(blocks, entry.connectivity_rule, entry.resource_key).map((cluster) => ({
      cluster_id: cluster.cluster_id,
      profile: entry.profile,
      resource_key: entry.resource_key,
      block_names: cluster.block_names,
      blocks: cluster.blocks,
      count: cluster.count,
      center: cluster.center,
      finish_cluster_if_overage_leq: Number(entry.finish_cluster_if_overage_leq || 10),
      intra_cluster_order_strategy: String(entry.intra_cluster_order_strategy || "nearest"),
      search_anchor: String(entry.search_anchor || "bot"),
    }));
    allClusters.push(...clusters);
  }

  state.anchor = anchor;
  state.radius = Number(options.radius || 32);
  state.version = Number(state.version || 0) + 1;
  state.updated_at = Date.now();
  state.clusters = allClusters;
  state.summary = buildSummary(allClusters);
  return state;
}

function getResourceCacheSnapshot(bot) {
  const state = getState(bot);
  return {
    anchor: state.anchor || {},
    radius: Number(state.radius || 32),
    version: Number(state.version || 0),
    updated_at: Number(state.updated_at || 0),
    clusters: state.clusters || [],
    summary: state.summary || [],
  };
}

function queryClusters(bot, resourceKey, options = {}) {
  const normalizedKey = normalizeName(resourceKey);
  if (!normalizedKey) {
    return [];
  }
  const snapshot = getResourceCacheSnapshot(bot);
  const profiles = createResourceProfiles(bot?.version);
  const profile = profiles.getResourceProfile(normalizedKey);
  const effectiveAnchor = String(options.searchAnchor || profile?.search_anchor || "bot");
  const anchorPosition = selectAnchorPosition(bot, effectiveAnchor, options.playerName);

  return (snapshot.clusters || [])
    .filter((cluster) => normalizeName(cluster.resource_key) === normalizedKey)
    .map((cluster) => {
      const selectedBlock = selectBestBlock(
        cluster,
        anchorPosition,
        String(cluster.intra_cluster_order_strategy || "nearest"),
      );
      return {
        ...cluster,
        selected_block: selectedBlock,
      };
    });
}

function queryBestCluster(bot, resourceKey, options = {}) {
  const clusters = queryClusters(bot, resourceKey, options).filter((cluster) => cluster.selected_block);
  if (!clusters.length) {
    return null;
  }

  const profiles = createResourceProfiles(bot?.version);
  const profile = profiles.getResourceProfile(resourceKey);
  const effectiveAnchor = String(options.searchAnchor || profile?.search_anchor || "bot");
  const anchorPosition = selectAnchorPosition(bot, effectiveAnchor, options.playerName);
  if (!anchorPosition) {
    return clusters[0];
  }

  return clusters.slice().sort((left, right) => {
    const leftBlock = left.selected_block;
    const rightBlock = right.selected_block;
    const leftScore = distanceSquaredTo(anchorPosition, leftBlock.x, leftBlock.y, leftBlock.z);
    const rightScore = distanceSquaredTo(anchorPosition, rightBlock.x, rightBlock.y, rightBlock.z);
    if (leftScore !== rightScore) {
      return leftScore - rightScore;
    }
    return Number(left.count || 0) - Number(right.count || 0);
  })[0];
}

module.exports = function createResourceCache(version) {
  const profiles = createResourceProfiles(version);
  return {
    refreshResourceCacheJson(bot, options = {}) {
      return toJson(refreshResourceCache(bot, options));
    },
    getResourceCacheSnapshotJson(bot) {
      return toJson(getResourceCacheSnapshot(bot));
    },
    queryClustersJson(bot, resourceKey, options = {}) {
      return toJson(queryClusters(bot, resourceKey, options));
    },
    queryBestClusterJson(bot, resourceKey, options = {}) {
      return toJson(queryBestCluster(bot, resourceKey, options));
    },
    getResourceProfileJson(resourceKey) {
      return toJson(profiles.getResourceProfile(resourceKey));
    },
  };
};
