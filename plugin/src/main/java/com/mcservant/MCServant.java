package com.mcservant;

import com.mcservant.commands.ServantCommands;
import com.mcservant.hologram.HologramManager;
import com.mcservant.hologram.IHologramService;
import com.mcservant.listener.PlayerConnectionListener;
import com.mcservant.listener.PlayerInteractListener;
import com.mcservant.registry.BotRegistry;
import com.mcservant.registry.IBotRegistry;
import com.mcservant.websocket.IWebSocketClient;
import com.mcservant.websocket.WSClient;
import com.mcservant.websocket.MessageHandler;
import org.bukkit.plugin.java.JavaPlugin;

import java.util.logging.Logger;

/**
 * MC_Servant 插件主类
 * 
 * <p>设计原则：简单接口，深度功能，依赖抽象而非具体</p>
 * 
 * <p>职责：
 * <ul>
 *   <li>插件生命周期管理</li>
 *   <li>模块初始化与注册</li>
 *   <li>提供全局访问点</li>
 * </ul>
 * </p>
 */
public class MCServant extends JavaPlugin {

    private static MCServant instance;
    private static Logger logger;
    
    // WebSocket 客户端
    private IWebSocketClient wsClient;
    
    // 全息管理器
    private IHologramService hologramManager;
    
    // Bot 注册表
    private IBotRegistry botRegistry;
    
    // 配置
    private static final String WS_URL = "ws://localhost:8765/ws/plugin";

    /**
     * 获取插件实例（单例模式）
     */
    public static MCServant getInstance() {
        return instance;
    }

    /**
     * 获取插件日志记录器
     */
    public static Logger log() {
        return logger;
    }
    
    /**
     * 获取 WebSocket 客户端
     */
    public IWebSocketClient getWsClient() {
        return wsClient;
    }
    
    /**
     * 获取全息管理器
     */
    public IHologramService getHologramManager() {
        return hologramManager;
    }
    
    /**
     * 获取 Bot 注册表
     */
    public IBotRegistry getBotRegistry() {
        return botRegistry;
    }

    @Override
    public void onEnable() {
        instance = this;
        logger = getLogger();
        
        // 初始化 Bot 注册表
        botRegistry = new BotRegistry();

        // 初始化全息管理器
        initHolograms();
        
        // 初始化 WebSocket
        initWebSocket();
        
        // 初始化命令
        initCommands();
        
        // 注册监听器
        initListeners();

        logger.info("MC_Servant 插件已启用! (v" + getDescription().getVersion() + ")");
    }

    @Override
    public void onDisable() {
        // 清理全息
        if (hologramManager != null) {
            hologramManager.removeAll();
            hologramManager = null;
        }
        
        // 关闭 WebSocket 连接
        if (wsClient != null) {
            wsClient.disconnect();
            wsClient = null;
        }
        
        logger.info("MC_Servant 插件已禁用!");
        instance = null;
    }

    /**
     * 初始化 WebSocket 连接
     */
    private void initWebSocket() {
        wsClient = new WSClient();
        wsClient.setMessageCallback(new MessageHandler());
        
        // 异步连接，避免阻塞主线程
        getServer().getScheduler().runTaskAsynchronously(this, () -> {
            wsClient.connect(WS_URL);
        });
        
        logger.info("WebSocket 模块已初始化 (目标: " + WS_URL + ")");
    }

    /**
     * 初始化命令模块
     */
    private void initCommands() {
        ServantCommands.register();
        logger.info("命令模块已加载");
    }
    
    /**
     * 初始化监听器模块
     */
    private void initListeners() {
        getServer().getPluginManager().registerEvents(new PlayerInteractListener(), this);
        getServer().getPluginManager().registerEvents(new PlayerConnectionListener(), this);
        logger.info("监听器模块已加载");
    }
    
    /**
     * 初始化全息管理模块
     */
    private void initHolograms() {
        try {
            hologramManager = new HologramManager(this);
            logger.info("全息管理模块已加载");
        } catch (NoClassDefFoundError e) {
            logger.warning("DecentHolograms 插件未安装，全息功能已禁用");
            hologramManager = null;
        }
    }
}

