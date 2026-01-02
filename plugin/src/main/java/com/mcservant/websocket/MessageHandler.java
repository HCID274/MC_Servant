package com.mcservant.websocket;

import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.JSONArray;
import com.alibaba.fastjson2.JSONObject;
import com.mcservant.MCServant;
import com.mcservant.hologram.IHologramService;
import com.mcservant.registry.IBotRegistry;
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
            // 入口日志
            logger.info("[WS Received] " + message.substring(0, Math.min(100, message.length())));
            
            JSONObject json = JSON.parseObject(message);
            String type = json.getString("type");
            
            if (type == null) {
                logger.warning("Received message without type: " + message);
                return;
            }
            
            logger.info("[WS Type] " + type);
            
            switch (type) {
                case "init_config" -> handleInitConfig(json);
                case "npc_response" -> handleNpcResponse(json);
                case "bot_status" -> handleBotStatus(json);
                case "hologram_update" -> handleHologramUpdate(json);
                case "heartbeat" -> handleHeartbeat(json);
                case "error" -> handleError(json);
                default -> logger.warning("Unknown message type: " + type);
            }
            
        } catch (Exception e) {
            logger.severe("Error handling message: " + e.getMessage());
            e.printStackTrace();
        }
    }
    
    /**
     * 处理初始化配置 (Init Sync)
     * 
     * <p>Python 连接后发送，包含 Bot 名称列表</p>
     */
    private void handleInitConfig(JSONObject json) {
        JSONArray botNames = json.getJSONArray("bot_names");
        if (botNames == null) {
            logger.warning("init_config missing bot_names");
            return;
        }
        
        IBotRegistry registry = MCServant.getInstance().getBotRegistry();
        if (registry == null) {
            logger.warning("BotRegistry not initialized");
            return;
        }
        
        registry.clear();
        for (int i = 0; i < botNames.size(); i++) {
            registry.registerBot(botNames.getString(i));
        }
        
        logger.info("[Init Sync] Registered " + botNames.size() + " bots: " + botNames);
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
        
        // DEBUG: 打印解析后的关键字段
        logger.info(String.format("[DEBUG] handleNpcResponse: npc='%s', hologram='%s', target='%s'", 
            npc, hologramText, targetPlayer));
        logger.info(String.format("NPC %s -> %s: %s", npc, targetPlayer, content));
        
        // 向目标玩家发送消息
        if (targetPlayer != null) {
            Player player = Bukkit.getPlayer(targetPlayer);
            if (player != null && player.isOnline()) {
                player.sendMessage("§a[" + npc + "] §f" + content);
            } else {
                logger.info(String.format("[DEBUG] Target player '%s' not found or offline", targetPlayer));
            }
        }
        
        // 更新全息显示 (线程安全调度)
        if (hologramText != null) {
            logger.info(String.format("[DEBUG] 准备更新全息: npc='%s', text='%s'", npc, hologramText));
            // 必须切回主线程调用 Bukkit/DHAPI
            Bukkit.getScheduler().runTask(MCServant.getInstance(), () -> {
                IHologramService hm = MCServant.getInstance().getHologramManager();
                if (hm != null) {
                    logger.info(String.format("[DEBUG] 调用 HologramManager.updateHologram('%s', '%s')", npc, hologramText));
                    hm.updateHologram(npc, hologramText);
                } else {
                    logger.warning("[DEBUG] HologramManager is null!");
                }
            });
        } else {
            logger.info("[DEBUG] hologramText is null, skipping hologram update");
        }
    }
    
    /**
     * 处理全息更新消息 (Python 主动推送)
     */
    private void handleHologramUpdate(JSONObject json) {
        String npc = json.getString("npc");
        String hologramText = json.getString("hologram_text");
        String identityLine = json.getString("identity_line");
        
        // DEBUG: 改为 INFO 级别日志
        logger.info(String.format("[DEBUG] handleHologramUpdate: npc='%s', text='%s', identity='%s'", 
            npc, hologramText, identityLine));
        
        // 切回主线程
        Bukkit.getScheduler().runTask(MCServant.getInstance(), () -> {
            IHologramService hm = MCServant.getInstance().getHologramManager();
            if (hm != null) {
                if (hologramText != null) {
                    logger.info(String.format("[DEBUG] hologram_update: calling updateHologram('%s', '%s')", npc, hologramText));
                    hm.updateHologram(npc, hologramText);
                }
                if (identityLine != null) {
                    hm.setIdentity(npc, identityLine);
                }
            } else {
                logger.warning("[DEBUG] hologram_update: HologramManager is null!");
            }
        });
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
