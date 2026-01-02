package com.mcservant.hologram;

import com.mcservant.MCServant;
import eu.decentsoftware.holograms.api.DHAPI;
import eu.decentsoftware.holograms.api.holograms.Hologram;
import org.bukkit.Bukkit;
import org.bukkit.Location;
import org.bukkit.entity.Player;
import org.bukkit.scheduler.BukkitTask;
import org.bukkit.scoreboard.Scoreboard;
import org.bukkit.scoreboard.Team;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.logging.Logger;

/**
 * 全息显示管理器 - DecentHolograms API 封装
 * 
 * <p>设计原则：
 * <ul>
 *   <li>线程安全：所有 Bukkit/DHAPI 操作调度回主线程</li>
 *   <li>动态映射：通过 Bot 名称动态管理全息</li>
 *   <li>双行显示：Line 0 身份 + Line 1 状态</li>
 * </ul>
 * </p>
 * 
 * <p>技术参数：
 * <ul>
 *   <li>跟随频率：2 ticks (0.1秒)</li>
 *   <li>高度偏移：Y + 2.3</li>
 * </ul>
 * </p>
 */
public class HologramManager implements IHologramService {
    
    private static final Logger logger = MCServant.log();
    
    /** 全息名称前缀 (避免与其他插件冲突) */
    private static final String HOLOGRAM_PREFIX = "mcservant_";
    
    /** 隐藏名牌的记分板 Team 名称 */
    private static final String HIDE_NAMETAG_TEAM = "mcservant_hide";
    
    /** 高度偏移 (超过 ID 名牌高度) */
    private static final double HEIGHT_OFFSET = 2.5;
    
    /** 跟随任务间隔 (ticks) */
    private static final int FOLLOW_INTERVAL_TICKS = 5;
    
    /** 每行最大字符数 */
    private static final int LINE_WIDTH = 25;
    
    /** 最大状态行数 (Line 0 是身份，从 Line 1 开始是状态) */
    private static final int MAX_STATUS_LINES = 4;
    
    /** 默认状态文本 */
    private static final String DEFAULT_STATUS = "§7待命中...";
    
    /** Bot 名称 -> 全息实例映射 */
    private final Map<String, Hologram> holograms = new ConcurrentHashMap<>();
    
    /** 跟随任务 */
    private BukkitTask followTask;
    
    /** 插件实例 */
    private final MCServant plugin;
    
    public HologramManager(MCServant plugin) {
        this.plugin = plugin;
        startFollowTask();
        logger.info("HologramManager initialized (interval: " + FOLLOW_INTERVAL_TICKS + " ticks)");
    }
    
    @Override
    public void updateHologram(String botName, String statusText) {
        // 确保在主线程执行
        if (!Bukkit.isPrimaryThread()) {
            Bukkit.getScheduler().runTask(plugin, () -> updateHologram(botName, statusText));
            return;
        }
        
        try {
            Hologram hologram = holograms.get(botName);
            
            if (hologram == null) {
                hologram = createHologramForBot(botName);
                if (hologram == null) {
                    return;
                }
            }
            
            String text = (statusText != null && !statusText.isEmpty()) ? statusText : DEFAULT_STATUS;
            
            // 分割文本为多行
            List<String> lines = wrapText(text);
            
            // 获取当前全息行数 (通过 HologramPage)
            int currentLineCount = hologram.getPage(0).getLines().size();
            int neededLines = 1 + lines.size();  // 1 for identity + status lines
            
            // 调整全息行数
            while (currentLineCount < neededLines) {
                DHAPI.addHologramLine(hologram, "");
                currentLineCount++;
            }
            while (currentLineCount > neededLines) {
                DHAPI.removeHologramLine(hologram, currentLineCount - 1);
                currentLineCount--;
            }
            
            // 更新状态行 (Line 1, 2, 3...)
            for (int i = 0; i < lines.size(); i++) {
                DHAPI.setHologramLine(hologram, i + 1, lines.get(i));
            }
            
            logger.fine(String.format("Hologram updated: %s, %d lines", botName, neededLines));
        } catch (Exception e) {
            logger.warning("Hologram update failed for " + botName + ": " + e.getMessage());
            holograms.remove(botName);
        }
    }
    
    /**
     * 将文本按指定宽度分割为多行
     */
    private List<String> wrapText(String text) {
        List<String> lines = new ArrayList<>();
        if (text == null || text.isEmpty()) {
            lines.add(DEFAULT_STATUS);
            return lines;
        }
        
        // 按字符分割，不打断词语
        int start = 0;
        while (start < text.length() && lines.size() < MAX_STATUS_LINES) {
            int end = Math.min(start + LINE_WIDTH, text.length());
            lines.add(text.substring(start, end));
            start = end;
        }
        
        // 如果还有剩余文本，在最后一行加省略号
        if (start < text.length() && !lines.isEmpty()) {
            String lastLine = lines.get(lines.size() - 1);
            if (lastLine.length() > 3) {
                lines.set(lines.size() - 1, lastLine.substring(0, lastLine.length() - 3) + "...");
            }
        }
        
        return lines;
    }
    
    @Override
    public void setIdentity(String botName, String ownerName) {
        // 确保在主线程执行
        if (!Bukkit.isPrimaryThread()) {
            Bukkit.getScheduler().runTask(plugin, () -> setIdentity(botName, ownerName));
            return;
        }
        
        Hologram hologram = holograms.get(botName);
        if (hologram == null) {
            return;
        }
        
        // 更新身份行 (Line 0)
        String identityLine;
        if (ownerName != null && !ownerName.isEmpty()) {
            identityLine = "§e<§6" + ownerName + "§e的女仆>";
        } else {
            identityLine = "§7[ §b" + botName + " §7]";
        }
        
        DHAPI.setHologramLine(hologram, 0, identityLine);
    }
    
    @Override
    public void removeHologram(String botName) {
        // 确保在主线程执行
        if (!Bukkit.isPrimaryThread()) {
            Bukkit.getScheduler().runTask(plugin, () -> removeHologram(botName));
            return;
        }
        
        Hologram hologram = holograms.remove(botName);
        if (hologram != null) {
            hologram.delete();
            logger.info("Hologram removed: " + botName);
        }
    }
    
    @Override
    public void removeAll() {
        // 确保在主线程执行
        if (!Bukkit.isPrimaryThread()) {
            Bukkit.getScheduler().runTask(plugin, this::removeAll);
            return;
        }
        
        // 停止跟随任务
        if (followTask != null) {
            followTask.cancel();
            followTask = null;
        }
        
        // 删除所有全息
        for (Hologram hologram : holograms.values()) {
            hologram.delete();
        }
        holograms.clear();
        
        logger.info("All holograms removed");
    }
    
    @Override
    public boolean exists(String botName) {
        return holograms.containsKey(botName);
    }
    
    /**
     * 为指定 Bot 创建全息
     * 
     * @param botName Bot 名称
     * @return 创建的全息实例，若玩家不在线则返回 null
     */
    private Hologram createHologramForBot(String botName) {
        logger.info(String.format("[DEBUG] createHologramForBot('%s')", botName));
        
        Player bot = Bukkit.getPlayer(botName);
        
        logger.info("[DEBUG] 当前在线玩家: " + Bukkit.getOnlinePlayers().stream()
            .map(Player::getName).toList());
        
        if (bot == null || !bot.isOnline()) {
            logger.warning(String.format("[DEBUG] 玩家 '%s' 不存在或离线", botName));
            return null;
        }
        
        try {
            // 注意：名牌隐藏由 PlayerConnectionListener 在 join 时处理
            
            Location loc = bot.getLocation().clone().add(0, HEIGHT_OFFSET, 0);
            String holoName = HOLOGRAM_PREFIX + botName;
            
            if (DHAPI.getHologram(holoName) != null) {
                DHAPI.removeHologram(holoName);
            }
            
            Hologram hologram = DHAPI.createHologram(holoName, loc, false);
            
            // 添加初始行
            DHAPI.addHologramLine(hologram, "§7[ §b" + botName + " §7]");  // Line 0: 身份
            DHAPI.addHologramLine(hologram, DEFAULT_STATUS);               // Line 1: 状态
            
            holograms.put(botName, hologram);
            logger.info(String.format("[DEBUG] 全息创建成功: %s", botName));
            
            return hologram;
        } catch (Exception e) {
            logger.warning("[DEBUG] 创建全息失败 for " + botName + ": " + e.getMessage());
            e.printStackTrace();
            return null;
        }
    }
    
    /**
     * 隐藏玩家默认名牌 (使用 Scoreboard Team)
     */
    @Override
    public void hideNameplate(String botName) {
        if (!Bukkit.isPrimaryThread()) {
            Bukkit.getScheduler().runTask(plugin, () -> hideNameplate(botName));
            return;
        }
        
        Player player = Bukkit.getPlayer(botName);
        if (player == null) {
            logger.warning("[hideNameplate] Player not found: " + botName);
            return;
        }
        
        try {
            Scoreboard scoreboard = Bukkit.getScoreboardManager().getMainScoreboard();
            Team team = scoreboard.getTeam(HIDE_NAMETAG_TEAM);
            
            if (team == null) {
                team = scoreboard.registerNewTeam(HIDE_NAMETAG_TEAM);
                team.setOption(Team.Option.NAME_TAG_VISIBILITY, Team.OptionStatus.NEVER);
                logger.info("Created nametag hide team: " + HIDE_NAMETAG_TEAM);
            }
            
            if (!team.hasEntry(player.getName())) {
                team.addEntry(player.getName());
                logger.info("Hidden nameplate for: " + player.getName());
            }
        } catch (Exception e) {
            logger.warning("Failed to hide nameplate: " + e.getMessage());
        }
    }
    
    /**
     * 启动全息跟随任务
     * 
     * <p>每 2 ticks 更新所有全息位置，跟随 Bot 移动</p>
     */
    private void startFollowTask() {
        followTask = Bukkit.getScheduler().runTaskTimer(plugin, () -> {
            try {
                for (Map.Entry<String, Hologram> entry : holograms.entrySet()) {
                    String botName = entry.getKey();
                    Hologram hologram = entry.getValue();
                    
                    Player bot = Bukkit.getPlayer(botName);
                    if (bot != null && bot.isOnline()) {
                        // 更新全息位置
                        Location newLoc = bot.getLocation().clone().add(0, HEIGHT_OFFSET, 0);
                        DHAPI.moveHologram(hologram, newLoc);
                    }
                }
            } catch (Exception e) {
                logger.warning("Error in hologram follow task: " + e.getMessage());
            }
        }, FOLLOW_INTERVAL_TICKS, FOLLOW_INTERVAL_TICKS);
    }
}
