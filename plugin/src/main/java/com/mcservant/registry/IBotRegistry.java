package com.mcservant.registry;

/**
 * Bot 注册表接口
 * 
 * <p>设计原则：简单接口，深度功能</p>
 * <p>职责：维护已知 Bot 名称集合及所有权信息</p>
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
    
    /**
     * 获取 Bot 主人 UUID
     * 
     * @param botName Bot 名称
     * @return 主人 UUID，无主返回 null
     */
    String getOwnerUuid(String botName);
    
    /**
     * 获取 Bot 主人名称
     * 
     * @param botName Bot 名称
     * @return 主人名称，无主返回 null
     */
    String getOwnerName(String botName);
    
    /**
     * 设置 Bot 主人信息
     * 
     * @param botName Bot 名称
     * @param ownerUuid 主人 UUID (null 表示释放)
     * @param ownerName 主人名称
     */
    void setOwner(String botName, String ownerUuid, String ownerName);
}
