package com.mcservant.listener;

import com.mcservant.MCServant;
import org.bukkit.Bukkit;
import org.bukkit.GameMode;
import org.bukkit.Location;
import org.bukkit.Material;
import org.bukkit.World;
import org.bukkit.block.Block;
import org.bukkit.enchantments.Enchantment;
import org.bukkit.entity.ExperienceOrb;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.block.BlockBreakEvent;
import org.bukkit.inventory.ItemStack;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collection;
import java.util.EnumMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ThreadLocalRandom;
import java.util.UUID;
import java.util.logging.Logger;

/**
 * 矿脉连锁开采监听器。
 *
 * <p>实现原则：
 * <ul>
 *   <li>只在首块矿石本来就能被当前工具合法产出掉落时触发</li>
 *   <li>只连锁同矿种 family，避免误扫附近其他矿石</li>
 *   <li>剩余矿石的掉落一律复用 Bukkit 原生 getDrops(tool, player)</li>
 *   <li>超过 max_ores 直接放弃，避免大型矿脉拖垮主线程</li>
 * </ul>
 * </p>
 */
public class OreVeinListener implements Listener {

    private static final Logger logger = MCServant.log();
    private static final int DEFAULT_MAX_ORES = 24;

    // 6 邻接，避免过度串联到附近独立矿脉
    private static final int[][] ORE_NEIGHBOR_OFFSETS = new int[][]{
        {-1, 0, 0}, {1, 0, 0},
        {0, -1, 0}, {0, 1, 0},
        {0, 0, -1}, {0, 0, 1}
    };

    @EventHandler(priority = EventPriority.HIGHEST, ignoreCancelled = true)
    public void onBlockBreak(BlockBreakEvent event) {
        MCServant plugin = MCServant.getInstance();
        if (plugin == null || !plugin.getConfig().getBoolean("ore_vein.enabled", true)) {
            return;
        }

        Player player = event.getPlayer();
        if (player.getGameMode() == GameMode.CREATIVE) {
            return;
        }

        Block seedBlock = event.getBlock();
        String family = normalizeOreFamily(seedBlock.getType());
        if (family == null) {
            return;
        }

        ItemStack toolSnapshot = cloneItem(player.getInventory().getItemInMainHand());
        if (!hasEffectiveDrops(seedBlock, toolSnapshot, player)) {
            debug(plugin, "skip seed=%s reason=no_effective_drops tool=%s", formatBlock(seedBlock), safeItemName(toolSnapshot));
            return;
        }

        SearchResult searchResult = collectConnectedOres(seedBlock, family, resolveMaxOres(plugin));
        if (searchResult.overflow()) {
            debug(plugin, "skip seed=%s reason=max_ores_exceeded visited=%d", formatBlock(seedBlock), searchResult.ores().size());
            return;
        }
        if (searchResult.ores().size() <= 1) {
            return;
        }

        UUID playerId = player.getUniqueId();
        UUID worldId = seedBlock.getWorld().getUID();
        BlockPos seedPos = BlockPos.fromBlock(seedBlock);
        List<BlockPos> extraOres = new ArrayList<>(searchResult.ores().size() - 1);
        for (BlockPos pos : searchResult.ores()) {
            if (!pos.equals(seedPos)) {
                extraOres.add(pos);
            }
        }
        if (extraOres.isEmpty()) {
            return;
        }

        Location dropLocation = seedBlock.getLocation().add(0.5D, 0.5D, 0.5D);
        Bukkit.getScheduler().runTask(
            plugin,
            () -> breakRemainingOres(plugin, playerId, worldId, family, extraOres, dropLocation, toolSnapshot)
        );
        debug(plugin, "queued seed=%s family=%s extraOres=%d", formatBlock(seedBlock), family, extraOres.size());
    }

    private void breakRemainingOres(
        MCServant plugin,
        UUID playerId,
        UUID worldId,
        String family,
        List<BlockPos> orePositions,
        Location dropLocation,
        ItemStack toolSnapshot
    ) {
        Player player = Bukkit.getPlayer(playerId);
        World world = Bukkit.getWorld(worldId);
        if (player == null || !player.isOnline() || world == null) {
            debug(plugin, "abort scheduled vein reason=player_or_world_missing player=%s", playerId);
            return;
        }

        Map<Material, Integer> aggregatedDrops = new EnumMap<>(Material.class);
        int brokenCount = 0;
        int totalExp = 0;
        for (BlockPos pos : orePositions) {
            Block block = world.getBlockAt(pos.x(), pos.y(), pos.z());
            if (!sameOreFamily(block.getType(), family)) {
                continue;
            }
            if (!hasEffectiveDrops(block, toolSnapshot, player)) {
                debug(plugin, "skip extra=%s reason=no_effective_drops tool=%s", formatBlock(block), safeItemName(toolSnapshot));
                continue;
            }
            aggregateDrops(aggregatedDrops, block.getDrops(toolSnapshot, player));
            totalExp += resolveExpDrop(block.getType(), toolSnapshot);
            block.setType(Material.AIR, false);
            brokenCount++;
        }

        int droppedStacks = dropAggregatedItems(dropLocation, aggregatedDrops);
        int spawnedExp = dropExperience(dropLocation, totalExp);
        debug(
            plugin,
            "completed player=%s family=%s broken=%d droppedStacks=%d totalExp=%d spawnedExp=%d dropSummary=%s",
            player.getName(),
            family,
            brokenCount,
            droppedStacks,
            totalExp,
            spawnedExp,
            aggregatedDrops
        );
    }

    private SearchResult collectConnectedOres(Block seedBlock, String family, int maxOres) {
        ArrayDeque<BlockPos> queue = new ArrayDeque<>();
        Set<Long> visited = new HashSet<>();
        List<BlockPos> collected = new ArrayList<>();

        BlockPos seedPos = BlockPos.fromBlock(seedBlock);
        queue.add(seedPos);
        visited.add(seedPos.packed());

        while (!queue.isEmpty()) {
            BlockPos currentPos = queue.removeFirst();
            Block currentBlock = seedBlock.getWorld().getBlockAt(currentPos.x(), currentPos.y(), currentPos.z());
            if (!sameOreFamily(currentBlock.getType(), family)) {
                continue;
            }
            collected.add(currentPos);
            if (collected.size() > maxOres) {
                return new SearchResult(List.of(), true);
            }

            for (int[] offset : ORE_NEIGHBOR_OFFSETS) {
                Block neighbor = currentBlock.getRelative(offset[0], offset[1], offset[2]);
                if (!sameOreFamily(neighbor.getType(), family)) {
                    continue;
                }
                BlockPos neighborPos = BlockPos.fromBlock(neighbor);
                if (visited.add(neighborPos.packed())) {
                    queue.addLast(neighborPos);
                }
            }
        }

        return new SearchResult(collected, false);
    }

    private int resolveMaxOres(MCServant plugin) {
        int configured = plugin.getConfig().getInt("ore_vein.max_ores", DEFAULT_MAX_ORES);
        return Math.max(1, configured);
    }

    private boolean hasEffectiveDrops(Block block, ItemStack toolSnapshot, Player player) {
        for (ItemStack drop : block.getDrops(toolSnapshot, player)) {
            if (drop == null || drop.getType() == Material.AIR || drop.getAmount() <= 0) {
                continue;
            }
            return true;
        }
        return false;
    }

    private String normalizeOreFamily(Material material) {
        if (material == null || material == Material.AIR) {
            return null;
        }
        String name = material.name();
        if (name.startsWith("DEEPSLATE_") && name.endsWith("_ORE")) {
            return name.substring("DEEPSLATE_".length());
        }
        if (name.endsWith("_ORE")) {
            return name;
        }
        return null;
    }

    private boolean sameOreFamily(Material material, String expectedFamily) {
        return expectedFamily != null && expectedFamily.equals(normalizeOreFamily(material));
    }

    private ItemStack cloneItem(ItemStack itemStack) {
        return itemStack == null ? new ItemStack(Material.AIR) : itemStack.clone();
    }

    private String safeItemName(ItemStack stack) {
        if (stack == null || stack.getType() == Material.AIR) {
            return "air";
        }
        return stack.getType() + "x" + stack.getAmount();
    }

    private void aggregateDrops(Map<Material, Integer> aggregated, Collection<ItemStack> drops) {
        for (ItemStack drop : drops) {
            if (drop == null || drop.getType() == Material.AIR || drop.getAmount() <= 0) {
                continue;
            }
            aggregated.merge(drop.getType(), drop.getAmount(), Integer::sum);
        }
    }

    private int dropAggregatedItems(Location dropLocation, Map<Material, Integer> aggregatedDrops) {
        if (dropLocation.getWorld() == null) {
            return 0;
        }
        int spawnedStacks = 0;
        for (Map.Entry<Material, Integer> entry : aggregatedDrops.entrySet()) {
            Material material = entry.getKey();
            int remaining = entry.getValue();
            int maxStackSize = material.getMaxStackSize();
            while (remaining > 0) {
                int stackAmount = Math.min(remaining, maxStackSize);
                dropLocation.getWorld().dropItemNaturally(dropLocation, new ItemStack(material, stackAmount));
                remaining -= stackAmount;
                spawnedStacks++;
            }
        }
        return spawnedStacks;
    }

    private int dropExperience(Location dropLocation, int totalExp) {
        if (totalExp <= 0 || dropLocation.getWorld() == null) {
            return 0;
        }
        dropLocation.getWorld().spawn(dropLocation, ExperienceOrb.class, orb -> orb.setExperience(totalExp));
        return totalExp;
    }

    private int resolveExpDrop(Material material, ItemStack toolSnapshot) {
        if (material == null || hasSilkTouch(toolSnapshot)) {
            return 0;
        }
        return switch (material) {
            case COAL_ORE, DEEPSLATE_COAL_ORE -> randomInclusive(0, 2);
            case NETHER_GOLD_ORE -> randomInclusive(0, 1);
            case REDSTONE_ORE, DEEPSLATE_REDSTONE_ORE -> randomInclusive(1, 5);
            case LAPIS_ORE, DEEPSLATE_LAPIS_ORE, NETHER_QUARTZ_ORE -> randomInclusive(2, 5);
            case DIAMOND_ORE, DEEPSLATE_DIAMOND_ORE, EMERALD_ORE, DEEPSLATE_EMERALD_ORE -> randomInclusive(3, 7);
            default -> 0;
        };
    }

    private boolean hasSilkTouch(ItemStack toolSnapshot) {
        return toolSnapshot != null && toolSnapshot.getEnchantmentLevel(Enchantment.SILK_TOUCH) > 0;
    }

    private int randomInclusive(int min, int max) {
        return ThreadLocalRandom.current().nextInt(min, max + 1);
    }

    private void debug(MCServant plugin, String template, Object... args) {
        if (!plugin.getConfig().getBoolean("ore_vein.debug", false)) {
            return;
        }
        logger.info("[OreVein] " + String.format(Locale.ROOT, template, args));
    }

    private String formatBlock(Block block) {
        Location location = block.getLocation();
        return String.format(
            Locale.ROOT,
            "%s@%s:(%d,%d,%d)",
            block.getType(),
            location.getWorld() == null ? "<null>" : location.getWorld().getName(),
            block.getX(),
            block.getY(),
            block.getZ()
        );
    }

    private record BlockPos(int x, int y, int z) {
        static BlockPos fromBlock(Block block) {
            return new BlockPos(block.getX(), block.getY(), block.getZ());
        }

        long packed() {
            return ((long) (x & 0x3FFFFFF) << 38)
                | ((long) (z & 0x3FFFFFF) << 12)
                | (y & 0xFFF);
        }
    }

    private record SearchResult(List<BlockPos> ores, boolean overflow) {
    }
}
