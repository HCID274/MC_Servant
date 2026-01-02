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
 * <p>布局结构（从上到下）：</p>
 * <ul>
 *   <li>Line 0: 聊天内容第一行</li>
 *   <li>Line 1: 聊天内容第二行</li>
 *   <li>Line 2: ID 显示 (固定)</li>
 * </ul>
 * 
 * <p>分段展示：每 5 秒切换一个 segment，说话时状态更新只缓存不打断</p>
 */
public class HologramManager implements IHologramService {
    
    private static final Logger logger = MCServant.log();
    
    /** 全息名称前缀 (避免与其他插件冲突) */
    private static final String HOLOGRAM_PREFIX = "mcservant_";
    
    /** 隐藏名牌的记分板 Team 名称 */
    private static final String HIDE_NAMETAG_TEAM = "mcservant_hide";
    
    /** 高度偏移 (提高原点让 ID 行在头顶) */
    private static final double HEIGHT_OFFSET = 2.9;
    
    /** 跟随任务间隔 (ticks) */
    private static final int FOLLOW_INTERVAL_TICKS = 5;
    
    /** 每行最大字符数 */
    private static final int LINE_WIDTH = 25;
    
    /** 最大聊天行数 */
    private static final int MAX_CHAT_LINES = 2;
    
    /** 分段展示间隔 (5秒 = 100 ticks) */
    private static final int SEGMENT_DURATION_TICKS = 100;
    
    /** 默认状态文本 */
    private static final String DEFAULT_STATUS = "§7待命中...";
    
    /** Bot 名称 -> 全息实例映射 */
    private final Map<String, Hologram> holograms = new ConcurrentHashMap<>();
    
    /** Bot 名称 -> 当前说话任务 */
    private final Map<String, BukkitTask> chatTasks = new ConcurrentHashMap<>();
    
    /** Bot 名称 -> 当前分段索引 */
    private final Map<String, Integer> segmentIndex = new ConcurrentHashMap<>();
    
    /** Bot 名称 -> 缓存的状态文本 (分段结束后恢复) */
    private final Map<String, String> cachedStatus = new ConcurrentHashMap<>();
    
    /** 跟随任务 */
    private BukkitTask followTask;
    
    /** 插件实例 */
    private final MCServant plugin;
    
    public HologramManager(MCServant plugin) {
        this.plugin = plugin;
        startFollowTask();
        logger.info("HologramManager initialized (interval: " + FOLLOW_INTERVAL_TICKS + " ticks, layout: chat-above-id)");
    }
    
    @Override
    public void updateHologram(String botName, String statusText) {
        // 确保在主线程执行
        if (!Bukkit.isPrimaryThread()) {
            Bukkit.getScheduler().runTask(plugin, () -> updateHologram(botName, statusText));
            return;
        }
        
        String text = (statusText != null && !statusText.isEmpty()) ? statusText : DEFAULT_STATUS;
        cachedStatus.put(botName, text);
        
        // 如果正在说话，不打断
        if (chatTasks.containsKey(botName)) {
            return;
        }
        
        updateChatLines(botName, text);
    }
    
    @Override
    public void updateHologramStatus(String botName, String statusText) {
        // 确保在主线程执行
        if (!Bukkit.isPrimaryThread()) {
            Bukkit.getScheduler().runTask(plugin, () -> updateHologramStatus(botName, statusText));
            return;
        }
        
        String text = (statusText != null && !statusText.isEmpty()) ? statusText : DEFAULT_STATUS;
        
        // 1. 更新缓存
        cachedStatus.put(botName, text);
        
        // 2. 如果正在说话，不打断，等说完自动读取缓存
        if (chatTasks.containsKey(botName)) {
            logger.fine("Status cached during speech: " + botName + " -> " + text);
            return;
        }
        
        // 3. 没在说话，直接更新显示
        updateChatLines(botName, text);
    }
    
    @Override
    public void startChatSegments(String botName, List<String> segments) {
        // 确保在主线程执行
        if (!Bukkit.isPrimaryThread()) {
            Bukkit.getScheduler().runTask(plugin, () -> startChatSegments(botName, segments));
            return;
        }
        
        // 取消旧任务
        BukkitTask oldTask = chatTasks.remove(botName);
        if (oldTask != null) {
            oldTask.cancel();
        }
        
        if (segments == null || segments.isEmpty()) {
            String status = cachedStatus.getOrDefault(botName, DEFAULT_STATUS);
            updateChatLines(botName, status);
            return;
        }
        
        // 复制列表避免外部修改影响
        final List<String> segmentsCopy = new ArrayList<>(segments);
        final int totalSegments = segmentsCopy.size();
        
        segmentIndex.put(botName, 0);
        
        // 立即显示第一段
        updateChatLines(botName, segmentsCopy.get(0));
        logger.info("Chat segments started: " + botName + " (" + totalSegments + " segments)");
        
        if (totalSegments == 1) {
            // 只有一段，5秒后恢复状态
            scheduleResetTask(botName);
            return;
        }
        
        // 多段内容，启动定时切换
        BukkitTask task = Bukkit.getScheduler().runTaskTimer(plugin, new Runnable() {
            @Override
            public void run() {
                int currentIdx = segmentIndex.getOrDefault(botName, 0);
                int nextIdx = currentIdx + 1;
                
                if (nextIdx >= totalSegments) {
                    // 最后一段已展示完毕，取消当前任务并恢复状态
                    BukkitTask currentTask = chatTasks.remove(botName);
                    if (currentTask != null) {
                        currentTask.cancel();
                    }
                    segmentIndex.remove(botName);
                    scheduleResetTask(botName);
                    return;
                }
                
                // 显示下一段
                segmentIndex.put(botName, nextIdx);
                updateChatLines(botName, segmentsCopy.get(nextIdx));
                logger.info("Segment " + (nextIdx + 1) + "/" + totalSegments + " for " + botName);
            }
        }, SEGMENT_DURATION_TICKS, SEGMENT_DURATION_TICKS);
        
        chatTasks.put(botName, task);
    }
    
    /**
     * 分段展示结束后恢复缓存状态
     */
    private void scheduleResetTask(String botName) {
        Bukkit.getScheduler().runTaskLater(plugin, () -> {
            // 如果此时又开始了新的说话任务，不要覆盖
            if (chatTasks.containsKey(botName)) {
                return;
            }
            String status = cachedStatus.getOrDefault(botName, DEFAULT_STATUS);
            updateChatLines(botName, status);
            logger.fine("Chat ended, restored status: " + botName + " -> " + status);
        }, SEGMENT_DURATION_TICKS);
    }
    
    /**
     * 更新聊天行 (Line 0-1)
     */
    private void updateChatLines(String botName, String text) {
        try {
            Hologram hologram = holograms.get(botName);
            
            if (hologram == null) {
                hologram = createHologramForBot(botName);
                if (hologram == null) {
                    return;
                }
            }
            
            // 分割文本为最多 2 行
            List<String> lines = wrapText(text);
            
            // 确保有 3 行结构
            int currentLineCount = hologram.getPage(0).getLines().size();
            while (currentLineCount < 3) {
                DHAPI.addHologramLine(hologram, "");
                currentLineCount++;
            }
            
            // Line 0: 第一行聊天
            DHAPI.setHologramLine(hologram, 0, lines.size() > 0 ? lines.get(0) : "");
            // Line 1: 第二行聊天（可能为空）
            DHAPI.setHologramLine(hologram, 1, lines.size() > 1 ? lines.get(1) : "");
            // Line 2: ID 行由 setIdentity 管理，这里不动
            
        } catch (Exception e) {
            logger.warning("Chat line update failed for " + botName + ": " + e.getMessage());
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
        
        // 按字符分割
        int start = 0;
        while (start < text.length() && lines.size() < MAX_CHAT_LINES) {
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
            hologram = createHologramForBot(botName);
            if (hologram == null) return;
        }
        
        // 确保有 3 行
        int currentLineCount = hologram.getPage(0).getLines().size();
        while (currentLineCount < 3) {
            DHAPI.addHologramLine(hologram, "");
            currentLineCount++;
        }
        
        // 更新身份行 (Line 2)
        String identityLine;
        if (ownerName != null && !ownerName.isEmpty()) {
            identityLine = "§e<§6" + ownerName + "§e的女仆>";
        } else {
            identityLine = "§7[ §b" + botName + " §7]";
        }
        
        DHAPI.setHologramLine(hologram, 2, identityLine);
    }
    
    @Override
    public void removeHologram(String botName) {
        // 确保在主线程执行
        if (!Bukkit.isPrimaryThread()) {
            Bukkit.getScheduler().runTask(plugin, () -> removeHologram(botName));
            return;
        }
        
        // 取消说话任务
        BukkitTask task = chatTasks.remove(botName);
        if (task != null) {
            task.cancel();
        }
        
        // 清理缓存
        segmentIndex.remove(botName);
        cachedStatus.remove(botName);
        
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
        
        // 取消所有说话任务
        for (BukkitTask task : chatTasks.values()) {
            task.cancel();
        }
        chatTasks.clear();
        segmentIndex.clear();
        cachedStatus.clear();
        
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
        Player bot = Bukkit.getPlayer(botName);
        
        if (bot == null || !bot.isOnline()) {
            logger.fine("Player not found or offline: " + botName);
            return null;
        }
        
        try {
            Location loc = bot.getLocation().clone().add(0, HEIGHT_OFFSET, 0);
            String holoName = HOLOGRAM_PREFIX + botName;
            
            if (DHAPI.getHologram(holoName) != null) {
                DHAPI.removeHologram(holoName);
            }
            
            Hologram hologram = DHAPI.createHologram(holoName, loc, false);
            
            // 创建 3 行结构 (chat-above-id 布局)
            DHAPI.addHologramLine(hologram, "");                         // Line 0: 聊天行1
            DHAPI.addHologramLine(hologram, DEFAULT_STATUS);             // Line 1: 聊天行2/状态
            DHAPI.addHologramLine(hologram, "§7[ §b" + botName + " §7]"); // Line 2: ID
            
            holograms.put(botName, hologram);
            logger.info("Hologram created: " + botName + " (chat-above-id layout)");
            
            return hologram;
        } catch (Exception e) {
            logger.warning("Failed to create hologram for " + botName + ": " + e.getMessage());
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
