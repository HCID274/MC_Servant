package com.mcservant.gui;

import com.alibaba.fastjson2.JSONObject;
import com.mcservant.MCServant;
import com.mcservant.websocket.IWebSocketClient;
import org.bukkit.Bukkit;
import org.bukkit.Material;
import org.bukkit.entity.Player;
import org.bukkit.inventory.Inventory;
import org.bukkit.inventory.InventoryHolder;
import org.bukkit.inventory.ItemStack;
import org.bukkit.inventory.meta.ItemMeta;

import java.util.Arrays;

/**
 * 无主女仆认领菜单
 * 
 * <p>当玩家右键无主 Bot 时显示此简化菜单</p>
 */
public class ClaimMenuGUI implements InventoryHolder {
    
    private final Inventory inventory;
    private final String botName;
    private final Player player;
    
    /** 认领按钮位置 (中间) */
    private static final int SLOT_CLAIM = 4;
    
    public ClaimMenuGUI(Player player, String botName) {
        this.player = player;
        this.botName = botName;
        this.inventory = Bukkit.createInventory(this, 9, "§d认领 " + botName);
        initializeItems();
    }
    
    private void initializeItems() {
        // 认领按钮（中间大位置）
        inventory.setItem(SLOT_CLAIM, createItem(
            Material.DIAMOND,
            "§a✨ 认领这位女仆",
            "§7点击认领 §e" + botName,
            "",
            "§7目前：§a免费",
            "§8(未来将接入经济系统)"
        ));
    }
    
    private ItemStack createItem(Material material, String name, String... lore) {
        ItemStack item = new ItemStack(material);
        ItemMeta meta = item.getItemMeta();
        if (meta != null) {
            meta.setDisplayName(name);
            if (lore.length > 0) {
                meta.setLore(Arrays.asList(lore));
            }
            item.setItemMeta(meta);
        }
        return item;
    }
    
    @Override
    public Inventory getInventory() {
        return inventory;
    }
    
    public void open() {
        player.openInventory(inventory);
    }
    
    /**
     * 处理点击事件
     */
    public void handleClick(int slot, Player clicker) {
        if (slot == SLOT_CLAIM) {
            clicker.closeInventory();
            sendClaimCommand(clicker);
        }
    }
    
    private void sendClaimCommand(Player clicker) {
        IWebSocketClient wsClient = MCServant.getInstance().getWsClient();
        
        if (wsClient == null || !wsClient.isConnected()) {
            clicker.sendMessage("§c[MC_Servant] §f后端服务未连接");
            return;
        }
        
        JSONObject message = new JSONObject();
        message.put("type", "servant_command");
        message.put("player", clicker.getName());
        message.put("player_uuid", clicker.getUniqueId().toString());
        message.put("command", "claim");
        message.put("target_bot", botName);
        message.put("timestamp", System.currentTimeMillis() / 1000);
        
        wsClient.send(message.toJSONString());
        clicker.sendMessage("§e[MC_Servant] §f正在认领 " + botName + "...");
    }
    
    public String getBotName() {
        return botName;
    }
}
