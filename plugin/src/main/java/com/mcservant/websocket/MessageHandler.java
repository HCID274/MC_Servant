package com.mcservant.websocket;

import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.JSONObject;
import com.mcservant.MCServant;
import org.bukkit.Bukkit;
import org.bukkit.entity.Player;

import java.util.logging.Logger;

/**
 * WebSocket 消息处理器
 * 
 * <p>处理来自 Python 后端的响应消息</p>
 */
public class MessageHandler implements IWebSocketClient.MessageCallback {

    private static final Logger logger = MCServant.log();

    @Override
    public void onMessage(String message) {
        try {
            JSONObject json = JSON.parseObject(message);
            String type = json.getString("type");
            
            if (type == null) {
                logger.warning("Received message without type: " + message);
                return;
            }
            
            switch (type) {
                case "npc_response" -> handleNpcResponse(json);
                case "bot_status" -> handleBotStatus(json);
                case "heartbeat" -> handleHeartbeat(json);
                case "error" -> handleError(json);
                default -> logger.warning("Unknown message type: " + type);
            }
            
        } catch (Exception e) {
            logger.severe("Error handling message: " + e.getMessage());
        }
    }
    
    /**
     * 处理 NPC 回复
     */
    private void handleNpcResponse(JSONObject json) {
        String npc = json.getString("npc");
        String targetPlayer = json.getString("target_player");
        String content = json.getString("content");
        String hologramText = json.getString("hologram_text");
        String action = json.getString("action");
        
        logger.info(String.format("NPC %s -> %s: %s", npc, targetPlayer, content));
        
        // 向目标玩家发送消息
        if (targetPlayer != null) {
            Player player = Bukkit.getPlayer(targetPlayer);
            if (player != null && player.isOnline()) {
                player.sendMessage("§a[" + npc + "] §f" + content);
            }
        }
        
        // TODO: 更新全息显示 (使用 DecentHolograms API)
        if (hologramText != null) {
            logger.fine("Hologram update: " + hologramText);
        }
    }
    
    /**
     * 处理 Bot 状态更新
     */
    private void handleBotStatus(JSONObject json) {
        String npc = json.getString("npc");
        String status = json.getString("status");
        
        logger.info(String.format("Bot %s status: %s", npc, status));
    }
    
    /**
     * 处理心跳响应
     */
    private void handleHeartbeat(JSONObject json) {
        logger.fine("Heartbeat received");
    }
    
    /**
     * 处理错误消息
     */
    private void handleError(JSONObject json) {
        String code = json.getString("code");
        String errorMessage = json.getString("message");
        
        logger.warning(String.format("Error from backend: [%s] %s", code, errorMessage));
    }
}
