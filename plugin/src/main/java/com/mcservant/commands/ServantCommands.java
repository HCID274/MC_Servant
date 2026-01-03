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
 * <p>命令结构（@bot 可选，省略时自动选择默认女仆）：
 * <ul>
 *   <li>/servant [@bot] claim - 认领女仆</li>
 *   <li>/servant [@bot] release - 释放女仆</li>
 *   <li>/servant list - 列出我的女仆</li>
 *   <li>/servant status - 查看连接状态</li>
 *   <li>/svs [@bot] <message> - 发送自由文本到 LLM</li>
 * </ul>
 * </p>
 */
public final class ServantCommands {

    // 快捷操作类型
    private static final String[] QUICK_ACTIONS = {"claim", "release", "list", "status", "hello"};

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
     * 注册主命令 /servant [@bot] <action>
     */
    private static void registerMainCommand() {
        // /servant <action> - 无目标的快捷操作 (使用默认 Bot)
        new CommandAPICommand("servant")
            .withArguments(
                new StringArgument("action")
                    .replaceSuggestions(ArgumentSuggestions.strings(QUICK_ACTIONS))
            )
            .executesPlayer((player, args) -> {
                String action = (String) args.get("action");
                handleQuickAction(player, action, null);
            })
            .register();
        
        // /servant <target_or_action> <action_or_empty> - 带目标或消息的操作
        new CommandAPICommand("servant")
            .withArguments(
                new StringArgument("first"),
                new GreedyStringArgument("rest")
            )
            .executesPlayer((player, args) -> {
                String first = (String) args.get("first");
                String rest = (String) args.get("rest");
                
                // 检查第一个参数是否是 @botName
                if (first.startsWith("@") && first.length() > 1) {
                    String botName = first.substring(1);
                    String action = rest.trim().split(" ")[0]; // 取第一个词作为action
                    handleQuickAction(player, action, botName);
                } else {
                    // 第一个参数是 action，rest 是 @target (兼容旧格式)
                    String botName = parseTargetBot(rest);
                    handleQuickAction(player, first, botName);
                }
            })
            .register();
    }
    
    /**
     * 注册快捷命令 /svs <message> [@bot]
     * 直接发送自由文本到后端 LLM
     */
    private static void registerQuickCommand() {
        new CommandAPICommand("svs")
            .withArguments(new GreedyStringArgument("message"))
            .executesPlayer((player, args) -> {
                String rawMessage = (String) args.get("message");
                
                // 解析消息和目标 Bot
                ParsedMessage parsed = parseMessageWithTarget(rawMessage);
                sendChatToBackend(player, parsed.message, parsed.targetBot);
            })
            .register();
    }

    /**
     * 处理快捷操作
     */
    private static void handleQuickAction(Player player, String action, String targetBot) {
        switch (action.toLowerCase()) {
            case "claim" -> sendCommandToBackend(player, "claim", targetBot);
            case "release" -> sendCommandToBackend(player, "release", targetBot);
            case "list" -> sendCommandToBackend(player, "list", null);
            case "status" -> handleStatus(player);
            case "hello" -> sendChatToBackend(player, "hello", targetBot);
            default -> player.sendMessage("§c[MC_Servant] §f未知操作: " + action + 
                "\n§7可用: claim, release, list, status, hello");
        }
    }
    
    /**
     * 发送系统命令到后端 (claim, release, list)
     */
    private static void sendCommandToBackend(Player player, String command, String targetBot) {
        IWebSocketClient wsClient = MCServant.getInstance().getWsClient();
        
        if (wsClient == null || !wsClient.isConnected()) {
            player.sendMessage("§c[MC_Servant] §f后端服务未连接，请稍后重试");
            return;
        }
        
        // 构建命令消息
        JSONObject message = new JSONObject();
        message.put("type", "servant_command");
        message.put("player", player.getName());
        message.put("player_uuid", player.getUniqueId().toString());
        message.put("command", command);
        if (targetBot != null && !targetBot.isEmpty()) {
            message.put("target_bot", targetBot);
        }
        message.put("timestamp", System.currentTimeMillis() / 1000);
        
        // 发送到后端
        boolean sent = wsClient.send(message.toJSONString());
        
        if (sent) {
            String botInfo = targetBot != null ? " @" + targetBot : "";
            player.sendMessage("§7[MC_Servant] §f执行: §e" + command + botInfo);
        } else {
            player.sendMessage("§c[MC_Servant] §f命令发送失败");
        }
    }
    
    /**
     * 发送聊天消息到后端 (自由文本)
     */
    private static void sendChatToBackend(Player player, String content, String targetBot) {
        IWebSocketClient wsClient = MCServant.getInstance().getWsClient();
        
        if (wsClient == null || !wsClient.isConnected()) {
            player.sendMessage("§c[MC_Servant] §f后端服务未连接，请稍后重试");
            return;
        }
        
        // 构建消息
        JSONObject message = new JSONObject();
        message.put("type", "player_message");
        message.put("player", player.getName());
        message.put("player_uuid", player.getUniqueId().toString());
        message.put("npc", targetBot != null ? targetBot : getDefaultBot());
        message.put("content", content);
        message.put("timestamp", System.currentTimeMillis() / 1000);
        
        // 添加玩家实时位置（用于 goto 等命令）
        message.put("player_x", player.getLocation().getX());
        message.put("player_y", player.getLocation().getY());
        message.put("player_z", player.getLocation().getZ());
        
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
    
    /**
     * 解析目标 Bot 名称 (从 @xxx 格式)
     */
    private static String parseTargetBot(String target) {
        if (target == null || target.isEmpty()) {
            return null;
        }
        target = target.trim();
        if (target.startsWith("@")) {
            return target.substring(1);
        }
        return target;
    }
    
    /**
     * 解析消息开头的 @botName
     * 
     * @param rawMessage 原始消息如 "@Alice 帮我盖房子" 或 "帮我盖房子"
     * @return ParsedMessage 包含消息和目标 Bot
     */
    private static ParsedMessage parseMessageWithTarget(String rawMessage) {
        if (rawMessage == null || rawMessage.isEmpty()) {
            return new ParsedMessage("", null);
        }
        
        String trimmed = rawMessage.trim();
        
        // 检查是否以 @ 开头
        if (trimmed.startsWith("@")) {
            // 查找第一个空格，分离 @name 和消息
            int spaceIdx = trimmed.indexOf(' ');
            if (spaceIdx > 1) {
                String targetBot = trimmed.substring(1, spaceIdx);  // 提取 name (去掉@)
                String message = trimmed.substring(spaceIdx + 1).trim();  // 剩余消息
                return new ParsedMessage(message, targetBot);
            } else {
                // 只有 @name，没有消息
                return new ParsedMessage("", trimmed.substring(1));
            }
        }
        
        // 没有 @，整个都是消息，targetBot = null (使用默认)
        return new ParsedMessage(trimmed, null);
    }
    
    /**
     * 获取默认 Bot 名称
     */
    private static String getDefaultBot() {
        // TODO: 从配置或玩家数据中获取默认 Bot
        return "MCServant_Bot";
    }
    
    /**
     * 解析后的消息结构
     */
    private static class ParsedMessage {
        final String message;
        final String targetBot;
        
        ParsedMessage(String message, String targetBot) {
            this.message = message;
            this.targetBot = targetBot;
        }
    }
}
