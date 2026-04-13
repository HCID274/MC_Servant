package com.mcservant.listener;

import com.mcservant.MCServant;
import org.bukkit.Bukkit;
import org.bukkit.GameMode;
import org.bukkit.Location;
import org.bukkit.Material;
import org.bukkit.Tag;
import org.bukkit.World;
import org.bukkit.block.Block;
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
import java.util.UUID;
import java.util.logging.Logger;

/**
 * 树木连锁砍伐监听器。
 *
 * <p>实现策略：
 * <ul>
 *   <li>只在玩家成功破坏原木后触发</li>
 *   <li>先做一次小范围叶子判定，避免误伤建筑</li>
 *   <li>从种子原木出发做单次 BFS，只遍历连通原木</li>
 *   <li>超过 max_logs 直接放弃，避免大型结构拖垮主线程</li>
 *   <li>下一 tick 处理剩余原木并聚合掉落，减少掉落实体数量</li>
 * </ul>
 * </p>
 */
public class TreeFellListener implements Listener {

    private static final Logger logger = MCServant.log();
    private static final int DEFAULT_MAX_LOGS = 64;

    // 同层 8 邻居 + 上层 8 邻居 + 正下方 1 邻居
    private static final int[][] LOG_NEIGHBOR_OFFSETS = new int[][]{
        {-1, 0, -1}, {-1, 0, 0}, {-1, 0, 1},
        {0, 0, -1},               {0, 0, 1},
        {1, 0, -1},  {1, 0, 0},  {1, 0, 1},
        {-1, 1, -1}, {-1, 1, 0}, {-1, 1, 1},
        {0, 1, -1},  {0, 1, 0},  {0, 1, 1},
        {1, 1, -1},  {1, 1, 0},  {1, 1, 1},
        {0, -1, 0}
    };

    private static final int[][] LEAF_CHECK_OFFSETS = createLeafCheckOffsets();

    @EventHandler(priority = EventPriority.HIGHEST, ignoreCancelled = true)
    public void onBlockBreak(BlockBreakEvent event) {
        MCServant plugin = MCServant.getInstance();
        if (plugin == null || !plugin.getConfig().getBoolean("tree_fell.enabled", true)) {
            return;
        }

        Block seedBlock = event.getBlock();
        if (!isLog(seedBlock.getType())) {
            return;
        }

        if (plugin.getConfig().getBoolean("tree_fell.leaf_required", true) && !hasNearbyLeaves(seedBlock)) {
            debug(plugin, "skip seed=%s reason=no_leaves", formatBlock(seedBlock));
            return;
        }

        SearchResult searchResult = collectConnectedLogs(seedBlock, resolveMaxLogs(plugin));
        if (searchResult.overflow()) {
            debug(plugin, "skip seed=%s reason=max_logs_exceeded visited=%d", formatBlock(seedBlock), searchResult.logs().size());
            return;
        }
        if (searchResult.logs().size() <= 1) {
            return;
        }

        Player player = event.getPlayer();
        ItemStack toolSnapshot = cloneItem(player.getInventory().getItemInMainHand());
        UUID playerId = player.getUniqueId();
        UUID worldId = seedBlock.getWorld().getUID();
        BlockPos seedPos = BlockPos.fromBlock(seedBlock);
        List<BlockPos> extraLogs = new ArrayList<>(searchResult.logs().size() - 1);
        for (BlockPos pos : searchResult.logs()) {
            if (!pos.equals(seedPos)) {
                extraLogs.add(pos);
            }
        }
        if (extraLogs.isEmpty()) {
            return;
        }

        Location dropLocation = seedBlock.getLocation().add(0.5D, 0.5D, 0.5D);
        Bukkit.getScheduler().runTask(plugin, () -> fellRemainingLogs(plugin, playerId, worldId, extraLogs, dropLocation, toolSnapshot));
        debug(plugin, "queued seed=%s extraLogs=%d", formatBlock(seedBlock), extraLogs.size());
    }

    private void fellRemainingLogs(
        MCServant plugin,
        UUID playerId,
        UUID worldId,
        List<BlockPos> logPositions,
        Location dropLocation,
        ItemStack toolSnapshot
    ) {
        Player player = Bukkit.getPlayer(playerId);
        World world = Bukkit.getWorld(worldId);
        if (player == null || !player.isOnline() || world == null) {
            debug(plugin, "abort scheduled fell reason=player_or_world_missing player=%s", playerId);
            return;
        }

        Map<Material, Integer> aggregatedDrops = new EnumMap<>(Material.class);
        int brokenCount = 0;
        for (BlockPos pos : logPositions) {
            Block block = world.getBlockAt(pos.x(), pos.y(), pos.z());
            if (!isLog(block.getType())) {
                continue;
            }
            if (player.getGameMode() != GameMode.CREATIVE) {
                aggregateDrops(aggregatedDrops, block.getDrops(toolSnapshot, player));
            }
            block.setType(Material.AIR, false);
            brokenCount++;
        }

        int droppedStacks = dropAggregatedItems(dropLocation, aggregatedDrops);
        debug(
            plugin,
            "completed player=%s broken=%d droppedStacks=%d dropSummary=%s",
            player.getName(),
            brokenCount,
            droppedStacks,
            aggregatedDrops
        );
    }

    private SearchResult collectConnectedLogs(Block seedBlock, int maxLogs) {
        ArrayDeque<BlockPos> queue = new ArrayDeque<>();
        Set<Long> visited = new HashSet<>();
        List<BlockPos> collected = new ArrayList<>();

        BlockPos seedPos = BlockPos.fromBlock(seedBlock);
        queue.add(seedPos);
        visited.add(seedPos.packed());

        while (!queue.isEmpty()) {
            BlockPos currentPos = queue.removeFirst();
            Block currentBlock = seedBlock.getWorld().getBlockAt(currentPos.x(), currentPos.y(), currentPos.z());
            if (!isLog(currentBlock.getType())) {
                continue;
            }
            collected.add(currentPos);
            if (collected.size() > maxLogs) {
                return new SearchResult(List.of(), true);
            }

            for (int[] offset : LOG_NEIGHBOR_OFFSETS) {
                Block neighbor = currentBlock.getRelative(offset[0], offset[1], offset[2]);
                if (!isLog(neighbor.getType())) {
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

    private boolean hasNearbyLeaves(Block seedBlock) {
        World world = seedBlock.getWorld();
        int baseX = seedBlock.getX();
        int baseY = seedBlock.getY();
        int baseZ = seedBlock.getZ();

        for (int[] offset : LEAF_CHECK_OFFSETS) {
            Material material = world.getBlockAt(baseX + offset[0], baseY + offset[1], baseZ + offset[2]).getType();
            if (Tag.LEAVES.isTagged(material)) {
                return true;
            }
        }
        return false;
    }

    private int resolveMaxLogs(MCServant plugin) {
        int configured = plugin.getConfig().getInt("tree_fell.max_logs", DEFAULT_MAX_LOGS);
        return Math.max(1, configured);
    }

    private boolean isLog(Material material) {
        return Tag.LOGS.isTagged(material);
    }

    private ItemStack cloneItem(ItemStack itemStack) {
        return itemStack == null ? new ItemStack(Material.AIR) : itemStack.clone();
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

    private void debug(MCServant plugin, String template, Object... args) {
        if (!plugin.getConfig().getBoolean("tree_fell.debug", false)) {
            return;
        }
        logger.info("[TreeFell] " + String.format(Locale.ROOT, template, args));
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

    private static int[][] createLeafCheckOffsets() {
        List<int[]> offsets = new ArrayList<>();
        for (int dx = -2; dx <= 2; dx++) {
            for (int dz = -2; dz <= 2; dz++) {
                for (int dy = 0; dy <= 6; dy++) {
                    offsets.add(new int[]{dx, dy, dz});
                }
            }
        }
        return offsets.toArray(new int[0][]);
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

    private record SearchResult(List<BlockPos> logs, boolean overflow) {
    }
}
