import type { RuntimeResourceBlockSemanticRole } from "../../../core-ports/runtime.js";
import type { MineflayerBlockHandle } from "../types.js";

/** transport 内部共享的 Minecraft registry/tag/drop 事实读取层。 */
export function normalizeRegistryName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^minecraft:/u, "")
    .replace(/[\s-]+/gu, "_");
}

export function normalizeOptionalRegistryName(value: string | undefined): string {
  return value === undefined ? "" : normalizeRegistryName(value);
}

export function readStringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function readNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

export function readRegistryBlockFacts(
  registry: unknown,
): readonly Readonly<Record<string, unknown>>[] {
  const registryRecord = asRecord(registry);
  const blocksByName = asRecord(registryRecord?.blocksByName);
  return blocksByName === undefined
    ? Object.freeze([])
    : Object.freeze(
        Object.values(blocksByName).flatMap((value) => {
          const record = asRecord(value);
          return record === undefined ? [] : [record];
        }),
      );
}

export function readRegistryBlockFactByName(
  registry: unknown,
  blockName: string,
): Readonly<Record<string, unknown>> | undefined {
  const registryRecord = asRecord(registry);
  const blocksByName = asRecord(registryRecord?.blocksByName);
  return asRecord(blocksByName?.[normalizeRegistryName(blockName)]);
}

export function readRegistryBlockFactForBlock(
  registry: unknown,
  block: MineflayerBlockHandle,
): Readonly<Record<string, unknown>> | undefined {
  const registryRecord = asRecord(registry);
  const blocksByName = asRecord(registryRecord?.blocksByName);
  const blocksById = asRecord(registryRecord?.blocks);
  const blockName = block.name;

  if (blockName !== undefined && blockName.length > 0) {
    const byName = asRecord(blocksByName?.[blockName]);

    if (byName !== undefined) {
      return byName;
    }
  }

  if (block.type !== undefined) {
    return asRecord(blocksById?.[String(block.type)] ?? blocksById?.[block.type]);
  }

  return undefined;
}

export function readRegistryItemFactByName(
  registry: unknown,
  itemName: string,
): Readonly<{ readonly id: number; readonly name?: string }> | undefined {
  const registryRecord = asRecord(registry);
  const itemsByName = asRecord(registryRecord?.itemsByName);
  const item = asRecord(itemsByName?.[normalizeRegistryName(itemName)]);
  const id = readNumber(item?.id, Number.NaN);
  return Number.isInteger(id)
    ? ({
        ...item,
        id,
        ...(readStringValue(item?.name) === null ? {} : { name: readStringValue(item?.name) }),
      } as Readonly<{ readonly id: number; readonly name?: string }>)
    : undefined;
}

export function readRegistryItemName(registry: unknown, itemId: number): string | null {
  const registryRecord = asRecord(registry);
  const items = asRecord(registryRecord?.items);
  const item = asRecord(items?.[String(itemId)] ?? items?.[itemId]);
  const name = readStringValue(item?.name);
  return name === null ? null : normalizeRegistryName(name);
}

export function readRegistryBlockDropIds(
  fact: Readonly<Record<string, unknown>>,
): readonly number[] {
  return Array.isArray(fact.drops)
    ? Object.freeze(fact.drops.filter((dropId): dropId is number => Number.isInteger(dropId)))
    : Object.freeze([]);
}

export function readBlockDirectTags(tags: MineflayerBlockHandle["tags"]): ReadonlySet<string> {
  if (Array.isArray(tags)) {
    return new Set(tags);
  }

  const record = asRecord(tags);

  if (record === undefined) {
    return new Set();
  }

  return new Set(
    Object.entries(record)
      .filter(([, value]) => Boolean(value))
      .map(([key]) => key),
  );
}

export function normalizeRegistryTagValue(value: unknown): readonly (number | string)[] {
  if (Array.isArray(value)) {
    return Object.freeze(
      value.filter(
        (entry): entry is number | string => typeof entry === "number" || typeof entry === "string",
      ),
    );
  }

  const record = asRecord(value);

  if (record === undefined) {
    return Object.freeze([]);
  }

  return Object.freeze(
    Object.entries(record)
      .filter(([, enabled]) => Boolean(enabled))
      .map(([key]) => {
        const numericKey = Number(key);
        return Number.isInteger(numericKey) ? numericKey : key;
      }),
  );
}

export function isCutTreeLogLikeBlockFact(
  fact: Readonly<Record<string, unknown>> | undefined,
): boolean {
  if (fact === undefined) {
    return false;
  }

  const material = fact.material;
  const states = Array.isArray(fact.states) ? fact.states : [];
  const hasAxisState = states.some((state) => {
    const stateRecord = asRecord(state);

    return stateRecord?.name === "axis";
  });

  return material === "mineable/axe" && hasAxisState && readBoolean(fact.diggable, true);
}

export function createResourceKeyLookupNames(resourceKey: string): readonly string[] {
  const names = new Set<string>([resourceKey]);
  const normalizedResourceKey = stripMinecraftNamespace(resourceKey);

  names.add(normalizedResourceKey);

  if (!resourceKey.includes(":")) {
    names.add(`minecraft:${resourceKey}`);
  }

  for (const alias of readRuntimeResourceKeyAliases(resourceKey)) {
    names.add(alias);
    names.add(stripMinecraftNamespace(alias));

    if (!alias.includes(":")) {
      names.add(`minecraft:${alias}`);
    }
  }

  return Object.freeze([...names]);
}

export function blockMatchesResourceKey(
  registry: unknown,
  block: MineflayerBlockHandle,
  resourceKey: string,
): boolean {
  const blockName = block.name ?? "";
  const lookupNames = createResourceKeyLookupNames(resourceKey);

  if (
    lookupNames.some((name) => blockName === name || blockName === stripMinecraftNamespace(name))
  ) {
    return true;
  }

  return blockHasRuntimeResourceTag(registry, block, resourceKey);
}

export function blockHasRuntimeResourceTag(
  registry: unknown,
  block: MineflayerBlockHandle,
  resourceKey: string,
): boolean {
  const directTags = readBlockDirectTags(block.tags);
  const tagNames = createResourceKeyLookupNames(resourceKey);

  if (tagNames.some((tag) => directTags.has(tag))) {
    return true;
  }

  const registryTagValues = getRegistryResourceTagIds(registry, resourceKey);

  return (
    registryTagValues.some((value) => value === block.type || value === block.name) ||
    blockMatchesRuntimeResourceFact(registry, block, resourceKey)
  );
}

export function createRuntimeResourceSemanticRoles(
  registry: unknown,
  block: MineflayerBlockHandle,
): readonly RuntimeResourceBlockSemanticRole[] {
  return blockHasRuntimeResourceTag(registry, block, "logs") ||
    blockMatchesRuntimeResourceFact(registry, block, "tree")
    ? Object.freeze(["cut_tree_log"] as const)
    : Object.freeze([]);
}

export function createRuntimeResourceTags(
  registry: unknown,
  block: MineflayerBlockHandle,
): readonly string[] {
  const tags = new Set(readBlockDirectTags(block.tags));
  const registryRecord = asRecord(registry);
  const blockTags =
    asRecord(registryRecord?.blockTags) ??
    asRecord(registryRecord?.blocksByTag) ??
    asRecord(asRecord(registryRecord?.tags)?.blocks);

  if (blockTags !== undefined) {
    for (const [tagName, value] of Object.entries(blockTags)) {
      const entries = normalizeRegistryTagValue(value);

      if (entries.some((entry) => entry === block.type || entry === block.name)) {
        tags.add(tagName);
      }
    }
  }

  return Object.freeze([...tags].sort());
}

export function registryCanResolveResourceKey(registry: unknown, resourceKey: string): boolean {
  const registryRecord = asRecord(registry);
  const blocksByName = asRecord(registryRecord?.blocksByName);

  return (
    createResourceKeyLookupNames(resourceKey).some((name) => blocksByName?.[name] !== undefined) ||
    getRegistryResourceTagIds(registry, resourceKey).length > 0 ||
    registryCanResolveResourceFact(registry, resourceKey)
  );
}

export function createInventoryItemIdsForSemanticRole(
  registry: unknown,
  role: RuntimeResourceBlockSemanticRole,
): ReadonlySet<number> {
  if (role !== "cut_tree_log") {
    return new Set();
  }

  const itemIds = new Set<number>();
  const blocksByName = asRecord(asRecord(registry)?.blocksByName);
  const itemsByName = asRecord(asRecord(registry)?.itemsByName);

  if (blocksByName === undefined) {
    return itemIds;
  }

  for (const blockFact of Object.values(blocksByName)) {
    const fact = asRecord(blockFact);
    if (fact === undefined || !isCutTreeLogLikeBlockFact(fact)) {
      continue;
    }

    for (const dropId of readRegistryBlockDropIds(fact)) {
      itemIds.add(dropId);
    }

    const blockName = typeof fact.name === "string" ? fact.name : null;
    const itemFact = blockName === null ? undefined : asRecord(itemsByName?.[blockName]);
    const itemId = readNumber(itemFact?.id, Number.NaN);
    if (Number.isInteger(itemId)) {
      itemIds.add(itemId);
    }
  }

  return itemIds;
}

export function createInventoryItemIdsForRegistryBlockTag(
  registry: unknown,
  tagName: string,
): ReadonlySet<number> {
  const normalizedTagName = normalizeRegistryName(tagName);
  const itemIds = new Set<number>();
  const blocksByName = asRecord(asRecord(registry)?.blocksByName);
  const itemsByName = asRecord(asRecord(registry)?.itemsByName);

  if (blocksByName === undefined) {
    return itemIds;
  }

  for (const blockFact of Object.values(blocksByName)) {
    const fact = asRecord(blockFact);
    if (fact === undefined || !registryBlockHasTag(registry, fact, normalizedTagName)) {
      continue;
    }

    for (const dropId of readRegistryBlockDropIds(fact)) {
      itemIds.add(dropId);
    }

    const blockName = typeof fact.name === "string" ? normalizeRegistryName(fact.name) : null;
    const itemFact = blockName === null ? undefined : asRecord(itemsByName?.[blockName]);
    const itemId = readNumber(itemFact?.id, Number.NaN);
    if (Number.isInteger(itemId)) {
      itemIds.add(itemId);
    }
  }

  return itemIds;
}

export function registryBlockHasTag(
  registry: unknown,
  blockFact: Readonly<Record<string, unknown>>,
  normalizedTagName: string,
): boolean {
  const directTags = readBlockDirectTags(blockFact.tags as MineflayerBlockHandle["tags"]);
  if (directTags.has(normalizedTagName)) {
    return true;
  }

  const blockId = readNumber(blockFact.id, Number.NaN);
  if (!Number.isInteger(blockId)) {
    return false;
  }

  const blockTags = asRecord(asRecord(asRecord(registry)?.tags)?.blocks);
  const values = normalizeRegistryTagValue(blockTags?.[normalizedTagName]);
  return values.includes(blockId);
}

function blockMatchesRuntimeResourceFact(
  registry: unknown,
  block: MineflayerBlockHandle,
  resourceKey: string,
): boolean {
  const normalizedResourceKey = stripMinecraftNamespace(resourceKey);

  if (normalizedResourceKey !== "tree" && normalizedResourceKey !== "logs") {
    return false;
  }

  const fact = readRegistryBlockFactForBlock(registry, block);

  return isCutTreeLogLikeBlockFact(fact);
}

function registryCanResolveResourceFact(registry: unknown, resourceKey: string): boolean {
  const normalizedResourceKey = stripMinecraftNamespace(resourceKey);

  if (normalizedResourceKey !== "tree" && normalizedResourceKey !== "logs") {
    return false;
  }

  const blocksByName = asRecord(asRecord(registry)?.blocksByName);

  return blocksByName === undefined
    ? false
    : Object.values(blocksByName).some((fact) => isCutTreeLogLikeBlockFact(asRecord(fact)));
}

function getRegistryResourceTagIds(
  registry: unknown,
  resourceKey: string,
): readonly (number | string)[] {
  const registryRecord = asRecord(registry);
  const blockTags =
    asRecord(registryRecord?.blockTags) ??
    asRecord(registryRecord?.blocksByTag) ??
    asRecord(asRecord(registryRecord?.tags)?.blocks);
  const tagNames = createResourceKeyLookupNames(resourceKey);

  if (blockTags === undefined) {
    return Object.freeze([]);
  }

  return Object.freeze(
    tagNames.flatMap((tagName) => normalizeRegistryTagValue(blockTags[tagName])),
  );
}

function readRuntimeResourceKeyAliases(resourceKey: string): readonly string[] {
  const normalizedResourceKey = stripMinecraftNamespace(resourceKey);

  return normalizedResourceKey === "tree" ? Object.freeze(["logs"] as const) : Object.freeze([]);
}

function stripMinecraftNamespace(value: string): string {
  return value.startsWith("minecraft:") ? value.slice("minecraft:".length) : value;
}
