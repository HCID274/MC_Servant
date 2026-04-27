/**
 * minecraft-data（MC 事实包） 查询适配器。
 *
 * 该模块只封装版本化 registry（注册表） 的只读查询，不承载任何手写 Minecraft（我的世界）事实。
 */

import { createRequire } from "node:module";

import type {
  MinecraftBlockFact,
  MinecraftFactsQueryPort,
  MinecraftItemFact,
  MinecraftRecipeFact,
} from "./contracts.js";

interface MinecraftDataBlockRecord {
  readonly id: number;
  readonly name: string;
  readonly displayName: string;
  readonly stackSize?: number;
  readonly hardness?: number;
  readonly resistance?: number;
  readonly diggable?: boolean;
  readonly material?: string;
  readonly transparent?: boolean;
  readonly emitLight?: number;
  readonly filterLight?: number;
  readonly defaultState?: number;
  readonly minStateId?: number;
  readonly maxStateId?: number;
  readonly drops?: readonly number[];
  readonly boundingBox?: string;
}

interface MinecraftDataItemRecord {
  readonly id: number;
  readonly name: string;
  readonly displayName: string;
  readonly stackSize?: number;
}

interface MinecraftDataRecipeRecord {
  readonly result: {
    readonly id: number;
    readonly count?: number;
  };
  readonly ingredients?: readonly number[];
  readonly inShape?: readonly (readonly number[])[];
  readonly outShape?: readonly (readonly number[])[];
}

interface MinecraftDataRegistry {
  readonly blocks: Readonly<Record<string, MinecraftDataBlockRecord | undefined>>;
  readonly blocksByName: Readonly<Record<string, MinecraftDataBlockRecord | undefined>>;
  readonly items: Readonly<Record<string, MinecraftDataItemRecord | undefined>>;
  readonly itemsByName: Readonly<Record<string, MinecraftDataItemRecord | undefined>>;
  readonly recipes: Readonly<Record<string, readonly MinecraftDataRecipeRecord[] | undefined>>;
}

type MinecraftDataLoader = (version: string) => MinecraftDataRegistry | null;

const require = createRequire(import.meta.url);
const loadMinecraftData = require("minecraft-data") as MinecraftDataLoader;

function assertNonBlankMinecraftFactInput(value: string, fieldName: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
}

function assertMinecraftFactId(value: number, fieldName: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative integer`);
  }
}

function cloneNumberList(values: readonly number[] | undefined): readonly number[] {
  return Object.freeze([...(values ?? [])]);
}

function cloneNumberMatrix(
  values: readonly (readonly number[])[] | undefined,
): readonly (readonly number[])[] {
  return Object.freeze((values ?? []).map((row) => cloneNumberList(row)));
}

function createBlockFact(block: MinecraftDataBlockRecord): MinecraftBlockFact {
  return Object.freeze({
    id: block.id,
    name: block.name,
    display_name: block.displayName,
    stack_size: block.stackSize ?? 64,
    hardness: block.hardness ?? null,
    resistance: block.resistance ?? null,
    diggable: block.diggable ?? false,
    material: block.material ?? null,
    transparent: block.transparent ?? false,
    emit_light: block.emitLight ?? 0,
    filter_light: block.filterLight ?? 0,
    default_state: block.defaultState ?? null,
    min_state_id: block.minStateId ?? null,
    max_state_id: block.maxStateId ?? null,
    drops: cloneNumberList(block.drops),
    bounding_box: block.boundingBox ?? null,
  });
}

function createItemFact(item: MinecraftDataItemRecord): MinecraftItemFact {
  return Object.freeze({
    id: item.id,
    name: item.name,
    display_name: item.displayName,
    stack_size: item.stackSize ?? 64,
  });
}

function createRecipeFact(
  recipe: MinecraftDataRecipeRecord,
  resultItem: MinecraftDataItemRecord,
): MinecraftRecipeFact {
  return Object.freeze({
    result: Object.freeze({
      id: recipe.result.id,
      name: resultItem.name,
      count: recipe.result.count ?? 1,
    }),
    ingredients: cloneNumberList(recipe.ingredients),
    in_shape: cloneNumberMatrix(recipe.inShape),
    out_shape: cloneNumberMatrix(recipe.outShape),
  });
}

function findRecordById<TRecord extends { readonly id: number }>(
  records: Readonly<Record<string, TRecord | undefined>>,
  id: number,
): TRecord | undefined {
  return Object.values(records).find((record) => record?.id === id);
}

/** 创建绑定到指定版本的 Minecraft（我的世界）事实查询端口。 */
export function createMinecraftDataFactsPort(version: string): MinecraftFactsQueryPort {
  assertNonBlankMinecraftFactInput(version, "minecraftVersion");

  const registry = loadMinecraftData(version);

  if (registry === null) {
    throw new Error(`Unsupported Minecraft data version: ${version}`);
  }

  return Object.freeze({
    version,
    getBlockByName(name: string) {
      assertNonBlankMinecraftFactInput(name, "blockName");

      const block = registry.blocksByName[name];

      return block ? createBlockFact(block) : null;
    },
    getBlockById(id: number) {
      assertMinecraftFactId(id, "blockId");

      const block = findRecordById(registry.blocks, id);

      return block ? createBlockFact(block) : null;
    },
    getItemByName(name: string) {
      assertNonBlankMinecraftFactInput(name, "itemName");

      const item = registry.itemsByName[name];

      return item ? createItemFact(item) : null;
    },
    getItemById(id: number) {
      assertMinecraftFactId(id, "itemId");

      const item = findRecordById(registry.items, id);

      return item ? createItemFact(item) : null;
    },
    queryRecipesByResultName(resultItemName: string) {
      assertNonBlankMinecraftFactInput(resultItemName, "resultItemName");

      const resultItem = registry.itemsByName[resultItemName];

      if (!resultItem) {
        return Object.freeze([]);
      }

      const recipes = registry.recipes[String(resultItem.id)] ?? [];

      return Object.freeze(
        recipes.map((recipe) => createRecipeFact(recipe, resultItem)),
      ) as readonly MinecraftRecipeFact[];
    },
  });
}
