package com.mcservant.listener;

import com.mcservant.MCServant;
import com.mcservant.gui.ClaimMenuGUI;
import com.mcservant.gui.ServantMenuGUI;
import com.mcservant.registry.IBotRegistry;
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
 * <p>监听右键 NPC 事件，根据所有权打开不同 GUI</p>
 */
public class PlayerInteractListener implements Listener {
    
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
            String botName = botPlayer.getName();
            IBotRegistry registry = MCServant.getInstance().getBotRegistry();
            
            if (registry != null && registry.isBot(botName)) {
                event.setCancelled(true);
                
                String ownerUuid = registry.getOwnerUuid(botName);
                String playerUuid = player.getUniqueId().toString();
                
                if (ownerUuid == null || ownerUuid.isEmpty()) {
                    // 无主 Bot → 打开认领菜单
                    new ClaimMenuGUI(player, botName).open();
                } else if (ownerUuid.equals(playerUuid)) {
                    // 是主人 → 打开管理菜单
                    new ServantMenuGUI(player, botName).open();
                } else {
                    // 不是主人 → 提示
                    String ownerName = registry.getOwnerName(botName);
                    player.sendMessage("§e[MC_Servant] §f这是 §6" + ownerName + " §f的女仆");
                }
            }
        }
    }
    
    @EventHandler
    public void onInventoryClick(InventoryClickEvent event) {
        if (event.getInventory().getHolder() instanceof ServantMenuGUI gui) {
            gui.handleClick(event);
        } else if (event.getInventory().getHolder() instanceof ClaimMenuGUI gui) {
            event.setCancelled(true);
            if (event.getWhoClicked() instanceof Player clicker) {
                gui.handleClick(event.getSlot(), clicker);
            }
        }
    }
}
