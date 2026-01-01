package com.mcservant.listener;

import com.mcservant.gui.ServantMenuGUI;
import org.bukkit.entity.Entity;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.inventory.InventoryClickEvent;
import org.bukkit.event.player.PlayerInteractEntityEvent;
import org.bukkit.inventory.EquipmentSlot;

/**
 * 玩家交互监听器
 * 
 * 监听右键 NPC 事件，打开管理 GUI
 */
public class PlayerInteractListener implements Listener {
    
    // Bot 玩家名 (后续可配置化)
    // TODO: 从配置文件读取，支持多个 Bot
    private static final String BOT_USERNAME = "MCServant_Bot";
    
    @EventHandler
    public void onPlayerInteractEntity(PlayerInteractEntityEvent event) {
        // 只处理主手交互
        if (event.getHand() != EquipmentSlot.HAND) {
            return;
        }
        
        Entity target = event.getRightClicked();
        Player player = event.getPlayer();
        
        // 检查是否是 Bot
        if (target instanceof Player botPlayer) {
            if (isBotPlayer(botPlayer.getName())) {
                event.setCancelled(true);
                openServantMenu(player, botPlayer.getName());
            }
        }
    }
    
    @EventHandler
    public void onInventoryClick(InventoryClickEvent event) {
        if (event.getInventory().getHolder() instanceof ServantMenuGUI gui) {
            gui.handleClick(event);
        }
    }
    
    /**
     * 检查是否是 Bot 玩家
     */
    private boolean isBotPlayer(String playerName) {
        // TODO: 从后端获取所有 Bot 列表进行匹配
        return BOT_USERNAME.equalsIgnoreCase(playerName);
    }
    
    /**
     * 打开女仆管理菜单
     */
    private void openServantMenu(Player player, String botName) {
        ServantMenuGUI gui = new ServantMenuGUI(player, botName);
        gui.open();
    }
}
