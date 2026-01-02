package com.mcservant.registry;

import com.mcservant.MCServant;

import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.logging.Logger;

/**
 * Bot 注册表实现
 * 
 * <p>线程安全的 Bot 名称缓存</p>
 * <p>由 Python 后端在 WebSocket 连接时通过 init_config 消息初始化</p>
 */
public class BotRegistry implements IBotRegistry {
    
    private static final Logger logger = MCServant.log();
    
    /** 线程安全的 Bot 名称集合 */
    private final Set<String> botNames = ConcurrentHashMap.newKeySet();
    
    @Override
    public void registerBot(String botName) {
        botNames.add(botName);
        logger.info("[BotRegistry] Registered: " + botName);
    }
    
    @Override
    public void unregisterBot(String botName) {
        botNames.remove(botName);
        logger.info("[BotRegistry] Unregistered: " + botName);
    }
    
    @Override
    public boolean isBot(String playerName) {
        return botNames.contains(playerName);
    }
    
    @Override
    public void clear() {
        botNames.clear();
        logger.info("[BotRegistry] Cleared all registrations");
    }
    
    /**
     * 获取当前注册的 Bot 数量 (调试用)
     */
    public int size() {
        return botNames.size();
    }
}
