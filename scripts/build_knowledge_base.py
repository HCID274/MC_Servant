#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
静态知识库构建脚本

从 minecraft-data 提取所有物品/方块 ID，
使用 Regex + LLM 混合策略生成语义标签，
输出 mc_knowledge_base.json 供 EntityResolver 使用。

设计原则：简单的接口，深度的功能；依赖抽象，而非具体
"""

import json
import re
import logging
import argparse
import hashlib
from abc import ABC, abstractmethod
from pathlib import Path
from datetime import datetime
from typing import Dict, List, Set, Optional, Any, Tuple
from dataclasses import dataclass, field

# ============================================================================
# 抽象接口定义
# ============================================================================

class IDataSource(ABC):
    """数据源抽象接口"""
    
    @abstractmethod
    def get_all_items(self) -> List[str]:
        """获取所有物品 ID 列表"""
        pass
    
    @abstractmethod
    def get_all_blocks(self) -> List[str]:
        """获取所有方块 ID 列表"""
        pass
    
    @abstractmethod
    def get_foods(self) -> List[str]:
        """获取所有食物 ID 列表"""
        pass
    
    @abstractmethod
    def get_version(self) -> str:
        """获取数据版本"""
        pass


class ITagGenerator(ABC):
    """标签生成器抽象接口"""
    
    @abstractmethod
    def generate(self, items: List[str]) -> Dict[str, List[str]]:
        """
        为物品列表生成标签分类
        
        Args:
            items: 物品 ID 列表
            
        Returns:
            Dict[tag_name, List[item_id]]
        """
        pass
    
    @abstractmethod
    def get_unclassified(self) -> List[str]:
        """获取未能分类的物品列表"""
        pass


class ILLMClient(ABC):
    """LLM 客户端抽象接口 (用于标签生成)"""
    
    @abstractmethod
    def classify_items(self, items: List[str], available_tags: List[str]) -> Dict[str, List[str]]:
        """
        使用 LLM 对物品进行分类
        
        Args:
            items: 待分类物品列表
            available_tags: 可用标签列表
            
        Returns:
            Dict[tag_name, List[item_id]]
        """
        pass


class ICache(ABC):
    """缓存抽象接口"""
    
    @abstractmethod
    def get(self, key: str) -> Optional[Dict]:
        pass
    
    @abstractmethod
    def set(self, key: str, value: Dict) -> None:
        pass


# ============================================================================
# 具体实现
# ============================================================================

class FileCache(ICache):
    """文件缓存实现 - 避免重复调用 LLM"""
    
    def __init__(self, cache_dir: Path):
        self._cache_dir = cache_dir
        self._cache_dir.mkdir(parents=True, exist_ok=True)
    
    def _get_path(self, key: str) -> Path:
        # 使用 MD5 hash 作为文件名
        hash_key = hashlib.md5(key.encode()).hexdigest()[:16]
        return self._cache_dir / f"{hash_key}.json"
    
    def get(self, key: str) -> Optional[Dict]:
        path = self._get_path(key)
        if path.exists():
            try:
                with open(path, 'r', encoding='utf-8') as f:
                    return json.load(f)
            except Exception:
                return None
        return None
    
    def set(self, key: str, value: Dict) -> None:
        path = self._get_path(key)
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(value, f, ensure_ascii=False)


class MinecraftDataSource(IDataSource):
    """
    从 npm minecraft-data 包的 JSON 文件提取游戏数据
    
    确保生成的 ID 100% 存在于游戏中，杜绝 LLM 幻觉
    """
    
    def __init__(self, version: str = "1.20.6", data_root: Optional[Path] = None):
        """
        初始化数据源
        
        Args:
            version: Minecraft 版本 (如 "1.20.6")
            data_root: minecraft-data 数据根目录，默认自动查找
        """
        self._version = version
        self._data_root = data_root or self._find_data_root()
        self._data_paths = self._load_data_paths()
        self._items_cache: Optional[List[str]] = None
        self._blocks_cache: Optional[List[str]] = None
        self._foods_cache: Optional[List[str]] = None
    
    def _find_data_root(self) -> Path:
        """查找 minecraft-data 数据目录"""
        script_dir = Path(__file__).parent
        # 根据实际目录结构，minecraft-data/minecraft-data/data 是正确路径
        candidates = [
            script_dir.parent / "backend" / "node_modules" / "minecraft-data" / "minecraft-data" / "data",
            script_dir / "node_modules" / "minecraft-data" / "minecraft-data" / "data",
            # 备选：直接 minecraft-data/data 结构
            script_dir.parent / "backend" / "node_modules" / "minecraft-data" / "data",
        ]
        
        for candidate in candidates:
            if candidate.exists() and (candidate / "dataPaths.json").exists():
                logging.info(f"找到 minecraft-data 数据目录: {candidate}")
                return candidate
        
        raise FileNotFoundError(
            f"找不到 minecraft-data 数据目录，请确保已安装 npm minecraft-data 包\n"
            f"尝试的路径: {[str(c) for c in candidates]}"
        )
    
    def _load_data_paths(self) -> Dict[str, str]:
        """加载版本数据路径映射"""
        paths_file = self._data_root / "dataPaths.json"
        with open(paths_file, 'r', encoding='utf-8') as f:
            all_paths = json.load(f)
        
        if "pc" not in all_paths or self._version not in all_paths["pc"]:
            available = list(all_paths.get("pc", {}).keys())[-10:]
            raise ValueError(
                f"不支持的版本: {self._version}\n"
                f"可用版本 (最近10个): {available}"
            )
        
        return all_paths["pc"][self._version]
    
    def _load_json(self, data_type: str) -> List[Dict]:
        """加载指定类型的 JSON 数据"""
        if data_type not in self._data_paths:
            logging.warning(f"版本 {self._version} 没有 {data_type} 数据")
            return []
        
        # 路径格式: "pc/1.20.5" -> 需要拼接完整路径
        relative_path = self._data_paths[data_type]
        data_path = self._data_root / relative_path / f"{data_type}.json"
        
        if not data_path.exists():
            logging.warning(f"数据文件不存在: {data_path}")
            return []
        
        with open(data_path, 'r', encoding='utf-8') as f:
            return json.load(f)
    
    def get_all_items(self) -> List[str]:
        """获取所有物品 ID"""
        if self._items_cache is None:
            items_data = self._load_json("items")
            self._items_cache = [item['name'] for item in items_data]
            logging.info(f"加载了 {len(self._items_cache)} 个物品")
        return self._items_cache
    
    def get_all_blocks(self) -> List[str]:
        """获取所有方块 ID"""
        if self._blocks_cache is None:
            blocks_data = self._load_json("blocks")
            self._blocks_cache = [block['name'] for block in blocks_data]
            logging.info(f"加载了 {len(self._blocks_cache)} 个方块")
        return self._blocks_cache
    
    def get_foods(self) -> List[str]:
        """获取所有食物 ID (从 foods.json)"""
        if self._foods_cache is None:
            foods_data = self._load_json("foods")
            if foods_data:
                self._foods_cache = [food['name'] for food in foods_data]
                logging.info(f"加载了 {len(self._foods_cache)} 个食物")
            else:
                self._foods_cache = []
        return self._foods_cache
    
    def get_version(self) -> str:
        return self._version


class RegexTagGenerator(ITagGenerator):
    """
    基于正则表达式的标签生成器
    
    利用 Minecraft 物品的命名规律，快速分类 ~80% 的常规物品
    """
    
    # 规则按优先级排序 (越靠前优先级越高)
    RULES: List[Tuple[str, str]] = [
        # === 精确匹配优先 ===
        
        # 刷怪蛋 (必须在其他规则之前)
        ("spawn_eggs", r".*_spawn_egg$"),
        
        # 音乐唱片
        ("music_discs", r"^music_disc_.*$"),
        
        # 陶片
        ("pottery_sherds", r".*_pottery_sherd$"),
        
        # 锻造模板
        ("smithing_templates", r".*_smithing_template$"),
        
        # 旗帜图案
        ("banner_patterns", r".*_banner_pattern$"),
        
        # 盔甲纹饰
        ("armor_trims", r".*_armor_trim$"),
        
        # === 资源类 ===
        
        # 原木 (包括下界木)
        ("logs", r"^(oak|birch|spruce|jungle|acacia|dark_oak|mangrove|cherry|crimson|warped|pale_oak)_(log|stem)$"),
        ("stripped_logs", r"^stripped_.*_(log|stem|wood|hyphae)$"),
        ("wood", r"^(oak|birch|spruce|jungle|acacia|dark_oak|mangrove|cherry|pale_oak)_wood$"),
        
        # 木板
        ("planks", r".*_planks$"),
        
        # 矿石
        ("ores", r".*_ore$"),
        ("deepslate_ores", r"^deepslate_.*_ore$"),
        ("raw_ores", r"^raw_(iron|gold|copper)(_block)?$"),
        
        # 锭/宝石
        ("ingots", r"^(iron|gold|copper|netherite)_ingot$"),
        ("gems", r"^(diamond|emerald|amethyst_shard|lapis_lazuli|quartz)$"),
        
        # 煤炭类
        ("coal", r"^(coal|charcoal)$"),
        
        # === 装备类 ===
        
        # 武器
        ("swords", r".*_sword$"),
        ("bows", r"^(bow|crossbow)$"),
        ("tridents", r"^trident$"),
        
        # 工具
        ("pickaxes", r".*_pickaxe$"),
        ("axes", r".*_axe$"),
        ("shovels", r".*_shovel$"),
        ("hoes", r".*_hoe$"),
        
        # 护甲
        ("helmets", r".*_helmet$"),
        ("chestplates", r".*_chestplate$"),
        ("leggings", r".*_leggings$"),
        ("boots", r".*_boots$"),
        
        # === 建筑类 ===
        
        # 楼梯/台阶/墙
        ("stairs", r".*_stairs$"),
        ("slabs", r".*_slab$"),
        ("walls", r".*_wall$"),
        
        # 栅栏/门
        ("fences", r".*_fence$"),
        ("fence_gates", r".*_fence_gate$"),
        ("doors", r".*_door$"),
        ("trapdoors", r".*_trapdoor$"),
        
        # 按钮/压力板
        ("buttons", r".*_button$"),
        ("pressure_plates", r".*_pressure_plate$"),
        
        # 告示牌
        ("signs", r".*_sign$"),
        ("hanging_signs", r".*_hanging_sign$"),
        
        # === 装饰类 ===
        
        # 羊毛/地毯
        ("wool", r".*_wool$"),
        ("carpets", r".*_carpet$"),
        
        # 玻璃 (修复: 支持 glass 和 glass_pane 本身)
        ("glass", r"^(glass|.*_glass)$"),
        ("glass_panes", r"^(glass_pane|.*_glass_pane)$"),
        
        # 陶瓦 (修复: 支持 terracotta 本身)
        ("terracotta", r"^(terracotta|.*_terracotta)$"),
        ("glazed_terracotta", r".*_glazed_terracotta$"),
        
        # 混凝土
        ("concrete", r".*_concrete$"),
        ("concrete_powder", r".*_concrete_powder$"),
        
        # 蜡烛 (修复: 支持 candle 本身)
        ("candles", r"^(candle|.*_candle)$"),
        
        # 珊瑚 (修复: 支持 wall_fan)
        ("corals", r".*(coral|coral_block|coral_fan|coral_wall_fan)$"),
        
        # 旗帜
        ("banners", r".*_banner$"),
        
        # 床
        ("beds", r".*_bed$"),
        
        # 蛙明灯
        ("froglights", r".*_froglight$"),
        
        # === 红石类 (修复: 增加 bell, lightning_rod, note_block, tripwire 等) ===
        
        ("redstone_components", r"^(redstone|redstone_block|redstone_torch|redstone_wall_torch|redstone_lamp|redstone_wire|repeater|comparator|observer|piston|sticky_piston|dropper|dispenser|hopper|lever|daylight_detector|target|sculk_sensor|calibrated_sculk_sensor|bell|lightning_rod|note_block|tripwire|tripwire_hook)$"),
        
        # === 农业类 ===
        
        # 种子
        ("seeds", r".*_seeds$"),
        
        # 树苗
        ("saplings", r".*_sapling$"),
        
        # 花卉 (修复: 增加 pink_petals, spore_blossom)
        ("flowers", r"^(dandelion|poppy|blue_orchid|allium|azure_bluet|.*_tulip|oxeye_daisy|cornflower|lily_of_the_valley|sunflower|lilac|rose_bush|peony|wither_rose|torchflower|pitcher_plant|cherry_blossom|pink_petals|spore_blossom)$"),
        
        # 树叶
        ("leaves", r".*_leaves$"),
        
        # === 交通类 ===
        
        # 船
        ("boats", r".*_boat$"),
        ("chest_boats", r".*_chest_boat$"),
        
        # 矿车
        ("minecarts", r".*minecart$"),
        
        # 铁轨
        ("rails", r".*rail$"),
        
        # === 染料 ===
        ("dyes", r".*_dye$"),
        
        # === 药水相关 ===
        ("potions", r"^(potion|splash_potion|lingering_potion)$"),
        
        # === 附魔书 ===
        ("enchanted_books", r"^enchanted_book$"),
        
        # === 头颅 ===
        ("heads", r".*_(head|skull)$"),
        
        # === 唱片机 ===
        ("jukeboxes", r"^jukebox$"),
        
        # =====================================================================
        # 以下是补充规则 - 覆盖剩余物品
        # =====================================================================
        
        # 空气/技术方块 (修复: 增加 moving_piston)
        ("air_blocks", r"^(air|cave_air|void_air)$"),
        ("technical_blocks", r"^(barrier|structure_void|structure_block|jigsaw|command_block|chain_command_block|repeating_command_block|light|debug_stick|knowledge_book|moving_piston)$"),
        
        # 下界菌柄
        ("hyphae", r"^(crimson|warped)_hyphae$"),
        
        # 矿物方块
        ("mineral_blocks", r"^(diamond_block|emerald_block|gold_block|iron_block|copper_block|lapis_block|coal_block|netherite_block|amethyst_block|quartz_block|redstone_block)$"),
        
        # 锤/三叉戟
        ("maces", r"^mace$"),
        
        # 其他工具
        ("fishing_rods", r"^fishing_rod$"),
        ("shears", r"^shears$"),
        ("flint_and_steel", r"^flint_and_steel$"),
        ("brushes", r"^brush$"),
        ("spyglasses", r"^spyglass$"),
        
        # 马铠
        ("horse_armor", r".*_horse_armor$"),
        
        # 其他装备
        ("shields", r"^shield$"),
        ("elytras", r"^elytra$"),
        ("wolf_armor", r"^wolf_armor$"),
        
        # 石头变种
        ("stone_variants", r"^(stone|cobblestone|mossy_cobblestone|stone_bricks|mossy_stone_bricks|cracked_stone_bricks|chiseled_stone_bricks|smooth_stone|cobbled_deepslate|deepslate|deepslate_bricks|deepslate_tiles|cracked_deepslate_bricks|cracked_deepslate_tiles|chiseled_deepslate|polished_deepslate|reinforced_deepslate)$"),
        ("andesite_variants", r"^(andesite|polished_andesite)$"),
        ("diorite_variants", r"^(diorite|polished_diorite)$"),
        ("granite_variants", r"^(granite|polished_granite)$"),
        ("tuff_variants", r"^(tuff|polished_tuff|tuff_bricks|chiseled_tuff|chiseled_tuff_bricks)$"),
        ("basalt_variants", r"^(basalt|polished_basalt|smooth_basalt)$"),
        ("blackstone_variants", r"^(blackstone|polished_blackstone|polished_blackstone_bricks|cracked_polished_blackstone_bricks|chiseled_polished_blackstone|gilded_blackstone)$"),
        
        # 砖块
        ("bricks", r"^(bricks|brick|nether_bricks|nether_brick|red_nether_bricks|cracked_nether_bricks|chiseled_nether_bricks|mud_bricks|prismarine_bricks|end_stone_bricks|quartz_bricks)$"),
        
        # 砂岩
        ("sandstone_variants", r"^(sandstone|red_sandstone|smooth_sandstone|smooth_red_sandstone|cut_sandstone|cut_red_sandstone|chiseled_sandstone|chiseled_red_sandstone)$"),
        
        # 紫珀
        ("purpur", r"^(purpur_block|purpur_pillar)$"),
        
        # 铜方块
        ("copper_blocks", r"^(copper_block|exposed_copper|weathered_copper|oxidized_copper|cut_copper|exposed_cut_copper|weathered_cut_copper|oxidized_cut_copper|chiseled_copper|exposed_chiseled_copper|weathered_chiseled_copper|oxidized_chiseled_copper|copper_grate|exposed_copper_grate|weathered_copper_grate|oxidized_copper_grate|copper_bulb|exposed_copper_bulb|weathered_copper_bulb|oxidized_copper_bulb)$"),
        ("waxed_copper", r"^waxed_.*$"),
        
        # 潜影盒
        ("shulker_boxes", r".*shulker_box$"),
        
        # 花盆
        ("flower_pots", r"^(flower_pot|potted_.*)$"),
        
        # 物品展示框
        ("item_frames", r"^(item_frame|glow_item_frame)$"),
        
        # 画/盔甲架
        ("paintings", r"^painting$"),
        ("armor_stands", r"^armor_stand$"),
        
        # 末地烛/链条/梯子/脚手架
        ("end_rods", r"^end_rod$"),
        ("chains", r"^chain$"),
        ("ladders", r"^ladder$"),
        ("scaffolding", r"^scaffolding$"),
        
        # 光源
        ("lights", r"^(torch|wall_torch|soul_torch|soul_wall_torch|lantern|soul_lantern|glowstone|sea_lantern|shroomlight|end_rod|campfire|soul_campfire|jack_o_lantern|redstone_lamp)$"),
        
        # 作物方块
        ("crops", r"^(wheat|carrots|potatoes|beetroots|melon_stem|pumpkin_stem|attached_melon_stem|attached_pumpkin_stem|torchflower_crop|pitcher_crop|cocoa|sweet_berry_bush|cave_vines|cave_vines_plant)$"),
        
        # 蘑菇
        ("mushrooms", r"^(brown_mushroom|red_mushroom|brown_mushroom_block|red_mushroom_block|mushroom_stem)$"),
        
        # 南瓜/西瓜
        ("pumpkins_melons", r"^(pumpkin|carved_pumpkin|melon)$"),
        
        # 高大植物
        ("tall_plants", r"^(cactus|bamboo|bamboo_block|bamboo_mosaic|sugar_cane)$"),
        
        # 苔藓/藤蔓
        ("moss_vines", r"^(moss_block|moss_carpet|glow_lichen|vine|weeping_vines|weeping_vines_plant|twisting_vines|twisting_vines_plant|hanging_roots)$"),
        
        # 海带
        ("kelp", r"^(kelp|kelp_plant|dried_kelp_block)$"),
        
        # 海草/蕨类
        ("seagrass_ferns", r"^(seagrass|tall_seagrass|fern|large_fern|short_grass|tall_grass|dead_bush)$"),
        
        # 杜鹃花
        ("azaleas", r"^(azalea|flowering_azalea)$"),
        
        # 滴水石
        ("dripstone", r"^(dripstone_block|pointed_dripstone)$"),
        
        # 大型垂滴叶
        ("dripleaf", r"^(big_dripleaf|big_dripleaf_stem|small_dripleaf)$"),
        
        # 紫晶
        ("amethyst", r"^(budding_amethyst|amethyst_cluster|small_amethyst_bud|medium_amethyst_bud|large_amethyst_bud)$"),
        
        # 竹筏
        ("rafts", r".*_raft$"),
        
        # 箭
        ("arrows", r"^(arrow|spectral_arrow|tipped_arrow)$"),
        
        # 容器
        ("chests", r"^(chest|trapped_chest|ender_chest)$"),
        ("barrels", r"^barrel$"),
        ("decorated_pots", r"^decorated_pot$"),
        ("bundles", r"^bundle$"),
        
        # 工作站
        ("workstations", r"^(crafting_table|furnace|blast_furnace|smoker|smithing_table|fletching_table|cartography_table|loom|stonecutter|grindstone|anvil|chipped_anvil|damaged_anvil|enchanting_table|brewing_stand|cauldron|water_cauldron|lava_cauldron|powder_snow_cauldron|composter|lectern|respawn_anchor|lodestone|beacon|conduit|crafter)$"),
        
        # 蜂巢/蜂蜜
        ("bee_related", r"^(bee_nest|beehive|honey_block|honeycomb_block|honeycomb)$"),
        
        # 生物掉落物 (修复: 增加 prismarine_shard, prismarine_crystals)
        ("mob_drops", r"^(bone|bone_meal|bone_block|blaze_rod|blaze_powder|ghast_tear|ender_pearl|ender_eye|nether_star|shulker_shell|phantom_membrane|rabbit_foot|rabbit_hide|leather|feather|string|cobweb|slime_ball|slime_block|magma_cream|ink_sac|glow_ink_sac|gunpowder|fermented_spider_eye|dragon_breath|dragon_egg|turtle_scute|turtle_egg|armadillo_scute|breeze_rod|nautilus_shell|heart_of_the_sea|totem_of_undying|nether_wart|nether_wart_block|warped_wart_block|goat_horn|prismarine_shard|prismarine_crystals)$"),
        
        # 泥土变种
        ("dirt_variants", r"^(dirt|grass_block|podzol|mycelium|coarse_dirt|rooted_dirt|dirt_path|farmland|mud|packed_mud|muddy_mangrove_roots)$"),
        
        # 沙子/沙砾
        ("sand_gravel", r"^(sand|red_sand|gravel|suspicious_sand|suspicious_gravel|clay|soul_sand|soul_soil)$"),
        
        # 雪/冰
        ("snow_ice", r"^(snow|snow_block|powder_snow|ice|packed_ice|blue_ice|frosted_ice)$"),
        
        # 下界方块
        ("nether_blocks", r"^(netherrack|nether_bricks|red_nether_bricks|cracked_nether_bricks|chiseled_nether_bricks|nether_wart_block|warped_wart_block|crimson_nylium|warped_nylium|crimson_roots|warped_roots|nether_sprouts|crimson_fungus|warped_fungus|shroomlight|crying_obsidian|ancient_debris|netherite_scrap|magma_block|soul_sand|soul_soil|glowstone|glowstone_dust)$"),
        
        # 末地方块
        ("end_blocks", r"^(end_stone|end_stone_bricks|end_portal|end_portal_frame|end_gateway|end_rod|chorus_plant|chorus_flower|popped_chorus_fruit|end_crystal|dragon_egg)$"),
        
        # 海洋方块
        ("ocean_blocks", r"^(prismarine|prismarine_bricks|dark_prismarine|sea_lantern|sponge|wet_sponge|sea_pickle|conduit)$"),
        
        # 书/地图
        ("books_maps", r"^(book|writable_book|written_book|bookshelf|chiseled_bookshelf|map|filled_map|paper|name_tag|lead)$"),
        
        # 桶
        ("buckets", r"^(bucket|water_bucket|lava_bucket|milk_bucket|powder_snow_bucket|axolotl_bucket|cod_bucket|salmon_bucket|tropical_fish_bucket|pufferfish_bucket|tadpole_bucket)$"),
        
        # 烟花/投掷物
        ("projectiles", r"^(firework_rocket|firework_star|fire_charge|wind_charge|snowball|egg|ender_pearl)$"),
        
        # 唱片碎片
        ("disc_fragments", r"^disc_fragment_.*$"),
        
        # 试炼相关
        ("trial_related", r"^(trial_spawner|trial_key|ominous_trial_key|vault|heavy_core)$"),
        
        # 流体
        ("fluids", r"^(water|lava|bubble_column)$"),
        
        # 火焰
        ("fire", r"^(fire|soul_fire)$"),
        
        # 传送门
        ("portals", r"^(nether_portal|end_portal|end_gateway)$"),
        
        # 刷怪笼
        ("spawners", r"^(spawner|trial_spawner)$"),
        
        # 特殊方块
        ("special_blocks", r"^(tnt|bedrock|obsidian|crying_obsidian|calcite|frogspawn|sniffer_egg|mangrove_roots|mangrove_propagule)$"),
        
        # Sculk 系列
        ("sculk", r"^(sculk|sculk_vein|sculk_catalyst|sculk_shrieker|sculk_sensor|calibrated_sculk_sensor)$"),
        
        # 杂项物品
        ("misc_items", r"^(stick|bowl|flint|brick|nether_brick|clay_ball|sugar|paper|compass|recovery_compass|clock|saddle|carrot_on_a_stick|warped_fungus_on_a_stick|glass_bottle|experience_bottle|glistering_melon_slice|cocoa_beans)$"),
        
        # 贵重物品 (修复: 增加 echo_shard)
        ("valuables", r"^(echo_shard)$"),
        
        # 被虫蛀的方块
        ("infested", r"^infested_.*$"),
        
        # 蜡烛蛋糕
        ("candle_cakes", r"^(candle_cake|.*_candle_cake)$"),
        
        # 石英方块
        ("quartz_blocks", r"^(chiseled_quartz_block|quartz_pillar|smooth_quartz)$"),
        
        # 其他单独物品
        ("hay_blocks", r"^hay_block$"),
        ("iron_bars", r"^iron_bars$"),
        ("lily_pads", r"^lily_pad$"),
        ("pitcher_pods", r"^pitcher_pod$"),
        ("stripped_bamboo", r"^stripped_bamboo_block$"),
        ("nuggets", r"^(iron|gold)_nugget$"),
        
        # 食物 (基于 foods.json)
        ("food", r"^(apple|mushroom_stew|bread|porkchop|cooked_porkchop|golden_apple|enchanted_golden_apple|cod|salmon|tropical_fish|pufferfish|cooked_cod|cooked_salmon|cookie|melon_slice|dried_kelp|beef|cooked_beef|chicken|cooked_chicken|rotten_flesh|spider_eye|carrot|potato|baked_potato|poisonous_potato|golden_carrot|pumpkin_pie|rabbit|cooked_rabbit|rabbit_stew|mutton|cooked_mutton|chorus_fruit|beetroot|beetroot_soup|suspicious_stew|sweet_berries|glow_berries|honey_bottle|ominous_bottle|cake)$"),
    ]
    
    def __init__(self, extra_rules: Optional[Dict[str, str]] = None):
        """
        初始化正则生成器
        
        Args:
            extra_rules: 额外的自定义规则
        """
        rules = list(self.RULES)
        if extra_rules:
            rules.extend((k, v) for k, v in extra_rules.items())
        
        self._compiled_rules = [(tag, re.compile(pattern)) for tag, pattern in rules]
        self._unclassified: List[str] = []
    
    def generate(self, items: List[str]) -> Dict[str, List[str]]:
        """使用正则规则分类物品"""
        result: Dict[str, List[str]] = {}
        self._unclassified = []
        
        for item in items:
            matched = False
            for tag, pattern in self._compiled_rules:
                if pattern.match(item):
                    if tag not in result:
                        result[tag] = []
                    result[tag].append(item)
                    matched = True
                    break  # 每个物品只归入一个 Tag
            
            if not matched:
                self._unclassified.append(item)
        
        return result
    
    def get_unclassified(self) -> List[str]:
        return self._unclassified


class FoodTagGenerator(ITagGenerator):
    """
    基于 foods.json 的食物标签生成器
    
    直接使用 minecraft-data 提供的食物列表
    """
    
    def __init__(self, data_source: IDataSource):
        self._data_source = data_source
        self._unclassified: List[str] = []
    
    def generate(self, items: List[str]) -> Dict[str, List[str]]:
        """从 foods.json 获取食物分类"""
        foods = set(self._data_source.get_foods())
        items_set = set(items)
        
        # 取交集
        food_items = sorted(foods & items_set)
        self._unclassified = sorted(items_set - foods)
        
        if food_items:
            return {"food": food_items}
        return {}
    
    def get_unclassified(self) -> List[str]:
        return self._unclassified


class LLMTagGenerator(ITagGenerator):
    """
    基于 LLM 的标签生成器
    
    处理 Regex 无法覆盖的杂项物品 (~20%)
    """
    
    # LLM 可分配的标签
    AVAILABLE_TAGS = [
        "lights",           # 发光物品
        "mob_drops",        # 生物掉落物
        "valuables",        # 贵重物品
        "containers",       # 容器
        "building_blocks",  # 建筑方块
        "decoration",       # 装饰物品
        "functional",       # 功能性物品
        "combat",           # 战斗相关
        "misc",             # 杂项
    ]
    
    PROMPT_TEMPLATE = """你是 Minecraft 物品分类专家。请将以下物品 ID 分类到对应标签。

可用标签及说明:
- lights: 发光物品 (torch, lantern, glowstone, sea_lantern, end_rod 等)
- mob_drops: 生物掉落物 (bone, spider_eye, ender_pearl, blaze_rod, ghast_tear 等)
- valuables: 贵重物品 (diamond_block, emerald_block, gold_block, beacon, nether_star 等)
- containers: 容器 (chest, barrel, shulker_box, ender_chest 等)
- building_blocks: 通用建筑方块 (stone, dirt, sand, gravel, bricks 等)
- decoration: 装饰物品 (painting, item_frame, flower_pot, armor_stand 等)
- functional: 功能性物品 (crafting_table, furnace, anvil, enchanting_table, brewing_stand 等)
- combat: 战斗相关 (arrow, shield, spectral_arrow, tipped_arrow 等)
- misc: 无法分类的杂项

物品列表:
{items}

输出格式 (纯 JSON，无其他内容):
{{"lights": ["torch", ...], "mob_drops": ["bone", ...], ...}}

规则:
1. 每个物品只归入最合适的一个标签
2. 不确定的归入 misc
3. 只输出 JSON，不要有任何其他文字"""

    def __init__(
        self, 
        llm_client: Optional[ILLMClient] = None, 
        cache: Optional[ICache] = None,
        batch_size: int = 50,
        max_retries: int = 3
    ):
        self._llm_client = llm_client
        self._cache = cache
        self._batch_size = batch_size
        self._max_retries = max_retries
        self._unclassified: List[str] = []
    
    def _get_cache_key(self, items: List[str]) -> str:
        """生成缓存键"""
        return f"llm_classify_{','.join(sorted(items))}"
    
    def generate(self, items: List[str]) -> Dict[str, List[str]]:
        """使用 LLM 分类物品"""
        if not self._llm_client:
            logging.warning("未配置 LLM 客户端，所有物品归入 misc")
            self._unclassified = items
            return {"misc": items}
        
        result: Dict[str, List[str]] = {tag: [] for tag in self.AVAILABLE_TAGS}
        
        # 分批处理
        for i in range(0, len(items), self._batch_size):
            batch = items[i:i + self._batch_size]
            
            # 检查缓存
            cache_key = self._get_cache_key(batch)
            if self._cache:
                cached = self._cache.get(cache_key)
                if cached:
                    logging.debug(f"使用缓存结果: batch {i//self._batch_size + 1}")
                    for tag, tag_items in cached.items():
                        if tag in result:
                            result[tag].extend(tag_items)
                    continue
            
            # 调用 LLM (带重试)
            batch_result = self._classify_with_retry(batch)
            
            # 保存缓存
            if self._cache and batch_result:
                self._cache.set(cache_key, batch_result)
            
            for tag, tag_items in batch_result.items():
                if tag in result:
                    result[tag].extend(tag_items)
                else:
                    result["misc"].extend(tag_items)
        
        # 移除空的 Tag
        result = {k: v for k, v in result.items() if v}
        self._unclassified = result.get("misc", [])
        return result
    
    def _classify_with_retry(self, items: List[str]) -> Dict[str, List[str]]:
        """带重试的分类调用"""
        for attempt in range(self._max_retries):
            try:
                return self._llm_client.classify_items(items, self.AVAILABLE_TAGS)
            except Exception as e:
                logging.warning(f"LLM 调用失败 (尝试 {attempt + 1}/{self._max_retries}): {e}")
                if attempt == self._max_retries - 1:
                    return {"misc": items}
        return {"misc": items}
    
    def get_unclassified(self) -> List[str]:
        return self._unclassified


class QwenLLMClient(ILLMClient):
    """通义千问 LLM 客户端实现"""
    
    def __init__(self, api_key: Optional[str] = None, model: str = "qwen-plus"):
        import os
        self._api_key = api_key or os.getenv("DASHSCOPE_API_KEY")
        self._model = model
        if not self._api_key:
            raise ValueError("需要设置 DASHSCOPE_API_KEY 环境变量或传入 api_key")
    
    def classify_items(self, items: List[str], available_tags: List[str]) -> Dict[str, List[str]]:
        """调用 Qwen 对物品分类"""
        from openai import OpenAI
        
        client = OpenAI(
            api_key=self._api_key,
            base_url="https://dashscope.aliyuncs.com/compatible-mode/v1"
        )
        
        prompt = LLMTagGenerator.PROMPT_TEMPLATE.format(
            items="\n".join(f"- {item}" for item in items)
        )
        
        response = client.chat.completions.create(
            model=self._model,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.1,
            response_format={"type": "json_object"}
        )
        
        content = response.choices[0].message.content
        result = json.loads(content)
        
        # 验证返回的 ID 在输入列表中
        valid_result = {}
        items_set = set(items)
        for tag, tag_items in result.items():
            if isinstance(tag_items, list):
                valid_items = [i for i in tag_items if i in items_set]
                if valid_items:
                    valid_result[tag] = valid_items
        
        return valid_result


# ============================================================================
# 知识库构建器
# ============================================================================

@dataclass
class BuildResult:
    """构建结果"""
    tags: Dict[str, List[str]]
    aliases: Dict[str, str]
    items: Dict[str, List[str]]  # 反向索引
    version: str
    stats: Dict[str, Any] = field(default_factory=dict)


class KnowledgeBaseBuilder:
    """
    知识库构建器 - 组合多个生成器
    
    流水线: 提取 → 食物分类 → 规则分类 → LLM 补全 → 合并 → 输出
    """
    
    # 自然语言别名映射 (中英文全覆盖)
    # 设计原则：支持玩家用自然语言描述，如"帮我弄点木头"、"给我挖点铁矿"
    DEFAULT_ALIASES = {
        # =====================================================================
        # 聚合标签 (Aggregate Tags) - 修复缺失的中文别名
        # =====================================================================
        "all_ores": "all_ores",
        "所有矿石": "all_ores",
        "矿石": "all_ores",
        
        "wood_materials": "wood_materials",
        "木材材料": "wood_materials",
        "木材": "wood_materials",
        
        "weapons": "weapons",
        "武器": "weapons",
        
        "tools": "tools",
        "工具": "tools",
        
        "armor": "armor",
        "护甲": "armor",
        "装备": "armor",
        
        "building_decorations": "building_decorations",
        "建筑装饰": "building_decorations",
        
        "all_glass": "all_glass",
        "所有玻璃": "all_glass",
        "玻璃": "all_glass",
        
        "all_terracotta": "all_terracotta",
        "所有陶瓦": "all_terracotta",
        "陶瓦": "all_terracotta",
        
        "all_concrete": "all_concrete",
        "所有混凝土": "all_concrete",
        "混凝土": "all_concrete",
        
        "all_boats": "all_boats",
        "所有船": "all_boats",
        "船": "all_boats",
        
        "all_signs": "all_signs",
        "所有告示牌": "all_signs",
        "告示牌": "all_signs",

        # =====================================================================
        # 资源类 - 木材 (通用与具体)
        # =====================================================================
        "wood": "logs",
        "log": "logs",
        "timber": "logs",
        "树": "logs",
        "木头": "logs",
        "原木": "logs",
        "树木": "logs",
        "圆木": "logs",
        "橡木": "logs",
        "白桦木": "logs",
        "云杉木": "logs",
        "丛林木": "logs",
        "金合欢木": "logs",
        "深色橡木": "logs",
        "红树木": "logs",
        "樱花木": "logs",
        "绯红木": "logs",
        "诡异木": "logs",

        "木材块": "wood",
        "木块": "wood",
        
        "plank": "planks",
        "木板": "planks",
        "木块": "planks",
        "板子": "planks",
        "橡木板": "planks",
        "白桦木板": "planks",
        
        "stripped_logs": "stripped_logs",
        "去皮原木": "stripped_logs",
        "去皮木": "stripped_logs",
        
        "stripped_bamboo": "stripped_bamboo",
        "去皮竹子": "stripped_bamboo",
        "去皮竹块": "stripped_bamboo",
        
        # =====================================================================
        # 资源类 - 矿石/金属
        # =====================================================================
        "ore": "ores",
        "矿": "ores",
        "煤矿": "ores",
        "铁矿": "ores",
        "金矿": "ores",
        "钻石矿": "ores",
        "绿宝石矿": "ores",
        "铜矿": "ores",
        "青金石矿": "ores",
        "红石矿": "ores",
        "深层矿": "deepslate_ores",
        "深层铁矿": "deepslate_ores",
        "深层金矿": "deepslate_ores",
        "深层钻石矿": "deepslate_ores",
        
        "raw_iron": "raw_ores",
        "粗铁": "raw_ores",
        "raw_gold": "raw_ores",
        "粗金": "raw_ores",
        "raw_copper": "raw_ores",
        "粗铜": "raw_ores",
        
        "ingot": "ingots",
        "锭": "ingots",
        "金属锭": "ingots",
        "铁锭": "ingots",
        "金锭": "ingots",
        "铜锭": "ingots",
        "下界合金锭": "ingots",
        
        "gem": "gems",
        "宝石": "gems",
        "钻石": "gems",
        "钻": "gems",
        "绿宝石": "gems",
        "绿宝": "gems",
        "青金石": "gems",
        "石英": "gems",
        "紫水晶": "gems",
        "紫水晶碎片": "gems",
        
        "nuggets": "nuggets",
        "金粒": "nuggets",
        "铁粒": "nuggets",
        
        "coal": "coal",
        "煤": "coal",
        "煤炭": "coal",
        "木炭": "coal",
        
        "iron": "ingots", 
        "gold": "ingots",
        "copper": "ingots",
        
        "redstone": "redstone_components",
        "红石": "redstone_components",
        "红石粉": "redstone_components",
        "红石块": "redstone_components",
        
        "amethyst": "amethyst",
        "紫水晶块": "amethyst",
        "紫水晶簇": "amethyst",
        
        "copper_blocks": "copper_blocks",
        "铜方块": "copper_blocks",
        "铜块": "copper_blocks",
        "切制铜块": "copper_blocks",
        
        "waxed_copper": "waxed_copper",
        "涂蜡铜": "waxed_copper",
        "涂蜡铜块": "waxed_copper",
        
        "mineral_blocks": "mineral_blocks",
        "矿物方块": "mineral_blocks",
        "矿物块": "mineral_blocks",
        
        # =====================================================================
        # 武器类
        # =====================================================================
        "weapon": "swords",
        "sword": "swords",
        "剑": "swords",
        "刀": "swords",
        "铁剑": "swords",
        "钻石剑": "swords",
        "木剑": "swords",
        "石剑": "swords",
        "金剑": "swords",
        "下界合金剑": "swords",
        
        "bow": "bows",
        "弓": "bows",
        "弓箭": "bows",
        "弩": "bows",
        "crossbow": "bows",
        
        "trident": "tridents",
        "三叉戟": "tridents",
        "叉子": "tridents",
        
        "mace": "maces",
        "锤": "maces",
        "锤子": "maces",
        "重锤": "maces",
        "狼牙棒": "maces",
        
        # =====================================================================
        # 工具类
        # =====================================================================
        "tool": "tools",
        
        "pick": "pickaxes",
        "pickaxe": "pickaxes",
        "镐": "pickaxes",
        "镐子": "pickaxes",
        "稿": "pickaxes",
        "稿子": "pickaxes",
        "铁镐": "pickaxes",
        "钻石镐": "pickaxes",
        "木镐": "pickaxes",
        "石镐": "pickaxes",
        "金镐": "pickaxes",
        "下界合金镐": "pickaxes",
        
        "axe": "axes",
        "斧": "axes",
        "斧头": "axes",
        "斧子": "axes",
        "铁斧": "axes",
        "钻石斧": "axes",
        "木斧": "axes",
        "石斧": "axes",
        
        "shovel": "shovels",
        "铲": "shovels",
        "铲子": "shovels",
        "锹": "shovels",
        "铁铲": "shovels",
        "钻石铲": "shovels",
        
        "hoe": "hoes",
        "锄": "hoes",
        "锄头": "hoes",
        "铁锄": "hoes",
        "钻石锄": "hoes",
        
        "fishing_rod": "fishing_rods",
        "鱼竿": "fishing_rods",
        "钓竿": "fishing_rods",
        "钓鱼竿": "fishing_rods",
        
        "shears": "shears",
        "剪刀": "shears",
        "羊毛剪": "shears",
        
        "flint_and_steel": "flint_and_steel",
        "打火石": "flint_and_steel",
        "火镰": "flint_and_steel",
        
        "brush": "brushes",
        "刷子": "brushes",
        
        "spyglass": "spyglasses",
        "望远镜": "spyglasses",
        
        "smithing_templates": "smithing_templates",
        "锻造模板": "smithing_templates",
        "模板": "smithing_templates",
        
        # =====================================================================
        # 护甲类
        # =====================================================================
        "armour": "armor",
        "盔甲": "armor",
        "防具": "armor",
        
        "helmet": "helmets",
        "头盔": "helmets",
        "帽子": "helmets",
        "铁头盔": "helmets",
        "钻石头盔": "helmets",
        "金头盔": "helmets",
        "皮革帽子": "helmets",
        
        "chestplate": "chestplates",
        "胸甲": "chestplates",
        "上衣": "chestplates",
        "铁胸甲": "chestplates",
        "钻石胸甲": "chestplates",
        
        "leggings": "leggings",
        "护腿": "leggings",
        "裤子": "leggings",
        "腿甲": "leggings",
        "铁护腿": "leggings",
        "钻石护腿": "leggings",
        
        "boots": "boots",
        "靴子": "boots",
        "鞋子": "boots",
        "鞋": "boots",
        "铁靴子": "boots",
        "钻石靴子": "boots",
        
        "shield": "shields",
        "盾": "shields",
        "盾牌": "shields",
        
        "elytra": "elytras",
        "鞘翅": "elytras",
        "翅膀": "elytras",
        "滑翔翼": "elytras",
        
        "horse_armor": "horse_armor",
        "马铠": "horse_armor",
        "马甲": "horse_armor",
        
        "wolf_armor": "wolf_armor",
        "狼铠": "wolf_armor",
        "狗铠": "wolf_armor",
        
        "armor_trims": "armor_trims",
        "盔甲纹饰": "armor_trims",
        "纹饰": "armor_trims",
        
        # =====================================================================
        # 食物类
        # =====================================================================
        "eat": "food",
        "food": "food",
        "食物": "food",
        "吃的": "food",
        "食品": "food",
        "吃": "food",
        "饭": "food",
        "肉": "food",
        "面包": "food",
        "苹果": "food",
        "牛肉": "food",
        "牛排": "food",
        "熟牛肉": "food",
        "猪肉": "food",
        "熟猪肉": "food",
        "猪排": "food",
        "鸡肉": "food",
        "熟鸡肉": "food",
        "羊肉": "food",
        "熟羊肉": "food",
        "鱼": "food",
        "熟鱼": "food",
        "鳕鱼": "food",
        "鲑鱼": "food",
        "蛋糕": "food",
        "曲奇": "food",
        "饼干": "food",
        "胡萝卜": "food",
        "金胡萝卜": "food",
        "土豆": "food",
        "马铃薯": "food",
        "烤土豆": "food",
        "甜菜": "food",
        "西瓜": "food",
        "西瓜片": "food",
        "南瓜派": "food",
        "金苹果": "food",
        "附魔金苹果": "food",
        "腐肉": "food",
        "迷之炖菜": "food",
        "甜浆果": "food",
        "发光浆果": "food",
        
        "candle_cakes": "candle_cakes",
        "插蜡烛的蛋糕": "candle_cakes",
        "蜡烛蛋糕": "candle_cakes",
        
        # =====================================================================
        # 光源类
        # =====================================================================
        "light": "lights",
        "torch": "lights",
        "灯": "lights",
        "火把": "lights",
        "光源": "lights",
        "照明": "lights",
        "灯笼": "lights",
        "萤石": "lights",
        "海晶灯": "lights",
        "营火": "lights",
        "篝火": "lights",
        "灵魂营火": "lights",
        "灵魂火把": "lights",
        "灵魂灯笼": "lights",
        "蛙明灯": "froglights",
        "发光": "lights",
        "亮的": "lights",
        
        "end_rods": "end_rods",
        "末地烛": "end_rods",
        
        # =====================================================================
        # 建筑类
        # =====================================================================
        "stair": "stairs",
        "stairs": "stairs",
        "楼梯": "stairs",
        "台阶楼梯": "stairs",
        
        "slab": "slabs",
        "台阶": "slabs",
        "半砖": "slabs",
        "半块": "slabs",
        
        "fence": "fences",
        "栅栏": "fences",
        "围栏": "fences",
        "篱笆": "fences",
        
        "fence_gate": "fence_gates",
        "栅栏门": "fence_gates",
        
        "door": "doors",
        "门": "doors",
        "木门": "doors",
        "铁门": "doors",
        
        "trapdoor": "trapdoors",
        "活板门": "trapdoors",
        "地板门": "trapdoors",
        "天窗": "trapdoors",
        
        "wall": "walls",
        "墙": "walls",
        "围墙": "walls",
        "石墙": "walls",
        
        "button": "buttons",
        "按钮": "buttons",
        "石按钮": "buttons",
        "木按钮": "buttons",
        
        "pressure_plate": "pressure_plates",
        "压力板": "pressure_plates",
        "踏板": "pressure_plates",
        
        "sign": "signs",
        "告示牌": "signs",
        "牌子": "signs",
        "标牌": "signs",
        "悬挂告示牌": "hanging_signs",
        "吊牌": "hanging_signs",
        
        "scaffolding": "scaffolding",
        "脚手架": "scaffolding",
        
        "ladders": "ladders",
        "梯子": "ladders",
        
        "chains": "chains",
        "链条": "chains",
        "锁链": "chains",
        
        "iron_bars": "iron_bars",
        "铁栏杆": "iron_bars",
        
        # =====================================================================
        # 装饰类
        # =====================================================================
        "wool": "wool",
        "羊毛": "wool",
        "白羊毛": "wool",
        "红羊毛": "wool",
        "蓝羊毛": "wool",
        
        "glass": "glass",
        "玻璃": "glass",
        "染色玻璃": "glass",
        "遮光玻璃": "glass",
        
        "glass_pane": "glass_panes",
        "玻璃板": "glass_panes",
        "玻璃片": "glass_panes",
        
        "carpet": "carpets",
        "地毯": "carpets",
        "羊毛毯": "carpets",
        
        "terracotta": "terracotta",
        "陶瓦": "terracotta",
        "硬化粘土": "terracotta",
        "带釉陶瓦": "glazed_terracotta",
        "彩釉陶瓦": "glazed_terracotta",
        
        "concrete": "concrete",
        "混凝土": "concrete",
        "水泥": "concrete",
        "混凝土粉末": "concrete_powder",
        
        "candle": "candles",
        "蜡烛": "candles",
        
        "banner": "banners",
        "旗帜": "banners",
        "旗子": "banners",
        
        "banner_patterns": "banner_patterns",
        "旗帜图案": "banner_patterns",
        
        "bed": "beds",
        "床": "beds",
        "红床": "beds",
        "白床": "beds",
        
        "flower_pot": "flower_pots",
        "花盆": "flower_pots",
        
        "painting": "paintings",
        "画": "paintings",
        "画作": "paintings",
        "挂画": "paintings",
        
        "item_frame": "item_frames",
        "物品展示框": "item_frames",
        "展示框": "item_frames",
        "发光物品展示框": "item_frames",
        
        "armor_stand": "armor_stands",
        "盔甲架": "armor_stands",
        "衣架": "armor_stands",
        
        "heads": "heads",
        "头颅": "heads",
        "头": "heads",
        "骷髅头": "heads",
        
        "decorated_pots": "decorated_pots",
        "饰纹陶罐": "decorated_pots",
        "陶罐": "decorated_pots",
        
        "pottery_sherds": "pottery_sherds",
        "陶片": "pottery_sherds",
        
        # =====================================================================
        # 农业类
        # =====================================================================
        "seed": "seeds",
        "种子": "seeds",
        "小麦种子": "seeds",
        "南瓜种子": "seeds",
        "西瓜种子": "seeds",
        
        "sapling": "saplings",
        "树苗": "saplings",
        "小树": "saplings",
        "橡木树苗": "saplings",
        
        "flower": "flowers",
        "花": "flowers",
        "花朵": "flowers",
        "鲜花": "flowers",
        "玫瑰": "flowers",
        "蒲公英": "flowers",
        "兰花": "flowers",
        "郁金香": "flowers",
        
        "azaleas": "azaleas",
        "杜鹃花": "azaleas",
        "盛开的杜鹃花": "azaleas",
        
        "crop": "crops",
        "作物": "crops",
        "庄稼": "crops",
        "农作物": "crops",
        "小麦": "crops",
        "可可豆": "crops",
        
        "mushroom": "mushrooms",
        "蘑菇": "mushrooms",
        "红蘑菇": "mushrooms",
        "棕蘑菇": "mushrooms",
        
        "leaf": "leaves",
        "leaves": "leaves",
        "树叶": "leaves",
        "叶子": "leaves",
        "橡木树叶": "leaves",
        
        "pumpkin": "pumpkins_melons",
        "南瓜": "pumpkins_melons",
        "melon": "pumpkins_melons",
        "西瓜": "pumpkins_melons",
        
        "bamboo": "tall_plants",
        "竹子": "tall_plants",
        "sugar_cane": "tall_plants",
        "甘蔗": "tall_plants",
        "cactus": "tall_plants",
        "仙人掌": "tall_plants",
        
        "kelp": "kelp",
        "海带": "kelp",
        "干海带块": "kelp",
        
        "seagrass_ferns": "seagrass_ferns",
        "海草": "seagrass_ferns",
        "蕨": "seagrass_ferns",
        "草": "seagrass_ferns",
        "枯萎的灌木": "seagrass_ferns",
        
        "moss_vines": "moss_vines",
        "苔藓": "moss_vines",
        "苔藓块": "moss_vines",
        "藤蔓": "moss_vines",
        "垂泪藤": "moss_vines",
        
        "dripleaf": "dripleaf",
        "垂滴叶": "dripleaf",
        
        "pitcher_pods": "pitcher_pods",
        "投手植物荚": "pitcher_pods",
        
        "hay_blocks": "hay_blocks",
        "干草块": "hay_blocks",
        
        "lily_pads": "lily_pads",
        "睡莲": "lily_pads",
        
        "bee_related": "bee_related",
        "蜜蜂": "bee_related",
        "蜂巢": "bee_related",
        "蜂箱": "bee_related",
        "蜂蜜块": "bee_related",
        
        # =====================================================================
        # 交通类
        # =====================================================================
        "boat": "boats",
        "船": "boats",
        "小船": "boats",
        "橡木船": "boats",
        "运输船": "chest_boats",
        
        "minecart": "minecarts",
        "矿车": "minecarts",
        "运输矿车": "minecarts",
        "漏斗矿车": "minecarts",
        "动力矿车": "minecarts",
        
        "rail": "rails",
        "铁轨": "rails",
        "轨道": "rails",
        "动力铁轨": "rails",
        "充能铁轨": "rails",
        "探测铁轨": "rails",
        "激活铁轨": "rails",
        
        "rafts": "rafts",
        "竹筏": "rafts",
        
        # =====================================================================
        # 容器类
        # =====================================================================
        "chest": "chests",
        "箱子": "chests",
        "木箱": "chests",
        "储物箱": "chests",
        "陷阱箱": "chests",
        
        "barrel": "barrels",
        "木桶": "barrels",
        
        "ender_chest": "chests",
        "末影箱": "chests",
        "末地箱": "chests",
        
        "shulker_box": "shulker_boxes",
        "潜影盒": "shulker_boxes",
        "潜影箱": "shulker_boxes",
        
        "bundle": "bundles",
        "收纳袋": "bundles",
        
        # =====================================================================
        # 工作站/功能方块
        # =====================================================================
        "crafting_table": "workstations",
        "工作台": "workstations",
        "合成台": "workstations",
        
        "furnace": "workstations",
        "熔炉": "workstations",
        "炉子": "workstations",
        "高炉": "workstations",
        "烟熏炉": "workstations",
        
        "anvil": "workstations",
        "铁砧": "workstations",
        
        "enchanting_table": "workstations",
        "附魔台": "workstations",
        "附魔桌": "workstations",
        
        "brewing_stand": "workstations",
        "酿造台": "workstations",
        "炼药台": "workstations",
        
        "smithing_table": "workstations",
        "锻造台": "workstations",
        
        "stonecutter": "workstations",
        "切石机": "workstations",
        
        "grindstone": "workstations",
        "砂轮": "workstations",
        
        "loom": "workstations",
        "织布机": "workstations",
        
        "cartography_table": "workstations",
        "制图台": "workstations",
        
        "lectern": "workstations",
        "讲台": "workstations",
        
        "beacon": "workstations",
        "信标": "workstations",
        
        "conduit": "workstations",
        "潮涌核心": "workstations",
        
        "crafter": "workstations",
        "合成器": "workstations",
        
        "jukeboxes": "jukeboxes",
        "唱片机": "jukeboxes",
        
        # =====================================================================
        # 红石类
        # =====================================================================
        "piston": "redstone_components",
        "活塞": "redstone_components",
        "粘性活塞": "redstone_components",
        
        "hopper": "redstone_components",
        "漏斗": "redstone_components",
        
        "dispenser": "redstone_components",
        "发射器": "redstone_components",
        
        "dropper": "redstone_components",
        "投掷器": "redstone_components",
        
        "repeater": "redstone_components",
        "中继器": "redstone_components",
        "红石中继器": "redstone_components",
        
        "comparator": "redstone_components",
        "比较器": "redstone_components",
        "红石比较器": "redstone_components",
        
        "lever": "redstone_components",
        "拉杆": "redstone_components",
        "开关": "redstone_components",
        
        "observer": "redstone_components",
        "侦测器": "redstone_components",
        "观察者": "redstone_components",
        
        "daylight_detector": "redstone_components",
        "阳光传感器": "redstone_components",
        "光感": "redstone_components",
        
        "target": "redstone_components",
        "靶子": "redstone_components",
        
        "sculk_sensor": "redstone_components",
        "幽匿感测体": "redstone_components",
        
        "redstone_lamp": "redstone_components",
        "红石灯": "redstone_components",
        
        "redstone_torch": "redstone_components",
        "红石火把": "redstone_components",
        
        "sculk": "sculk",
        "幽匿": "sculk",
        "幽匿块": "sculk",
        "幽匿催发体": "sculk",
        
        # =====================================================================
        # 染料类
        # =====================================================================
        "dye": "dyes",
        "染料": "dyes",
        "颜料": "dyes",
        "红色染料": "dyes",
        "蓝色染料": "dyes",
        "白色染料": "dyes",
        "黑色染料": "dyes",
        
        # =====================================================================
        # 药水类
        # =====================================================================
        "potion": "potions",
        "药水": "potions",
        "药": "potions",
        "喷溅药水": "potions",
        "滞留药水": "potions",
        
        # =====================================================================
        # 箭矢类
        # =====================================================================
        "arrow": "arrows",
        "箭": "arrows",
        "弓箭": "arrows",
        "光灵箭": "arrows",
        "药箭": "arrows",
        
        # =====================================================================
        # 书籍/地图类
        # =====================================================================
        "book": "books_maps",
        "书": "books_maps",
        "书本": "books_maps",
        "书架": "books_maps",
        
        "map": "books_maps",
        "地图": "books_maps",
        "空地图": "books_maps",
        
        "enchanted_books": "enchanted_books",
        "附魔书": "enchanted_books",
        
        "compass": "misc_items",
        "指南针": "misc_items",
        "罗盘": "misc_items",
        
        "clock": "misc_items",
        "钟": "misc_items",
        "时钟": "misc_items",
        
        # =====================================================================
        # 桶类
        # =====================================================================
        "bucket": "buckets",
        "桶": "buckets",
        "水桶": "buckets",
        "水": "buckets",
        "铁桶": "buckets",
        "岩浆桶": "buckets",
        "岩浆": "buckets",
        "熔岩桶": "buckets",
        "牛奶桶": "buckets",
        "牛奶": "buckets",
        "粉雪桶": "buckets",
        
        "fluids": "fluids",
        "流体": "fluids",
        "液体": "fluids",
        
        # =====================================================================
        # 生物掉落物
        # =====================================================================
        "bone": "mob_drops",
        "骨头": "mob_drops",
        "骨粉": "mob_drops",
        
        "leather": "mob_drops",
        "皮革": "mob_drops",
        
        "feather": "mob_drops",
        "羽毛": "mob_drops",
        
        "string": "mob_drops",
        "线": "mob_drops",
        "蜘蛛丝": "mob_drops",
        
        "gunpowder": "mob_drops",
        "火药": "mob_drops",
        
        "ender_pearl": "mob_drops",
        "末影珍珠": "mob_drops",
        "珍珠": "mob_drops",
        
        "ender_eye": "mob_drops",
        "末影之眼": "mob_drops",
        
        "blaze_rod": "mob_drops",
        "烈焰棒": "mob_drops",
        "烈焰粉": "mob_drops",
        
        "ghast_tear": "mob_drops",
        "恶魂之泪": "mob_drops",
        
        "slime_ball": "mob_drops",
        "粘液球": "mob_drops",
        "史莱姆球": "mob_drops",
        
        "spider_eye": "mob_drops",
        "蜘蛛眼": "mob_drops",
        
        "ink_sac": "mob_drops",
        "墨囊": "mob_drops",
        "发光墨囊": "mob_drops",
        
        "rotten_flesh": "mob_drops",
        "腐肉": "mob_drops",
        
        "phantom_membrane": "mob_drops",
        "幻翼膜": "mob_drops",
        
        "shulker_shell": "mob_drops",
        "潜影壳": "mob_drops",
        
        "nether_star": "mob_drops",
        "下界之星": "mob_drops",
        "地狱之星": "mob_drops",
        
        # =====================================================================
        # 方块类
        # =====================================================================
        "stone": "stone_variants",
        "石头": "stone_variants",
        "圆石": "stone_variants",
        "鹅卵石": "stone_variants",
        "cobblestone": "stone_variants",
        "苔石": "stone_variants",
        "石砖": "stone_variants",
        "平滑石头": "stone_variants",
        "深板岩": "stone_variants",
        "深层板岩": "stone_variants",
        "深板岩圆石": "stone_variants",
        "深板岩砖": "stone_variants",
        "安山岩": "andesite_variants",
        "闪长岩": "diorite_variants",
        "花岗岩": "granite_variants",
        "凝灰岩": "tuff_variants",
        "玄武岩": "basalt_variants",
        "黑石": "blackstone_variants",
        
        "dirt": "dirt_variants",
        "泥土": "dirt_variants",
        "土": "dirt_variants",
        "土块": "dirt_variants",
        "草方块": "dirt_variants",
        "草地": "dirt_variants",
        "灰化土": "dirt_variants",
        "菌丝": "dirt_variants",
        "泥巴": "dirt_variants",
        "耕地": "dirt_variants",
        
        "sand": "sand_gravel",
        "沙子": "sand_gravel",
        "沙": "sand_gravel",
        "红沙": "sand_gravel",
        "灵魂沙": "sand_gravel",
        
        "gravel": "sand_gravel",
        "沙砾": "sand_gravel",
        "碎石": "sand_gravel",
        
        "clay": "sand_gravel",
        "粘土": "sand_gravel",
        "黏土": "sand_gravel",
        
        "snow": "snow_ice",
        "雪": "snow_ice",
        "雪块": "snow_ice",
        "粉雪": "snow_ice",
        
        "ice": "snow_ice",
        "冰": "snow_ice",
        "冰块": "snow_ice",
        "浮冰": "snow_ice",
        "蓝冰": "snow_ice",
        
        "obsidian": "special_blocks",
        "黑曜石": "special_blocks",
        "哭泣的黑曜石": "special_blocks",
        
        "tnt": "special_blocks",
        "炸药": "special_blocks",
        "炸弹": "special_blocks",
        "TNT": "special_blocks",
        
        "bedrock": "special_blocks",
        "基岩": "special_blocks",
        
        "brick": "bricks",
        "砖": "bricks",
        "砖块": "bricks",
        "红砖": "bricks",
        
        "sandstone": "sandstone_variants",
        "砂岩": "sandstone_variants",
        "红砂岩": "sandstone_variants",
        
        "quartz_blocks": "quartz_blocks",
        "石英块": "quartz_blocks",
        "石英方块": "quartz_blocks",
        
        "purpur": "purpur",
        "紫珀": "purpur",
        "紫珀块": "purpur",
        
        "dripstone": "dripstone",
        "滴水石": "dripstone",
        "滴水石块": "dripstone",
        
        "corals": "corals",
        "珊瑚": "corals",
        "珊瑚块": "corals",
        "珊瑚扇": "corals",
        
        "ocean_blocks": "ocean_blocks",
        "海洋方块": "ocean_blocks",
        "海晶石": "ocean_blocks",
        "海绵": "ocean_blocks",
        
        "infested": "infested",
        "虫蛀方块": "infested",
        "被虫蛀的": "infested",
        
        "technical_blocks": "technical_blocks",
        "技术方块": "technical_blocks",
        "屏障": "technical_blocks",
        "命令方块": "technical_blocks",
        
        "air_blocks": "air_blocks",
        "空气": "air_blocks",
        "空气方块": "air_blocks",
        
        # =====================================================================
        # 下界/末地
        # =====================================================================
        "netherrack": "nether_blocks",
        "下界岩": "nether_blocks",
        "地狱岩": "nether_blocks",
        "下界砖": "nether_blocks",
        "地狱砖": "nether_blocks",
        "岩浆块": "nether_blocks",
        "灵魂土": "nether_blocks",
        "远古残骸": "nether_blocks",
        
        "end_stone": "end_blocks",
        "末地石": "end_blocks",
        "末影石": "end_blocks",
        "末地砖": "end_blocks",
        "紫颂果": "end_blocks",
        "紫颂花": "end_blocks",
        
        "dragon_egg": "end_blocks",
        "龙蛋": "end_blocks",
        
        "hyphae": "hyphae",
        "菌柄": "hyphae",
        
        "portals": "portals",
        "传送门": "portals",
        "下界传送门": "portals",
        
        "spawners": "spawners",
        "刷怪笼": "spawners",
        
        "trial_related": "trial_related",
        "试炼": "trial_related",
        "试炼刷怪笼": "trial_related",
        "宝库": "trial_related",
        "试炼钥匙": "trial_related",
        
        # =====================================================================
        # 特殊物品
        # =====================================================================
        "totem": "mob_drops",
        "不死图腾": "mob_drops",
        "图腾": "mob_drops",
        
        "spawn_egg": "spawn_eggs",
        "刷怪蛋": "spawn_eggs",
        "生成蛋": "spawn_eggs",
        
        "music_disc": "music_discs",
        "唱片": "music_discs",
        "音乐唱片": "music_discs",
        
        "disc_fragments": "disc_fragments",
        "唱片碎片": "disc_fragments",
        
        "firework": "projectiles",
        "烟花": "projectiles",
        "烟火": "projectiles",
        "焰火": "projectiles",
        "火箭": "projectiles",
        
        "egg": "projectiles",
        "鸡蛋": "projectiles",
        "蛋": "projectiles",
        
        "snowball": "projectiles",
        "雪球": "projectiles",
        
        "fire": "fire",
        "火": "fire",
        "火焰": "fire",
        
        # =====================================================================
        # 杂项
        # =====================================================================
        "stick": "misc_items",
        "木棍": "misc_items",
        "棍子": "misc_items",
        
        "paper": "misc_items",
        "纸": "misc_items",
        
        "name_tag": "misc_items",
        "命名牌": "misc_items",
        
        "lead": "misc_items",
        "栓绳": "misc_items",
        "绳子": "misc_items",
        
        "saddle": "misc_items",
        "鞍": "misc_items",
        "马鞍": "misc_items",
        
        "glass_bottle": "misc_items",
        "玻璃瓶": "misc_items",
        "瓶子": "misc_items",
        
        "experience_bottle": "misc_items",
        "经验瓶": "misc_items",
        "附魔之瓶": "misc_items",
        "附魔瓶": "misc_items",

        "valuables": "valuables",
        "贵重物品": "valuables",
        "贵重品": "valuables",
        "贵重": "valuables",
    }
    
    def __init__(
        self,
        data_source: IDataSource,
        generators: List[ITagGenerator],
    ):
        """
        初始化构建器
        
        Args:
            data_source: 数据源
            generators: 标签生成器列表 (按优先级排序)
        """
        self._data_source = data_source
        self._generators = generators
        self._logger = logging.getLogger(__name__)
    
    def build(self) -> BuildResult:
        """执行构建流程"""
        self._logger.info("开始构建知识库...")
        
        # 1. 提取所有物品和方块
        items = set(self._data_source.get_all_items())
        blocks = set(self._data_source.get_all_blocks())
        all_ids = sorted(items | blocks)
        self._logger.info(f"共提取 {len(all_ids)} 个 ID (物品: {len(items)}, 方块: {len(blocks)})")
        
        # 2. 依次应用生成器
        all_tags: Dict[str, List[str]] = {}
        remaining = all_ids
        
        for i, generator in enumerate(self._generators):
            gen_name = generator.__class__.__name__
            self._logger.info(f"[{i+1}/{len(self._generators)}] 运行 {gen_name}...")
            
            tags = generator.generate(remaining)
            classified_count = sum(len(v) for v in tags.values())
            
            # 合并结果
            for tag, tag_items in tags.items():
                if tag not in all_tags:
                    all_tags[tag] = []
                all_tags[tag].extend(tag_items)
            
            # 更新剩余列表
            remaining = generator.get_unclassified()
            self._logger.info(f"  → 分类: {classified_count}, 剩余: {len(remaining)}")
        
        # 3. 生成反向索引
        items_index = self._build_reverse_index(all_tags)
        
        # 4. 统计信息
        stats = {
            "total_ids": len(all_ids),
            "classified": len(all_ids) - len(remaining),
            "unclassified": len(remaining),
            "tag_count": len(all_tags),
            "unclassified_sample": remaining[:20] if remaining else [],
        }
        
        return BuildResult(
            tags=all_tags,
            aliases=self.DEFAULT_ALIASES,
            items=items_index,
            version=self._data_source.get_version(),
            stats=stats
        )
    
    def _build_reverse_index(self, tags: Dict[str, List[str]]) -> Dict[str, List[str]]:
        """构建 ID → Tags 反向索引"""
        result: Dict[str, Set[str]] = {}
        
        for tag, items in tags.items():
            for item in items:
                if item not in result:
                    result[item] = set()
                result[item].add(tag)
        
        return {k: sorted(v) for k, v in result.items()}


# ============================================================================
# 聚合标签 (高级语义)
# ============================================================================

def add_aggregate_tags(tags: Dict[str, List[str]]) -> Dict[str, List[str]]:
    """
    添加聚合标签 - 将细粒度标签合并为粗粒度标签
    
    例如: weapons = swords + bows + tridents
    """
    aggregates = {
        # 武器聚合
        "weapons": ["swords", "bows", "tridents"],
        
        # 工具聚合
        "tools": ["pickaxes", "axes", "shovels", "hoes"],
        
        # 护甲聚合
        "armor": ["helmets", "chestplates", "leggings", "boots"],
        
        # 木材聚合
        "wood_materials": ["logs", "stripped_logs", "wood", "planks"],
        
        # 矿石聚合 (包括深层)
        "all_ores": ["ores", "deepslate_ores"],
        
        # 建筑装饰聚合
        "building_decorations": ["stairs", "slabs", "walls", "fences", "doors", "trapdoors"],
        
        # 玻璃聚合
        "all_glass": ["glass", "glass_panes"],
        
        # 陶瓦聚合
        "all_terracotta": ["terracotta", "glazed_terracotta"],
        
        # 混凝土聚合
        "all_concrete": ["concrete", "concrete_powder"],
        
        # 船聚合
        "all_boats": ["boats", "chest_boats"],
        
        # 告示牌聚合
        "all_signs": ["signs", "hanging_signs"],
    }
    
    result = dict(tags)  # 复制原始 tags
    
    for agg_tag, source_tags in aggregates.items():
        agg_items = []
        for src in source_tags:
            if src in tags:
                agg_items.extend(tags[src])
        if agg_items:
            result[agg_tag] = sorted(set(agg_items))
    
    return result


# ============================================================================
# 输出生成
# ============================================================================

def save_knowledge_base(result: BuildResult, output_path: Path) -> None:
    """保存知识库 JSON"""
    # 添加聚合标签
    enriched_tags = add_aggregate_tags(result.tags)
    
    data = {
        "version": result.version,
        "generated_at": datetime.now().isoformat(),
        "stats": {
            "total_tags": len(enriched_tags),
            "total_items": len(result.items),
        },
        "tags": enriched_tags,
        "aliases": result.aliases,
        "items": result.items,
    }
    
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    
    logging.info(f"✅ 知识库已保存至: {output_path}")


def generate_audit_report(result: BuildResult, output_path: Path) -> None:
    """生成 Markdown 审核报告"""
    enriched_tags = add_aggregate_tags(result.tags)
    
    lines = [
        "# MC 知识库构建报告",
        "",
        f"> 生成时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
        f"> MC 版本: {result.version}",
        "",
        "## 统计摘要",
        "",
        "| 指标 | 数值 |",
        "|------|------|",
        f"| 总 ID 数 | {result.stats.get('total_ids', 0)} |",
        f"| 已分类 | {result.stats.get('classified', 0)} |",
        f"| 未分类 | {result.stats.get('unclassified', 0)} |",
        f"| Tag 数量 | {len(enriched_tags)} |",
        "",
    ]
    
    # 未分类样本
    unclassified_sample = result.stats.get('unclassified_sample', [])
    if unclassified_sample:
        lines.extend([
            "### 未分类物品样本",
            "",
            ", ".join(f"`{i}`" for i in unclassified_sample[:30]),
            "",
        ])
    
    lines.extend([
        "---",
        "",
        "## 各 Tag 详情",
        "",
    ])
    
    # 按物品数量排序
    sorted_tags = sorted(enriched_tags.items(), key=lambda x: -len(x[1]))
    
    for tag, items in sorted_tags:
        lines.append(f"### {tag} ({len(items)} 个)")
        lines.append("")
        # 显示前 30 个
        display_items = items[:30]
        lines.append(", ".join(f"`{i}`" for i in display_items))
        if len(items) > 30:
            lines.append(f"... 及其他 {len(items) - 30} 个")
        lines.append("")
    
    lines.extend([
        "---",
        "",
        "## 别名映射",
        "",
        "| 别名 | 目标 Tag |",
        "|------|----------|",
    ])
    for alias, target in sorted(result.aliases.items()):
        lines.append(f"| {alias} | {target} |")
    
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, 'w', encoding='utf-8') as f:
        f.write("\n".join(lines))
    
    logging.info(f"📋 审核报告已保存至: {output_path}")


# ============================================================================
# CLI 入口
# ============================================================================

def main():
    parser = argparse.ArgumentParser(description="构建 Minecraft 静态知识库")
    parser.add_argument("--version", default="1.20.6", help="Minecraft 版本 (默认: 1.20.6)")
    parser.add_argument("--output", default="backend/data/mc_knowledge_base.json", help="输出路径")
    parser.add_argument("--report", default="scripts/audit_report.md", help="审核报告路径")
    parser.add_argument("--use-llm", action="store_true", help="使用 LLM 补全分类")
    parser.add_argument("--llm-model", default="qwen-plus", help="LLM 模型 (默认: qwen-plus)")
    parser.add_argument("--dry-run", action="store_true", help="预览模式，不保存文件")
    parser.add_argument("--cache-dir", default=".cache/llm", help="LLM 缓存目录")
    parser.add_argument("-v", "--verbose", action="store_true", help="详细输出")
    
    args = parser.parse_args()
    
    # 配置日志
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%H:%M:%S"
    )
    
    # 构建组件
    try:
        data_source = MinecraftDataSource(args.version)
    except FileNotFoundError as e:
        logging.error(f"❌ {e}")
        logging.info("请先在 backend/ 目录下运行: npm install minecraft-data")
        return 1
    
    # 构建生成器链
    generators: List[ITagGenerator] = []
    
    # 1. 正则生成器 (主力，覆盖 100% 物品)
    generators.append(RegexTagGenerator())
    
    # 2. LLM 生成器 (可选，处理剩余物品)
    if args.use_llm:
        try:
            base_path = Path(__file__).parent.parent
            cache = FileCache(base_path / args.cache_dir)
            llm_client = QwenLLMClient(model=args.llm_model)
            generators.append(LLMTagGenerator(llm_client, cache))
            logging.info(f"已启用 LLM 分类 (模型: {args.llm_model})")
        except Exception as e:
            logging.warning(f"无法初始化 LLM: {e}")
    
    # 执行构建
    builder = KnowledgeBaseBuilder(data_source, generators)
    result = builder.build()
    
    # 输出
    base_path = Path(__file__).parent.parent
    
    if args.dry_run:
        logging.info("=== DRY RUN 模式 ===")
        enriched_tags = add_aggregate_tags(result.tags)
        print(json.dumps({
            "stats": result.stats,
            "tags": {k: len(v) for k, v in sorted(enriched_tags.items(), key=lambda x: -len(x[1]))},
            "aliases_count": len(result.aliases),
        }, indent=2, ensure_ascii=False))
    else:
        save_knowledge_base(result, base_path / args.output)
        generate_audit_report(result, base_path / args.report)
    
    logging.info(f"🎉 构建完成! 共 {len(add_aggregate_tags(result.tags))} 个 Tag, "
                 f"覆盖 {result.stats['classified']}/{result.stats['total_ids']} 个 ID")
    return 0


if __name__ == "__main__":
    exit(main())