package com.mcservant.hologram;

import java.util.List;

/**
 * 全息显示服务接口
 * 
 * <p>设计原则：依赖抽象而非具体实现</p>
 * <p>职责：定义 Bot 头顶全息的管理契约</p>
 */
public interface IHologramService {
    
    /**
     * 更新 Bot 头顶的状态全息
     * 
     * <p>如果全息不存在则自动创建</p>
     * 
     * @param botName Bot 名称
     * @param statusText 状态文本 (如 "💭 思考中...")
     */
    void updateHologram(String botName, String statusText);
    
    /**
     * 更新状态全息（说话时只更新缓存，不打断对话）
     * 
     * @param botName Bot 名称
     * @param statusText 状态文本
     */
    void updateHologramStatus(String botName, String statusText);
    
    /**
     * 开始分段展示对话内容
     * 
     * @param botName Bot 名称
     * @param segments 分段内容列表
     */
    void startChatSegments(String botName, List<String> segments);
    
    /**
     * 设置 Bot 的身份行 (顶部固定行)
     * 
     * @param botName Bot 名称
     * @param ownerName 主人名称 (可为 null 表示无主)
     */
    void setIdentity(String botName, String ownerName);
    
    /**
     * 移除指定 Bot 的全息
     * 
     * @param botName Bot 名称
     */
    void removeHologram(String botName);
    
    /**
     * 移除所有托管的全息
     */
    void removeAll();
    
    /**
     * 检查指定 Bot 是否已有全息
     * 
     * @param botName Bot 名称
     * @return 是否存在
     */
    boolean exists(String botName);
    
    /**
     * 隐藏玩家的默认名牌
     * 
     * <p>使用 Scoreboard Team 实现</p>
     * 
     * @param botName Bot 名称
     */
    void hideNameplate(String botName);
}
