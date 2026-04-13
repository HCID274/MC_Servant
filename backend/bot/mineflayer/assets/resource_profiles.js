"use strict";

const fs = require("fs");
const path = require("path");
const minecraftData = require("minecraft-data");

const CONFIG_PATH = path.resolve(__dirname, "..", "..", "..", "data", "resource_profiles.json");

function normalizeName(value) {
  return String(value ?? "").trim().toLowerCase();
}

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch (_) {
    return { profiles: {}, resource_keys: {} };
  }
}

function isUnstrippedLog(name) {
  const normalized = normalizeName(name);
  return normalized.endsWith("_log") && !normalized.startsWith("stripped_");
}

function uniqueSorted(values) {
  return Array.from(new Set(values.filter(Boolean).map((item) => String(item).trim()))).sort();
}

function expandCandidateBlockNames(mcData, source) {
  if (!source || typeof source !== "object") {
    return [];
  }

  if (source.type === "literal") {
    return uniqueSorted(Array.isArray(source.block_names) ? source.block_names : []);
  }

  if (source.type === "minecraft_dynamic" && source.key === "all_logs") {
    return uniqueSorted(
      (mcData.blocksArray || [])
        .map((block) => normalizeName(block?.name))
        .filter(isUnstrippedLog),
    );
  }

  return [];
}

module.exports = function createResourceProfiles(version) {
  const mcData = minecraftData(version);
  const config = loadConfig();
  const profiles = config.profiles || {};
  const resourceKeys = config.resource_keys || {};

  const resolvedEntries = Object.entries(resourceKeys).map(([resourceKey, resourceConfig]) => {
    const normalizedKey = normalizeName(resourceKey);
    const profileName = normalizeName(resourceConfig?.profile);
    const profileConfig = profiles[profileName] || {};
    const candidateBlockNames = expandCandidateBlockNames(mcData, resourceConfig?.candidate_block_source);
    const candidateBlockIds = candidateBlockNames
      .map((name) => mcData.blocksByName?.[name]?.id)
      .filter((value) => Number.isInteger(value));

    return [
      normalizedKey,
      {
        resource_key: normalizedKey,
        profile: profileName,
        connectivity_rule: String(profileConfig.connectivity_rule || "face"),
        search_anchor: String(profileConfig.search_anchor || "bot"),
        radius: Number(profileConfig.radius || 32),
        max_find_count: Number(profileConfig.max_find_count || 5000),
        finish_cluster_if_overage_leq: Number(profileConfig.finish_cluster_if_overage_leq || 10),
        intra_cluster_order_strategy: String(profileConfig.intra_cluster_order_strategy || "nearest"),
        candidate_block_names: candidateBlockNames,
        candidate_block_ids: candidateBlockIds,
        success_targets: uniqueSorted(Array.isArray(resourceConfig?.success_targets) ? resourceConfig.success_targets : []),
      },
    ];
  });

  const resourceMap = Object.fromEntries(resolvedEntries);

  return {
    getResourceProfile(resourceKey) {
      const normalizedKey = normalizeName(resourceKey);
      return resourceMap[normalizedKey] || null;
    },
    listResourceProfiles() {
      return Object.values(resourceMap);
    },
  };
};
