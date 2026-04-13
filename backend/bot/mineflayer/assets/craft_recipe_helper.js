function normalizeName(value) {
  return String(value || '').trim().toLowerCase()
}

function itemNameById(mcData, id) {
  const item = mcData.items?.[id]
  return item ? normalizeName(item.name) : ''
}

function isPlanksName(name) {
  return normalizeName(name).endsWith('_planks')
}

function inventoryCounts(bot) {
  const counts = new Map()
  const items = bot && bot.inventory && typeof bot.inventory.items === 'function'
    ? bot.inventory.items()
    : []
  for (const item of items || []) {
    const name = normalizeName(item?.name)
    if (!name) continue
    counts.set(name, (counts.get(name) || 0) + Number(item?.count || 0))
  }
  return counts
}

function cloneEntry(entry) {
  if (entry === null || entry === undefined) {
    return entry
  }
  if (Array.isArray(entry)) {
    return entry.map(cloneEntry)
  }
  if (typeof entry === 'object') {
    const clone = {}
    for (const [key, value] of Object.entries(entry)) {
      clone[key] = cloneEntry(value)
    }
    if (clone.id == null && clone.item != null) {
      clone.id = clone.item
    }
    return clone
  }
  return entry
}

function cloneRecipe(recipe) {
  if (!recipe || typeof recipe !== 'object') {
    return recipe
  }
  return {
    requiresTable: Boolean(recipe.requiresTable),
    inShape: cloneEntry(recipe.inShape),
    ingredients: cloneEntry(recipe.ingredients),
    outShape: cloneEntry(recipe.outShape),
    delta: cloneEntry(recipe.delta),
    result: cloneEntry(recipe.result),
  }
}

function patchIdInEntry(entry, fromId, toId) {
  if (entry === null || entry === undefined) {
    return { entry, changed: false }
  }
  if (Array.isArray(entry)) {
    let changed = false
    const next = entry.map((value) => {
      const patched = patchIdInEntry(value, fromId, toId)
      changed = changed || patched.changed
      return patched.entry
    })
    return { entry: next, changed }
  }
  if (typeof entry === 'number') {
    if (entry !== fromId) {
      return { entry, changed: false }
    }
    return { entry: toId, changed: true }
  }
  if (typeof entry === 'object') {
    let changed = false
    const next = { ...entry }
    if (next.id === fromId) {
      next.id = toId
      changed = true
    }
    if (next.item === fromId) {
      next.item = toId
      changed = true
    }
    return { entry: next, changed }
  }
  return { entry, changed: false }
}

function patchRecipeIds(recipe, fromId, toId) {
  const clone = cloneRecipe(recipe)
  let changed = false
  for (const key of ['inShape', 'ingredients', 'outShape', 'delta', 'result']) {
    const patched = patchIdInEntry(clone[key], fromId, toId)
    clone[key] = patched.entry
    changed = changed || patched.changed
  }
  return { recipe: clone, changed }
}

function collectConsumedEntries(recipe, mcData) {
  const delta = Array.isArray(recipe?.delta) ? recipe.delta : []
  return delta
    .filter((entry) => entry && Number(entry.count || 0) < 0)
    .map((entry) => {
      const id = Number(entry.id ?? entry.item)
      return {
        id,
        count: Math.abs(Number(entry.count || 0)),
        name: itemNameById(mcData, id),
      }
    })
    .filter((entry) => Number.isFinite(entry.id) && entry.id >= 0)
}

function resolvePlanksFallback(bot, mcData, recipe, craftIterations) {
  const consumed = collectConsumedEntries(recipe, mcData)
  if (!consumed.length) {
    return { recipe, fallback: null }
  }
  if (!consumed.every((entry) => isPlanksName(entry.name))) {
    return { recipe, fallback: null }
  }

  const grouped = new Map()
  for (const entry of consumed) {
    grouped.set(entry.id, (grouped.get(entry.id) || 0) + entry.count)
  }

  const requiredTotal = consumed.reduce((sum, entry) => sum + entry.count, 0) * Math.max(Number(craftIterations || 1), 1)
  const counts = inventoryCounts(bot)
  const chosenName = [...counts.keys()]
    .filter((name) => isPlanksName(name) && Number(counts.get(name) || 0) >= requiredTotal)
    .sort()[0]
  if (!chosenName) {
    return { recipe, fallback: null }
  }

  const chosenItem = mcData.itemsByName?.[chosenName]
  if (!chosenItem) {
    return { recipe, fallback: null }
  }

  let patchedRecipe = cloneRecipe(recipe)
  let changed = false
  for (const fromId of grouped.keys()) {
    if (Number(fromId) === Number(chosenItem.id)) {
      continue
    }
    const patched = patchRecipeIds(patchedRecipe, Number(fromId), Number(chosenItem.id))
    patchedRecipe = patched.recipe
    changed = changed || patched.changed
  }
  if (!changed) {
    return { recipe, fallback: null }
  }

  const canonicalNames = [...grouped.keys()]
    .map((id) => itemNameById(mcData, id))
    .filter(Boolean)
    .sort()
  return {
    recipe: patchedRecipe,
    fallback: {
      strategy: 'planks_family_swap',
      canonical_items: canonicalNames,
      chosen_item: chosenName,
      required_total: requiredTotal,
    },
  }
}

module.exports = function createCraftRecipeHelper(bot, mcData) {
  return {
    selectCraftRecipe(itemName, craftCount, craftingTable) {
      const normalizedItem = normalizeName(itemName)
      const item = mcData.itemsByName?.[normalizedItem]
      const diagnostics = {
        item: normalizedItem,
        without_table: 0,
        with_table: 0,
        recipes_all_count: 0,
        fallback: null,
        selected_via: 'none',
      }
      if (!item) {
        return {
          recipe: null,
          diagnosticsJson: JSON.stringify(diagnostics),
        }
      }

      const minResultCount = Math.max(Number(craftCount || 1), 1)
      const withoutTable = Array.from(bot.recipesFor(item.id, null, minResultCount, null) || [])
      diagnostics.without_table = withoutTable.length

      let withTable = []
      if (craftingTable) {
        withTable = Array.from(bot.recipesFor(item.id, null, minResultCount, craftingTable) || [])
        diagnostics.with_table = withTable.length
      }

      const directRecipe = withTable[0] || withoutTable[0] || null
      if (directRecipe) {
        diagnostics.selected_via = withTable[0] ? 'direct_with_table' : 'direct_without_table'
        return {
          recipe: directRecipe,
          diagnosticsJson: JSON.stringify(diagnostics),
        }
      }

      const recipesAll = Array.from(bot.recipesAll(item.id, null, craftingTable || null) || [])
      diagnostics.recipes_all_count = recipesAll.length
      for (const candidate of recipesAll) {
        const resolved = resolvePlanksFallback(bot, mcData, candidate, minResultCount)
        if (!resolved.fallback) {
          continue
        }
        diagnostics.fallback = resolved.fallback
        diagnostics.selected_via = 'fallback'
        return {
          recipe: resolved.recipe,
          diagnosticsJson: JSON.stringify(diagnostics),
        }
      }

      return {
        recipe: null,
        diagnosticsJson: JSON.stringify(diagnostics),
      }
    },
  }
}
