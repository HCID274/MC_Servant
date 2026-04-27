package com.mcservant.command;

import com.mcservant.bridge.ServerBridgeTransport;
import com.mojang.brigadier.CommandDispatcher;
import com.mojang.brigadier.arguments.StringArgumentType;
import com.mojang.brigadier.context.CommandContext;
import com.mojang.brigadier.exceptions.CommandSyntaxException;
import me.lucko.fabric.api.permissions.v0.Permissions;
import net.fabricmc.fabric.api.command.v2.CommandRegistrationCallback;
import net.minecraft.server.command.CommandManager;
import net.minecraft.server.command.ServerCommandSource;
import net.minecraft.server.network.ServerPlayerEntity;
import net.minecraft.text.Text;
import net.minecraft.util.Formatting;

import java.util.UUID;
import java.util.function.Supplier;

/**
 * /svs &lt;message&gt;（女仆服务端命令）：把玩家原始消息封装成 player_message 协议帧
 * 经 {@link ServerBridgeTransport} 发送到 TS Core 单核心。
 *
 * <p>权限模型：优先调用 fabric-permissions-api 的 {@code mcservant.svs.use}（默认 op level 2），
 * 在该 API 缺席时回退到原版 op level 2 判定。命令本身只允许玩家执行，
 * 控制台 / 命令方块发送方会被明确拒绝（避免空 UUID 进入协议帧）。
 *
 * <p>Phase 1 严禁让 player_message 直接驱动 Bot，仅作为 observe_only 事件流入 TS Core；
 * 命令层负责把执行结果（已发送 / 桥接未连接）以脱敏文本回复给玩家。
 */
public final class SvsCommand {

    /** 权限节点：fabric-permissions-api 校验 key */
    public static final String PERMISSION_NODE = "mcservant.svs.use";

    /** 默认权限等级回退（op level 2） */
    public static final int DEFAULT_OP_LEVEL = 2;

    private SvsCommand() {
    }

    /**
     * 注册 /svs 命令。建议在 mod 入口的 onInitializeServer 中调用一次。
     *
     * @param transportSupplier 桥接传输只读获取器；使用 supplier 是为了允许命令注册早于 transport 完成连接
     */
    public static void register(Supplier<ServerBridgeTransport> transportSupplier) {
        CommandRegistrationCallback.EVENT.register((dispatcher, registryAccess, environment) ->
                register(dispatcher, transportSupplier)
        );
    }

    /**
     * 直接对 dispatcher 注册 /svs 节点，便于复用与诊断。
     */
    public static void register(
            CommandDispatcher<ServerCommandSource> dispatcher,
            Supplier<ServerBridgeTransport> transportSupplier
    ) {
        dispatcher.register(
                CommandManager.literal("svs")
                        .then(CommandManager
                                .argument("message", StringArgumentType.greedyString())
                                .executes(context -> execute(context, transportSupplier))
                        )
        );
    }

    private static boolean hasPermission(ServerCommandSource source) {
        try {
            return Permissions.check(source, PERMISSION_NODE, DEFAULT_OP_LEVEL);
        } catch (NoClassDefFoundError ignored) {
            return source.hasPermissionLevel(DEFAULT_OP_LEVEL);
        }
    }

    private static int execute(
            CommandContext<ServerCommandSource> context,
            Supplier<ServerBridgeTransport> transportSupplier
    ) throws CommandSyntaxException {
        if (!hasPermission(context.getSource())) {
            sendErrorReply(context.getSource(), "没有权限使用此命令");
            return 0;
        }

        ServerPlayerEntity player;
        try {
            player = context.getSource().getPlayerOrThrow();
        } catch (CommandSyntaxException error) {
            sendErrorReply(context.getSource(), "只有玩家可以使用此命令");
            return 0;
        }

        String content = StringArgumentType.getString(context, "message").trim();
        if (content.isEmpty()) {
            sendErrorReply(context.getSource(), "消息内容不能为空");
            return 0;
        }

        ServerBridgeTransport transport = transportSupplier.get();
        if (transport == null) {
            sendErrorReply(context.getSource(), "桥接尚未装配（mod 未完成 onInitializeServer）");
            return 0;
        }
        if (!transport.isConnected()) {
            sendErrorReply(context.getSource(), bridgeUnavailableMessage(transport.state()));
            return 0;
        }

        String messageId = UUID.randomUUID().toString();
        boolean sent = transport.sendPlayerMessage(
                messageId,
                player.getUuidAsString(),
                player.getGameProfile().getName(),
                content
        );
        if (!sent) {
            sendErrorReply(context.getSource(), "桥接发送失败");
            return 0;
        }

        sendOkReply(context.getSource(), "已转发到 TS Core");
        return 1;
    }

    private static void sendOkReply(ServerCommandSource source, String message) {
        source.sendFeedback(() -> Text.literal("[svs] " + message).formatted(Formatting.GRAY), false);
    }

    private static void sendErrorReply(ServerCommandSource source, String message) {
        source.sendError(Text.literal("[svs] " + message).formatted(Formatting.RED));
    }

    private static String bridgeUnavailableMessage(ServerBridgeTransport.ConnectionState state) {
        return switch (state) {
            case CONNECTING -> "桥接正在连接 TS Core，稍后重试";
            case RECONNECTING -> "桥接正在重连 TS Core，稍后重试";
            case AUTH_FAILED -> "桥接 token 配置错误，TS Core 拒绝连接";
            case PROTOCOL_INCOMPATIBLE -> "桥接协议不兼容，请升级 TS Core 或 mod";
            case CLOSING -> "桥接正在关闭，TS Core 暂时无法接收消息";
            case DISCONNECTED -> "桥接未连接，TS Core 无法接收消息";
            case CONNECTED -> "桥接发送失败";
        };
    }
}
