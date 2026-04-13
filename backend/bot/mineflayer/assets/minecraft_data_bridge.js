const minecraftData = require('minecraft-data')

const TOOL_TIER_ORDER = ['wooden', 'stone', 'iron', 'diamond', 'netherite', 'golden']

function toJson(value) {
  return JSON.stringify(value ?? null)
}

function normalizeName(value) {
  return String(value ?? '').trim().toLowerCase()
}

function itemNameById(mcData, id) {
  const item = mcData.items?.[id]
  return item ? String(item.name || '') : ''
}

function isPlanksName(name) {
  return normalizeName(name).endsWith('_planks')
}

function blockNameById(mcData, id) {
  const block = mcData.blocks?.[id]
  return block ? String(block.name || '') : ''
}

function isUnstrippedLog(name) {
  return name.endsWith('_log') && !name.startsWith('stripped_')
}

function fallbackPlanksName(mcData) {
  const firstLog = mcData.blocksArray
    .map((block) => String(block.name || ''))
    .filter(isUnstrippedLog)
    .sort()[0]
  if (firstLog) {
    return firstLog.replace(/_log$/, '_planks')
  }
  const firstPlanks = mcData.itemsArray
    .map((item) => String(item.name || ''))
    .filter((name) => name.endsWith('_planks'))
    .sort()[0]
  return firstPlanks || ''
}

function preferredPlanksFromLog(mcData, logName) {
  let normalized = normalizeName(logName)
  if (!normalized) {
    return fallbackPlanksName(mcData)
  }
  if (normalized.startsWith('stripped_')) {
    normalized = normalized.slice('stripped_'.length)
  }
  if (normalized.endsWith('_log')) {
    return normalized.replace(/_log$/, '_planks')
  }
  return fallbackPlanksName(mcData)
}

function collectMaterials(mcData, recipe) {
  const counts = new Map()
  const addIngredient = (ingredient) => {
    if (ingredient === null || ingredient === undefined) {
      return
    }
    let ingredientId = null
    if (typeof ingredient === 'number') {
      ingredientId = ingredient
    } else if (typeof ingredient === 'object') {
      ingredientId = ingredient.id ?? ingredient.item
    }
    if (ingredientId === null || ingredientId === undefined) {
      return
    }
    const itemName = itemNameById(mcData, ingredientId)
    if (!itemName) {
      return
    }
    const normalizedItemName = normalizeName(itemName)
    const materialKey = isPlanksName(normalizedItemName) ? 'planks' : normalizedItemName
    counts.set(materialKey, (counts.get(materialKey) || 0) + 1)
  }

  if (Array.isArray(recipe.ingredients)) {
    recipe.ingredients.forEach(addIngredient)
  }
  if (Array.isArray(recipe.inShape)) {
    recipe.inShape.flat().forEach(addIngredient)
  }

  return Object.fromEntries([...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])))
}

function inferRequiresTable(recipe) {
  if (Array.isArray(recipe.inShape)) {
    const rows = recipe.inShape.filter((row) => Array.isArray(row) && row.length > 0)
    const height = rows.length
    const width = rows.reduce((max, row) => Math.max(max, row.length), 0)
    return width > 2 || height > 2
  }
  const ingredientCount = Array.isArray(recipe.ingredients) ? recipe.ingredients.length : 0
  return ingredientCount > 4
}

function normalizeRecipeOptions(mcData, itemName) {
  const item = mcData.itemsByName?.[itemName]
  if (!item) {
    return []
  }
  const recipes = Array.from(mcData.recipes?.[item.id] || [])
  return recipes
    .map((recipe) => {
      const materials = collectMaterials(mcData, recipe)
      if (!Object.keys(materials).length) {
        return null
      }
      return {
        item: itemName,
        requested_name: itemName,
        materials,
        output_count: Number(recipe.result?.count || 1),
        requires_table: inferRequiresTable(recipe),
      }
    })
    .filter(Boolean)
}

function parseToolFromMaterial(block) {
  const material = normalizeName(block?.material)
  if (!material.includes('mineable/')) {
    return null
  }
  return material.split('/').pop() || null
}

function pickMinimumHarvestTool(mcData, block) {
  const harvestTools = block?.harvestTools || {}
  const toolNames = Object.keys(harvestTools)
    .filter((itemId) => harvestTools[itemId])
    .map((itemId) => itemNameById(mcData, Number(itemId)))
    .filter(Boolean)
    .filter((name) => name.endsWith('_pickaxe') || name.endsWith('_axe') || name.endsWith('_shovel') || name.endsWith('_hoe'))

  if (!toolNames.length) {
    return { tool: parseToolFromMaterial(block), min_tier: null, required_tool_item: null }
  }

  const sorted = toolNames.sort((left, right) => {
    const [leftTier] = left.split('_')
    const [rightTier] = right.split('_')
    return TOOL_TIER_ORDER.indexOf(leftTier) - TOOL_TIER_ORDER.indexOf(rightTier)
  })
  const minToolName = sorted[0]
  const segments = minToolName.split('_')
  return {
    tool: segments.slice(1).join('_') || null,
    min_tier: segments[0] || null,
    required_tool_item: minToolName,
  }
}

function getMiningRule(mcData, targetName) {
  const normalized = normalizeName(targetName)
  if (!normalized) {
    return null
  }

  if (normalized === 'any_log') {
    const candidateBlocks = mcData.blocksArray
      .map((block) => String(block.name || ''))
      .filter(isUnstrippedLog)
      .sort()
    return {
      target: 'any_log',
      source_block: 'any_log',
      drops: 'log',
      tool: null,
      min_tier: null,
      required_tool_item: null,
      candidate_blocks: candidateBlocks,
    }
  }

  let block = mcData.blocksByName?.[normalized] || null
  if (!block) {
    const item = mcData.itemsByName?.[normalized] || null
    if (item) {
      const candidateBlocks = mcData.blocksArray
        .filter((entry) => Array.from(entry.drops || []).includes(item.id))
        .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')))
      block = candidateBlocks[0] || null
    }
  }
  if (!block) {
    return null
  }

  const dropNames = Array.from(block.drops || [])
    .map((dropId) => itemNameById(mcData, dropId))
    .filter(Boolean)
  const harvest = pickMinimumHarvestTool(mcData, block)
  return {
    target: normalized,
    source_block: String(block.name || ''),
    drops: dropNames[0] || null,
    tool: harvest.tool,
    min_tier: harvest.min_tier,
    required_tool_item: harvest.required_tool_item,
    candidate_blocks: [String(block.name || '')],
  }
}

function resolveCanonicalTarget(mcData, targetName) {
  const normalized = normalizeName(targetName)
  if (!normalized) {
    return null
  }
  if (normalized === 'any_log' || normalized === 'planks') {
    return { resolved_target: normalized, kind: 'virtual' }
  }
  if (mcData.itemsByName?.[normalized]) {
    return { resolved_target: normalized, kind: 'item' }
  }
  if (mcData.blocksByName?.[normalized]) {
    return { resolved_target: normalized, kind: 'block' }
  }
  const miningRule = getMiningRule(mcData, normalized)
  if (miningRule) {
    return { resolved_target: normalized, kind: 'drop' }
  }
  return null
}

module.exports = function createBridge(version) {
  const mcData = minecraftData(version)
  return {
    resolveCanonicalTargetJson(targetName) {
      return toJson(resolveCanonicalTarget(mcData, targetName))
    },
    getRecipeOptionsJson(itemName) {
      return toJson(normalizeRecipeOptions(mcData, normalizeName(itemName)))
    },
    getMiningRuleJson(targetName) {
      return toJson(getMiningRule(mcData, targetName))
    },
    getLogBlockNamesJson() {
      const blockNames = mcData.blocksArray
        .map((block) => String(block.name || ''))
        .filter(isUnstrippedLog)
        .sort()
      return toJson(blockNames)
    },
    getPreferredPlanksJson(logName) {
      return toJson(preferredPlanksFromLog(mcData, logName))
    },
    getPlanksItemNamesJson() {
      const itemNames = mcData.itemsArray
        .map((item) => String(item.name || ''))
        .filter(isPlanksName)
        .sort()
      return toJson(itemNames)
    },
  }
}
