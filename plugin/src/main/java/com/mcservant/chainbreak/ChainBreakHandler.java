package com.mcservant.chainbreak;

import java.util.ArrayDeque;
import java.util.HashSet;
import java.util.Objects;
import java.util.Set;
import net.fabricmc.fabric.api.event.player.PlayerBlockBreakEvents;
import net.minecraft.block.Block;
import net.minecraft.block.BlockState;
import net.minecraft.entity.player.PlayerEntity;
import net.minecraft.registry.Registries;
import net.minecraft.registry.RegistryKeys;
import net.minecraft.registry.tag.BlockTags;
import net.minecraft.registry.tag.TagKey;
import net.minecraft.server.network.ServerPlayerEntity;
import net.minecraft.server.world.ServerWorld;
import net.minecraft.util.Identifier;
import net.minecraft.util.math.BlockPos;
import net.minecraft.world.World;
import org.slf4j.Logger;

/**
 * 服务端资源连锁破坏入口：把玩家的一次真实挖掘扩展为同类相连方块破坏。
 */
public final class ChainBreakHandler {

    private static final ThreadLocal<Boolean> IN_CHAIN_BREAK = ThreadLocal.withInitial(() -> false);
    private static final String CONFIG_MAX_BLOCKS_PROPERTY = "mcservant.chainBreak.maxBlocks";
    private static final String CONFIG_MAX_BLOCKS_ENV = "MCSERVANT_CHAIN_BREAK_MAX_BLOCKS";
    private static final int DEFAULT_MAX_BLOCKS = 96;
    private static final int NEIGHBOR_RADIUS = 1;
    private static final Set<TagKey<Block>> ORE_TAGS = Set.of(
            blockTag("c", "ores"),
            blockTag("minecraft", "coal_ores"),
            blockTag("minecraft", "copper_ores"),
            blockTag("minecraft", "diamond_ores"),
            blockTag("minecraft", "emerald_ores"),
            blockTag("minecraft", "gold_ores"),
            blockTag("minecraft", "iron_ores"),
            blockTag("minecraft", "lapis_ores"),
            blockTag("minecraft", "redstone_ores")
    );

    private final Logger logger;
    private final int maxBlocks;

    public ChainBreakHandler(Logger logger) {
        this.logger = Objects.requireNonNull(logger, "logger 不可为空");
        this.maxBlocks = readMaxBlocks();
    }

    public void register() {
        PlayerBlockBreakEvents.AFTER.register(this::afterBlockBreak);
        logger.info("[MCServant] 连锁破坏已注册 — players=all, maxBlocks={}", maxBlocks);
    }

    private void afterBlockBreak(World world, PlayerEntity player, BlockPos pos, BlockState state, Object blockEntity) {
        if (!(world instanceof ServerWorld serverWorld)) {
            return;
        }
        if (!(player instanceof ServerPlayerEntity serverPlayer) || IN_CHAIN_BREAK.get()) {
            return;
        }

        ResourceKind resourceKind = classifyResource(state);
        if (resourceKind == ResourceKind.NONE) {
            return;
        }

        ChainBreakResult result = breakConnected(serverWorld, serverPlayer, pos, state, resourceKind);
        if (result.destroyedCount > 0) {
            logger.info(
                    "[MCServant] chain_break kind={} world={} player={} origin={} block={} destroyed={} scanned={} truncated={} failures={}",
                    resourceKind.logName,
                    worldKey(serverWorld),
                    serverPlayer.getGameProfile().getName(),
                    formatPos(pos),
                    blockId(state),
                    result.destroyedCount,
                    result.scannedCount,
                    result.truncated,
                    result.failureReasons
            );
        } else if (!result.failureReasons.isEmpty()) {
            logger.info(
                    "[MCServant] chain_break skipped kind={} world={} player={} origin={} block={} reason={}",
                    resourceKind.logName,
                    worldKey(serverWorld),
                    serverPlayer.getGameProfile().getName(),
                    formatPos(pos),
                    blockId(state),
                    result.failureReasons
            );
        }
    }

    private ChainBreakResult breakConnected(
            ServerWorld world,
            ServerPlayerEntity player,
            BlockPos origin,
            BlockState originState,
            ResourceKind resourceKind
    ) {
        ArrayDeque<BlockPos> queue = new ArrayDeque<>();
        Set<BlockPos> visited = new HashSet<>();
        Set<String> failureReasons = new HashSet<>();
        Block originBlock = originState.getBlock();
        int scannedCount = 0;
        int destroyedCount = 0;
        boolean truncated = false;

        enqueueNeighbors(queue, visited, origin);
        IN_CHAIN_BREAK.set(true);
        try {
            while (!queue.isEmpty()) {
                if (destroyedCount >= maxBlocks) {
                    truncated = true;
                    failureReasons.add("max_blocks_reached");
                    break;
                }

                BlockPos current = queue.removeFirst();
                scannedCount += 1;
                BlockState currentState = world.getBlockState(current);
                if (!isSameResourceBlock(currentState, originBlock, resourceKind)) {
                    continue;
                }

                boolean destroyed = player.interactionManager.tryBreakBlock(current);
                if (!destroyed) {
                    failureReasons.add("try_break_failed");
                    continue;
                }

                destroyedCount += 1;
                enqueueNeighbors(queue, visited, current);
            }
        } finally {
            IN_CHAIN_BREAK.set(false);
        }

        return new ChainBreakResult(destroyedCount, scannedCount, truncated, failureReasons);
    }

    private void enqueueNeighbors(ArrayDeque<BlockPos> queue, Set<BlockPos> visited, BlockPos center) {
        for (int dx = -NEIGHBOR_RADIUS; dx <= NEIGHBOR_RADIUS; dx += 1) {
            for (int dy = -NEIGHBOR_RADIUS; dy <= NEIGHBOR_RADIUS; dy += 1) {
                for (int dz = -NEIGHBOR_RADIUS; dz <= NEIGHBOR_RADIUS; dz += 1) {
                    if (dx == 0 && dy == 0 && dz == 0) {
                        continue;
                    }
                    BlockPos candidate = center.add(dx, dy, dz);
                    if (visited.add(candidate)) {
                        queue.add(candidate);
                    }
                }
            }
        }
    }

    private boolean isSameResourceBlock(BlockState state, Block originBlock, ResourceKind resourceKind) {
        return state.getBlock() == originBlock && classifyResource(state) == resourceKind;
    }

    private ResourceKind classifyResource(BlockState state) {
        if (state.isIn(BlockTags.LOGS)) {
            return ResourceKind.LOG;
        }
        for (TagKey<Block> tag : ORE_TAGS) {
            if (state.isIn(tag)) {
                return ResourceKind.ORE;
            }
        }
        return ResourceKind.NONE;
    }

    private static int readMaxBlocks() {
        String raw = firstNonBlank(
                System.getProperty(CONFIG_MAX_BLOCKS_PROPERTY),
                System.getenv(CONFIG_MAX_BLOCKS_ENV)
        );
        if (raw == null) {
            return DEFAULT_MAX_BLOCKS;
        }

        try {
            return Math.max(1, Integer.parseInt(raw));
        } catch (NumberFormatException ignored) {
            return DEFAULT_MAX_BLOCKS;
        }
    }

    private static String firstNonBlank(String... values) {
        for (String value : values) {
            if (value != null && !value.isBlank()) {
                return value;
            }
        }
        return null;
    }

    private static TagKey<Block> blockTag(String namespace, String path) {
        return TagKey.of(RegistryKeys.BLOCK, new Identifier(namespace, path));
    }

    private static String worldKey(ServerWorld world) {
        return world.getRegistryKey().getValue().toString();
    }

    private static String blockId(BlockState state) {
        return Registries.BLOCK.getId(state.getBlock()).toString();
    }

    private static String formatPos(BlockPos pos) {
        return pos.getX() + "," + pos.getY() + "," + pos.getZ();
    }

    private enum ResourceKind {
        NONE("none"),
        LOG("log"),
        ORE("ore");

        private final String logName;

        ResourceKind(String logName) {
            this.logName = logName;
        }
    }

    private record ChainBreakResult(
            int destroyedCount,
            int scannedCount,
            boolean truncated,
            Set<String> failureReasons
    ) {
    }
}
