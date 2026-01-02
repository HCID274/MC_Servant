package com.mcservant.listener;

import com.alibaba.fastjson2.JSONObject;
import com.mcservant.MCServant;
import com.mcservant.hologram.IHologramService;
import com.mcservant.registry.IBotRegistry;
import com.mcservant.websocket.IWebSocketClient;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.event.player.PlayerQuitEvent;

import java.util.logging.Logger;

/**
 * 玩家连接事件监听器
 * 
 * <p>设计原则：Dumb Sensor - 只汇报事件，不做复杂决策</p>
 * 
 * <p>职责：
 * <ul>
 *   <li>Bot 登录：隐藏名牌 + 推送 bot_spawned 事件</li>
 *   <li>所有玩家登录/登出：推送 player_join/quit 事件</li>
 *   <li>Bot 登出：清理全息</li>
 * </ul>
 * </p>
 */
public class PlayerConnectionListener implements Listener {
    
    private static final Logger logger = MCServant.log();
    
    /**
     * 玩家加入事件
     */
    @EventHandler(priority = EventPriority.MONITOR)
    public void onPlayerJoin(PlayerJoinEvent event) {
        String playerName = event.getPlayer().getName();
        String playerUuid = event.getPlayer().getUniqueId().toString();
        
        IBotRegistry botRegistry = MCServant.getInstance().getBotRegistry();
        IHologramService hologramService = MCServant.getInstance().getHologramManager();
        
        // 检查是否为 Bot
        if (botRegistry != null && botRegistry.isBot(playerName)) {
            logger.info("Bot joined: " + playerName);
            
            // 隐藏名牌
            if (hologramService != null) {
                hologramService.hideNameplate(playerName);
            }
            
            // 推送 bot_spawned 事件
            pushEvent("bot_spawned", playerName, playerUuid);
        }
        
        // 无论是否 Bot，都推送 player_join (Dumb Sensor 模式)
        pushEvent("player_join", playerName, playerUuid);
    }
    
    /**
     * 玩家退出事件
     */
    @EventHandler(priority = EventPriority.MONITOR)
    public void onPlayerQuit(PlayerQuitEvent event) {
        String playerName = event.getPlayer().getName();
        String playerUuid = event.getPlayer().getUniqueId().toString();
        
        IBotRegistry botRegistry = MCServant.getInstance().getBotRegistry();
        IHologramService hologramService = MCServant.getInstance().getHologramManager();
        
        // 如果是 Bot，清理全息
        if (botRegistry != null && botRegistry.isBot(playerName)) {
            if (hologramService != null && hologramService.exists(playerName)) {
                hologramService.removeHologram(playerName);
                logger.info("Bot quit, hologram removed: " + playerName);
            }
        }
        
        // 推送 player_quit (Dumb Sensor 模式)
        pushEvent("player_quit", playerName, playerUuid);
    }
    
    /**
     * 推送事件到 Python 后端
     */
    private void pushEvent(String type, String playerName, String playerUuid) {
        IWebSocketClient wsClient = MCServant.getInstance().getWsClient();
        if (wsClient == null || !wsClient.isConnected()) {
            return;
        }
        
        JSONObject message = new JSONObject();
        message.put("type", type);
        message.put("player", playerName);
        message.put("player_uuid", playerUuid);
        message.put("timestamp", System.currentTimeMillis() / 1000);
        
        wsClient.send(message.toJSONString());
        logger.fine("Pushed event: " + type + " for " + playerName);
    }
}
