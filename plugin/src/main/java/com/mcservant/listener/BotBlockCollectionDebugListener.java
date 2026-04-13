package com.mcservant.listener;

import com.mcservant.MCServant;
import com.mcservant.registry.IBotRegistry;
import org.bukkit.Location;
import org.bukkit.Material;
import org.bukkit.entity.Entity;
import org.bukkit.entity.Item;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.block.Action;
import org.bukkit.event.block.BlockBreakEvent;
import org.bukkit.event.block.BlockDropItemEvent;
import org.bukkit.event.block.BlockDamageEvent;
import org.bukkit.event.block.BlockDamageAbortEvent;
import org.bukkit.event.entity.EntityPickupItemEvent;
import org.bukkit.event.entity.ItemSpawnEvent;
import org.bukkit.event.player.PlayerAnimationEvent;
import org.bukkit.event.player.PlayerInteractEvent;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.inventory.ItemStack;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.logging.Logger;

/**
 * Bot 采集链路服务端诊断监听器。
 *
 * <p>目标：在不改动其他插件逻辑的前提下，把 bot 相关的“破坏 -> 掉落实体 -> 拾取”链路完整打到服务端日志里。</p>
 */
public class BotBlockCollectionDebugListener implements Listener {

    private static final Logger logger = MCServant.log();
    private static final long RECENT_BREAK_WINDOW_MS = 10_000L;
    private static final double CORRELATION_RADIUS = 6.0D;

    private final Map<String, RecentBreakContext> recentBreaks = new ConcurrentHashMap<>();

    @EventHandler(priority = EventPriority.MONITOR)
    public void onPlayerJoin(PlayerJoinEvent event) {
        Player player = event.getPlayer();
        if (!isTrackedBot(player)) {
            return;
        }
        logger.info(String.format(
            Locale.ROOT,
            "[BotDebug] TrackingEnabled bot=%s loc=%s gamemode=%s",
            player.getName(),
            formatLocation(player.getLocation()),
            player.getGameMode()
        ));
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onPlayerAnimation(PlayerAnimationEvent event) {
        Player player = event.getPlayer();
        if (!isTrackedBot(player)) {
            return;
        }
        logger.info(String.format(
            Locale.ROOT,
            "[BotDebug] PlayerAnimation bot=%s type=%s loc=%s itemInHand=%s",
            player.getName(),
            event.getAnimationType(),
            formatLocation(player.getLocation()),
            safeItemName(player.getInventory().getItemInMainHand())
        ));
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onPlayerInteract(PlayerInteractEvent event) {
        Player player = event.getPlayer();
        if (!isTrackedBot(player)) {
            return;
        }
        if (event.getAction() != Action.LEFT_CLICK_BLOCK && event.getAction() != Action.LEFT_CLICK_AIR) {
            return;
        }
        logger.info(String.format(
            Locale.ROOT,
            "[BotDebug] PlayerInteract bot=%s action=%s clickedBlock=%s clickedPos=%s cancelled=%s itemInHand=%s",
            player.getName(),
            event.getAction(),
            event.getClickedBlock() == null ? "<none>" : event.getClickedBlock().getType(),
            event.getClickedBlock() == null ? "<none>" : formatLocation(event.getClickedBlock().getLocation()),
            event.useInteractedBlock(),
            safeItemName(player.getInventory().getItemInMainHand())
        ));
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onBlockDamage(BlockDamageEvent event) {
        Player player = event.getPlayer();
        if (!isTrackedBot(player)) {
            return;
        }
        logger.info(String.format(
            Locale.ROOT,
            "[BotDebug] BlockDamage bot=%s block=%s loc=%s instaBreak=%s cancelled=%s itemInHand=%s",
            player.getName(),
            event.getBlock().getType(),
            formatLocation(event.getBlock().getLocation()),
            event.getInstaBreak(),
            event.isCancelled(),
            safeItemName(player.getInventory().getItemInMainHand())
        ));
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onBlockDamageAbort(BlockDamageAbortEvent event) {
        Player player = event.getPlayer();
        if (!isTrackedBot(player)) {
            return;
        }
        logger.info(String.format(
            Locale.ROOT,
            "[BotDebug] BlockDamageAbort bot=%s block=%s loc=%s itemInHand=%s",
            player.getName(),
            event.getBlock().getType(),
            formatLocation(event.getBlock().getLocation()),
            safeItemName(player.getInventory().getItemInMainHand())
        ));
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onBlockBreak(BlockBreakEvent event) {
        Player player = event.getPlayer();
        if (!isTrackedBot(player)) {
            return;
        }
        Location blockLocation = event.getBlock().getLocation();
        RecentBreakContext context = new RecentBreakContext(
            player.getName(),
            blockLocation.clone(),
            event.getBlock().getType(),
            System.currentTimeMillis()
        );
        recentBreaks.put(player.getName(), context);
        logger.info(String.format(
            Locale.ROOT,
            "[BotDebug] BlockBreak bot=%s block=%s loc=%s cancelled=%s dropItems=%s expToDrop=%d itemInHand=%s",
            player.getName(),
            event.getBlock().getType(),
            formatLocation(blockLocation),
            event.isCancelled(),
            event.isDropItems(),
            event.getExpToDrop(),
            safeItemName(player.getInventory().getItemInMainHand())
        ));
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onBlockDropItem(BlockDropItemEvent event) {
        Player player = event.getPlayer();
        if (!isTrackedBot(player)) {
            return;
        }
        List<String> itemSummaries = new ArrayList<>();
        for (Item itemEntity : event.getItems()) {
            ItemStack stack = itemEntity.getItemStack();
            itemSummaries.add(stack.getType() + "x" + stack.getAmount() + "@" + formatLocation(itemEntity.getLocation()));
        }
        logger.info(String.format(
            Locale.ROOT,
            "[BotDebug] BlockDropItem bot=%s block=%s loc=%s dropped=%s",
            player.getName(),
            event.getBlockState().getType(),
            formatLocation(event.getBlock().getLocation()),
            itemSummaries
        ));
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onItemSpawn(ItemSpawnEvent event) {
        Item item = event.getEntity();
        RecentBreakContext context = findNearbyRecentBreak(item.getLocation());
        if (context == null) {
            return;
        }
        logger.info(String.format(
            Locale.ROOT,
            "[BotDebug] ItemSpawn nearBreak bot=%s breakBlock=%s breakLoc=%s item=%s spawnLoc=%s ageMs=%d",
            context.botName(),
            context.blockType(),
            formatLocation(context.location()),
            item.getItemStack().getType() + "x" + item.getItemStack().getAmount(),
            formatLocation(item.getLocation()),
            System.currentTimeMillis() - context.timestampMs()
        ));
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onEntityPickupItem(EntityPickupItemEvent event) {
        Entity entity = event.getEntity();
        if (!(entity instanceof Player player) || !isTrackedBot(player)) {
            return;
        }
        Item item = event.getItem();
        RecentBreakContext context = recentBreaks.get(player.getName());
        logger.info(String.format(
            Locale.ROOT,
            "[BotDebug] EntityPickupItem bot=%s item=%s pickupLoc=%s cancelled=%s relatedBreak=%s",
            player.getName(),
            item.getItemStack().getType() + "x" + item.getItemStack().getAmount(),
            formatLocation(item.getLocation()),
            event.isCancelled(),
            context == null ? "<none>" : context.blockType() + "@" + formatLocation(context.location())
        ));
    }

    private boolean isTrackedBot(Player player) {
        String playerName = player.getName();
        MCServant plugin = MCServant.getInstance();
        if (plugin == null) {
            return false;
        }
        IBotRegistry registry = plugin.getBotRegistry();
        if (registry != null && registry.isBot(playerName)) {
            return true;
        }
        String defaultName = plugin.getConfig().getString("bot.default_name", "");
        return !defaultName.isBlank() && defaultName.equalsIgnoreCase(playerName);
    }

    private RecentBreakContext findNearbyRecentBreak(Location location) {
        long now = System.currentTimeMillis();
        for (RecentBreakContext context : recentBreaks.values()) {
            if (now - context.timestampMs() > RECENT_BREAK_WINDOW_MS) {
                continue;
            }
            if (!sameWorld(context.location(), location)) {
                continue;
            }
            if (context.location().distance(location) <= CORRELATION_RADIUS) {
                return context;
            }
        }
        return null;
    }

    private boolean sameWorld(Location a, Location b) {
        if (a == null || b == null) {
            return false;
        }
        if (a.getWorld() == null || b.getWorld() == null) {
            return false;
        }
        return a.getWorld().getUID().equals(b.getWorld().getUID());
    }

    private String safeItemName(ItemStack stack) {
        if (stack == null || stack.getType() == Material.AIR) {
            return "air";
        }
        return stack.getType() + "x" + stack.getAmount();
    }

    private String formatLocation(Location location) {
        if (location == null || location.getWorld() == null) {
            return "<null>";
        }
        return String.format(
            Locale.ROOT,
            "%s:(%.2f, %.2f, %.2f)",
            location.getWorld().getName(),
            location.getX(),
            location.getY(),
            location.getZ()
        );
    }

    private record RecentBreakContext(
        String botName,
        Location location,
        Material blockType,
        long timestampMs
    ) {
    }
}
