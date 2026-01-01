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
 * <p>命令结构：
 * <ul>
 *   <li>/servant claim [@bot] - 认领女仆</li>
 *   <li>/servant release [@bot] - 释放女仆</li>
 *   <li>/servant list - 列出我的女仆</li>
 *   <li>/servant status - 查看连接状态</li>
 *   <li>/svs <message> [@bot] - 发送自由文本到 LLM</li>
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
     * 注册主命令 /servant <action> [@bot]
     */
    private static void registerMainCommand() {
        // /servant <action> - 无参数的快捷操作
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
        
        // /servant <action> <target> - 带目标的操作
        new CommandAPICommand("servant")
            .withArguments(
                new StringArgument("action")
                    .replaceSuggestions(ArgumentSuggestions.strings(QUICK_ACTIONS)),
                new GreedyStringArgument("target")
            )
            .executesPlayer((player, args) -> {
                String action = (String) args.get("action");
                String target = (String) args.get("target");
                
                // 解析 @botName
                String botName = parseTargetBot(target);
                handleQuickAction(player, action, botName);
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
     * 解析消息末尾的 @botName
     * 
     * @param rawMessage 原始消息如 "帮我盖房子 @Alice"
     * @return ParsedMessage 包含消息和目标 Bot
     */
    private static ParsedMessage parseMessageWithTarget(String rawMessage) {
        if (rawMessage == null || rawMessage.isEmpty()) {
            return new ParsedMessage("", null);
        }
        
        // 查找最后一个空格后的 @xxx
        String trimmed = rawMessage.trim();
        int lastSpace = trimmed.lastIndexOf(' ');
        
        if (lastSpace > 0) {
            String lastPart = trimmed.substring(lastSpace + 1);
            if (lastPart.startsWith("@") && lastPart.length() > 1) {
                String message = trimmed.substring(0, lastSpace).trim();
                String targetBot = lastPart.substring(1);
                return new ParsedMessage(message, targetBot);
            }
        }
        
        // 没有 @target，整个都是消息
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
