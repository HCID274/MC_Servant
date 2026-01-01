package com.mcservant.gui;

import com.alibaba.fastjson2.JSONObject;
import com.mcservant.MCServant;
import com.mcservant.websocket.IWebSocketClient;
import org.bukkit.Bukkit;
import org.bukkit.Material;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.inventory.InventoryClickEvent;
import org.bukkit.inventory.Inventory;
import org.bukkit.inventory.InventoryHolder;
import org.bukkit.inventory.ItemStack;
import org.bukkit.inventory.meta.ItemMeta;

import java.util.Arrays;
import java.util.List;

/**
 * 女仆管理 GUI 菜单
 * 
 * 9格菜单布局:
 * [对话] [任务] [状态]
 * [设置] [释放] [空]
 */
public class ServantMenuGUI implements InventoryHolder, Listener {
    
    private final Inventory inventory;
    private final String botName;
    private final Player owner;
    
    // 菜单项位置
    private static final int SLOT_CHAT = 0;
    private static final int SLOT_TASK = 1;
    private static final int SLOT_STATUS = 2;
    private static final int SLOT_SETTINGS = 3;
    private static final int SLOT_RELEASE = 4;
    
    public ServantMenuGUI(Player owner, String botName) {
        this.owner = owner;
        this.botName = botName;
        this.inventory = Bukkit.createInventory(this, 9, "§d" + botName + " §7的管理面板");
        
        initializeItems();
    }
    
    private void initializeItems() {
        // 对话
        inventory.setItem(SLOT_CHAT, createItem(
            Material.WRITABLE_BOOK,
            "§a💬 对话",
            "§7点击打开聊天输入",
            "§7输入 /svs <消息> 与女仆对话"
        ));
        
        // 任务
        inventory.setItem(SLOT_TASK, createItem(
            Material.GOLDEN_PICKAXE,
            "§e🔨 下达任务",
            "§7让女仆执行任务",
            "§7例: 帮我盖房子、去挖矿"
        ));
        
        // 状态
        inventory.setItem(SLOT_STATUS, createItem(
            Material.COMPASS,
            "§b📊 查询状态",
            "§7查看女仆当前状态",
            "§7位置、任务进度等"
        ));
        
        // 设置
        inventory.setItem(SLOT_SETTINGS, createItem(
            Material.COMPARATOR,
            "§6⚙ 设置",
            "§7配置女仆",
            "§7(功能开发中)"
        ));
        
        // 释放
        inventory.setItem(SLOT_RELEASE, createItem(
            Material.BARRIER,
            "§c🔓 释放女仆",
            "§7解除认领",
            "§c注意: 女仆将变为无主状态"
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
        owner.openInventory(inventory);
    }
    
    /**
     * 处理点击事件
     */
    public void handleClick(InventoryClickEvent event) {
        event.setCancelled(true); // 禁止拿取物品
        
        if (!(event.getWhoClicked() instanceof Player player)) {
            return;
        }
        
        int slot = event.getSlot();
        
        switch (slot) {
            case SLOT_CHAT -> {
                player.closeInventory();
                player.sendMessage("§a[" + botName + "] §f请使用 §e/svs <消息>§f 与我对话~");
            }
            case SLOT_TASK -> {
                player.closeInventory();
                player.sendMessage("§a[" + botName + "] §f请告诉我你想让我做什么？");
                player.sendMessage("§7例: /svs 帮我盖一个小木屋");
            }
            case SLOT_STATUS -> {
                player.closeInventory();
                sendCommandToBackend(player, "status");
            }
            case SLOT_SETTINGS -> {
                player.sendMessage("§e[MC_Servant] §f设置功能开发中...");
            }
            case SLOT_RELEASE -> {
                player.closeInventory();
                sendCommandToBackend(player, "release");
            }
        }
    }
    
    private void sendCommandToBackend(Player player, String command) {
        IWebSocketClient wsClient = MCServant.getInstance().getWsClient();
        
        if (wsClient == null || !wsClient.isConnected()) {
            player.sendMessage("§c[MC_Servant] §f后端服务未连接");
            return;
        }
        
        JSONObject message = new JSONObject();
        message.put("type", "servant_command");
        message.put("player", player.getName());
        message.put("player_uuid", player.getUniqueId().toString());
        message.put("command", command);
        message.put("target_bot", botName);
        message.put("timestamp", System.currentTimeMillis() / 1000);
        
        wsClient.send(message.toJSONString());
    }
    
    public String getBotName() {
        return botName;
    }
}
