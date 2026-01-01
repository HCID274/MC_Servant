package com.mcservant.gui;

import com.alibaba.fastjson2.JSONObject;
import com.mcservant.MCServant;
import com.mcservant.websocket.IWebSocketClient;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.event.ClickEvent;
import net.kyori.adventure.text.event.HoverEvent;
import net.kyori.adventure.text.format.NamedTextColor;
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
 * [对话] [状态] [设置]
 * [释放] [空]   [空]
 */
public class ServantMenuGUI implements InventoryHolder, Listener {
    
    private final Inventory inventory;
    private final String botName;
    private final Player owner;
    
    // 菜单项位置
    private static final int SLOT_CHAT = 0;
    private static final int SLOT_STATUS = 1;
    private static final int SLOT_SETTINGS = 2;
    private static final int SLOT_RELEASE = 3;
    
    public ServantMenuGUI(Player owner, String botName) {
        this.owner = owner;
        this.botName = botName;
        this.inventory = Bukkit.createInventory(this, 9, "§d" + botName + " §7的管理面板");
        
        initializeItems();
    }
    
    private void initializeItems() {
        // 对话 (包含对话和下达任务，由 LLM 自动区分)
        inventory.setItem(SLOT_CHAT, createItem(
            Material.WRITABLE_BOOK,
            "§a💬 对话 / 下达任务",
            "§7点击与女仆对话或下达任务",
            "§7由 AI 自动理解你的意图"
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
                
                // 构建预填命令
                String commandSuggestion = "/svs @" + botName + " ";
                
                // 使用 Adventure API 构建可点击消息
                Component message = Component.text()
                    .append(Component.text("[MC_Servant] ", NamedTextColor.GOLD))
                    .append(Component.text("点击此处与 ", NamedTextColor.GREEN))
                    .append(Component.text(botName, NamedTextColor.YELLOW))
                    .append(Component.text(" 对话", NamedTextColor.GREEN))
                    .clickEvent(ClickEvent.suggestCommand(commandSuggestion))
                    .hoverEvent(HoverEvent.showText(Component.text("点击自动填入命令，然后输入你想说的话", NamedTextColor.GRAY)))
                    .build();
                
                player.sendMessage(message);
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
