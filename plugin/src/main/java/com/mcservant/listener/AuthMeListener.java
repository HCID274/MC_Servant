package com.mcservant.listener;

import com.alibaba.fastjson2.JSONObject;
import com.mcservant.MCServant;
import com.mcservant.websocket.IWebSocketClient;
import fr.xephi.authme.events.LoginEvent;
import fr.xephi.authme.events.LogoutEvent;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.player.PlayerQuitEvent;

import java.util.logging.Logger;

/**
 * AuthMe 认证事件监听器
 * 
 * <p>设计原则：简单的接口，深度的功能</p>
 * 
 * <p>职责：
 * <ul>
 *   <li>监听 AuthMe 登录成功事件 → 发送 player_login</li>
 *   <li>监听 AuthMe 登出事件 → 发送 player_quit</li>
 *   <li>监听玩家断开连接 → 发送 player_quit</li>
 * </ul>
 * </p>
 * 
 * <p>为什么使用 AuthMe 事件而非 PlayerJoinEvent?
 * <ul>
 *   <li>PlayerJoinEvent 触发时玩家可能尚未完成登录验证</li>
 *   <li>未验证的玩家不应触发 Bot 上线逻辑</li>
 *   <li>使用 AuthMe 的 LoginEvent 确保只处理"真正登录"的玩家</li>
 * </ul>
 * </p>
 */
public class AuthMeListener implements Listener {

    private static final Logger logger = MCServant.log();

    /**
     * 处理 AuthMe 登录成功事件
     * 
     * <p>只有在玩家通过 AuthMe 验证后才会触发</p>
     */
    @EventHandler(priority = EventPriority.MONITOR)
    public void onLogin(LoginEvent event) {
        Player player = event.getPlayer();
        sendPlayerLogin(player);
    }

    /**
     * 处理 AuthMe 登出事件
     * 
     * <p>玩家使用 /logout 命令时触发</p>
     */
    @EventHandler(priority = EventPriority.MONITOR)
    public void onLogout(LogoutEvent event) {
        Player player = event.getPlayer();
        sendPlayerQuit(player);
    }

    /**
     * 处理玩家断开连接
     * 
     * <p>无论玩家是否已登录，断开连接都需要通知后端</p>
     */
    @EventHandler(priority = EventPriority.MONITOR)
    public void onQuit(PlayerQuitEvent event) {
        Player player = event.getPlayer();
        sendPlayerQuit(player);
    }

    /**
     * 发送玩家登录消息到 Python 后端
     */
    private void sendPlayerLogin(Player player) {
        IWebSocketClient ws = MCServant.getInstance().getWsClient();
        if (ws == null || !ws.isConnected()) {
            logger.warning("[AuthMe] WebSocket not connected, cannot send player_login");
            return;
        }

        JSONObject msg = new JSONObject();
        msg.put("type", "player_login");
        msg.put("player", player.getName());
        msg.put("player_uuid", player.getUniqueId().toString());
        msg.put("timestamp", System.currentTimeMillis() / 1000);

        logger.info("[AuthMe] Player login: " + player.getName());
        ws.send(msg.toJSONString());
    }

    /**
     * 发送玩家退出消息到 Python 后端
     */
    private void sendPlayerQuit(Player player) {
        IWebSocketClient ws = MCServant.getInstance().getWsClient();
        if (ws == null || !ws.isConnected()) {
            logger.warning("[AuthMe] WebSocket not connected, cannot send player_quit");
            return;
        }

        JSONObject msg = new JSONObject();
        msg.put("type", "player_quit");
        msg.put("player", player.getName());
        msg.put("player_uuid", player.getUniqueId().toString());
        msg.put("timestamp", System.currentTimeMillis() / 1000);

        logger.info("[AuthMe] Player quit: " + player.getName());
        ws.send(msg.toJSONString());
    }
}
