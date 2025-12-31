package com.mcservant.commands;

import com.alibaba.fastjson2.JSONObject;
import com.mcservant.MCServant;
import com.mcservant.websocket.IWebSocketClient;
import dev.jorel.commandapi.CommandAPICommand;
import dev.jorel.commandapi.arguments.StringArgument;
import dev.jorel.commandapi.arguments.GreedyStringArgument;
import dev.jorel.commandapi.arguments.ArgumentSuggestions;
import org.bukkit.entity.Player;

/**
 * Servant 命令注册器
 * 
 * <p>使用 CommandAPI 实现命令注册，享受自动补全、参数校验等功能</p>
 * 
 * <p>命令结构：
 * <ul>
 *   <li>/servant hello - 快速问候</li>
 *   <li>/servant status - 查看连接状态</li>
 *   <li>/servant say &lt;message&gt; - 发送自由文本到 LLM</li>
 *   <li>/svs &lt;message&gt; - 快捷命令，直接发送到 LLM</li>
 * </ul>
 * </p>
 */
public final class ServantCommands {

    // 快捷操作类型
    private static final String[] QUICK_ACTIONS = {"hello", "status", "say"};

    private ServantCommands() {
        // 工具类，禁止实例化
    }

    /**
     * 注册所有 Servant 相关命令
     */
    public static void register() {
        registerMainCommand();
        registerQuickCommand();
    }

    /**
     * 注册主命令 /servant <action> [message]
     */
    private static void registerMainCommand() {
        // /servant hello 或 /servant status
        new CommandAPICommand("servant")
            .withArguments(
                new StringArgument("action")
                    .replaceSuggestions(ArgumentSuggestions.strings(QUICK_ACTIONS))
            )
            .executesPlayer((player, args) -> {
                String action = (String) args.get("action");
                handleQuickAction(player, action);
            })
            .register();
        
        // /servant say <message> - 发送自由文本
        new CommandAPICommand("servant")
            .withArguments(
                new StringArgument("action")
                    .replaceSuggestions(ArgumentSuggestions.strings("say")),
                new GreedyStringArgument("message")
            )
            .executesPlayer((player, args) -> {
                String action = (String) args.get("action");
                String message = (String) args.get("message");
                
                if ("say".equalsIgnoreCase(action)) {
                    sendToBackend(player, message);
                } else {
                    player.sendMessage("§c[MC_Servant] §f用法: /servant say <消息>");
                }
            })
            .register();
    }
    
    /**
     * 注册快捷命令 /svs <message>
     * 直接发送自由文本到后端 LLM
     */
    private static void registerQuickCommand() {
        new CommandAPICommand("svs")
            .withArguments(new GreedyStringArgument("message"))
            .executesPlayer((player, args) -> {
                String message = (String) args.get("message");
                sendToBackend(player, message);
            })
            .register();
    }

    /**
     * 处理快捷操作
     */
    private static void handleQuickAction(Player player, String action) {
        switch (action.toLowerCase()) {
            case "hello" -> sendToBackend(player, "hello");
            case "status" -> handleStatus(player);
            case "say" -> player.sendMessage("§e[MC_Servant] §f用法: /servant say <消息>");
            default -> player.sendMessage("§c[MC_Servant] §f未知操作: " + action + "\n§7可用: hello, status, say <消息>");
        }
    }
    
    /**
     * 发送消息到后端 (通用方法)
     */
    private static void sendToBackend(Player player, String content) {
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
        message.put("content", content);
        message.put("timestamp", System.currentTimeMillis() / 1000);
        
        // 发送到后端
        boolean sent = wsClient.send(message.toJSONString());
        
        if (sent) {
            player.sendMessage("§7[MC_Servant] §f已发送: §e" + content);
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
}
