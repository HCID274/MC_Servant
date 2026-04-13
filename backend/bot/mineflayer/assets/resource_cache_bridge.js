"use strict";

const createResourceCache = require("./resource_cache.js");

module.exports = function createBridge(version) {
  const cache = createResourceCache(version);
  return {
    refreshResourceCacheJson(bot, options = {}) {
      return cache.refreshResourceCacheJson(bot, options);
    },
    getResourceCacheSnapshotJson(bot) {
      return cache.getResourceCacheSnapshotJson(bot);
    },
    queryClustersJson(bot, resourceKey, options = {}) {
      return cache.queryClustersJson(bot, resourceKey, options);
    },
    queryBestClusterJson(bot, resourceKey, options = {}) {
      return cache.queryBestClusterJson(bot, resourceKey, options);
    },
    getResourceProfileJson(resourceKey) {
      return cache.getResourceProfileJson(resourceKey);
    },
  };
};
