package com.mcservant.registry;

/**
 * Bot 注册表接口
 * 
 * <p>设计原则：简单接口，深度功能</p>
 * <p>职责：维护已知 Bot 名称集合，供其他模块查询</p>
 */
public interface IBotRegistry {
    
    /**
     * 注册一个 Bot 名称
     * 
     * @param botName Bot 名称
     */
    void registerBot(String botName);
    
    /**
     * 取消注册
     * 
     * @param botName Bot 名称
     */
    void unregisterBot(String botName);
    
    /**
     * 检查某玩家是否为已注册的 Bot
     * 
     * @param playerName 玩家名称
     * @return 是否为 Bot
     */
    boolean isBot(String playerName);
    
    /**
     * 清空所有注册
     */
    void clear();
}
