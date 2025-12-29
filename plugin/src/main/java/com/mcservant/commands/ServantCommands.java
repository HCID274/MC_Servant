package com.mcservant.commands;

import com.alibaba.fastjson2.JSONObject;
import com.mcservant.MCServant;
import com.mcservant.websocket.IWebSocketClient;
import dev.jorel.commandapi.CommandAPICommand;
import dev.jorel.commandapi.arguments.StringArgument;
import dev.jorel.commandapi.arguments.ArgumentSuggestions;
import org.bukkit.entity.Player;

/**
 * Servant 命令注册器
 * 
 * <p>使用 CommandAPI 实现命令注册，享受自动补全、参数校验等功能</p>
 * 
 * <p>设计原则：
 * <ul>
 *   <li>简单接口：外部只需调用 register()</li>
 *   <li>深度功能：内部使用 CommandAPI 丰富特性</li>
 *   <li>可扩展：预留 action 参数支持多种操作</li>
 * </ul>
 * </p>
 */
public final class ServantCommands {

    // 支持的操作类型（后续扩展）
    private static final String[] ACTIONS = {"hello", "build", "mine", "farm", "guard", "status"};

    private ServantCommands() {
        // 工具类，禁止实例化
    }

    /**
     * 注册所有 Servant 相关命令
     */
    public static void register() {
        registerMainCommand();
    }

    /**
     * 注册主命令 /servant
     */
    private static void registerMainCommand() {
        new CommandAPICommand("servant")
            .withAliases("sv")  // 别名
            // 开发阶段暂不限制权限
            .withArguments(
                new StringArgument("action")
                    .replaceSuggestions(ArgumentSuggestions.strings(ACTIONS))
            )
            .executesPlayer((player, args) -> {
                String action = (String) args.get("action");
                handleAction(player, action);
            })
            .register();
    }

    /**
     * 处理用户操作
     * 
     * @param player 执行命令的玩家
     * @param action 操作类型
     */
    private static void handleAction(Player player, String action) {
        switch (action.toLowerCase()) {
            case "hello" -> handleHello(player);
            case "build" -> handleNotImplemented(player, "建造");
            case "mine" -> handleNotImplemented(player, "挖矿");
            case "farm" -> handleNotImplemented(player, "种田");
            case "guard" -> handleNotImplemented(player, "守卫");
            case "status" -> handleStatus(player);
            default -> player.sendMessage("§c[MC_Servant] §f未知操作: " + action);
        }
    }

    /**
     * 处理 hello 命令 - 通过 WebSocket 发送到后端
     */
    private static void handleHello(Player player) {
        IWebSocketClient wsClient = MCServant.getInstance().getWsClient();
        
        if (wsClient == null || !wsClient.isConnected()) {
            player.sendMessage("§c[MC_Servant] §f后端服务未连接，请稍后重试");
            return;
        }
        
        // 构建消息
        JSONObject message = new JSONObject();
        message.put("type", "player_message");
        message.put("player", player.getName());
        message.put("npc", "Alice");  // 默认 NPC
        message.put("content", "hello");
        message.put("timestamp", System.currentTimeMillis() / 1000);
        
        // 发送到后端
        boolean sent = wsClient.send(message.toJSONString());
        
        if (sent) {
            player.sendMessage("§7[MC_Servant] 指令已发送...");
        } else {
            player.sendMessage("§c[MC_Servant] §f消息发送失败");
        }
    }
    
    /**
     * 处理 status 命令 - 显示连接状态
     */
    private static void handleStatus(Player player) {
        IWebSocketClient wsClient = MCServant.getInstance().getWsClient();
        
        if (wsClient == null) {
            player.sendMessage("§c[MC_Servant] §fWebSocket 客户端未初始化");
            return;
        }
        
        if (wsClient.isConnected()) {
            player.sendMessage("§a[MC_Servant] §f后端服务: §a已连接");
        } else {
            player.sendMessage("§e[MC_Servant] §f后端服务: §c未连接");
        }
    }

    /**
     * 未实现功能的占位处理
     */
    private static void handleNotImplemented(Player player, String feature) {
        player.sendMessage("§e[MC_Servant] §f" + feature + "功能正在开发中...");
    }
}

