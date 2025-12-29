package com.mcservant;

import com.mcservant.commands.ServantCommands;
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

    @Override
    public void onEnable() {
        instance = this;
        logger = getLogger();

        // 初始化 WebSocket
        initWebSocket();
        
        // 初始化命令
        initCommands();

        logger.info("MC_Servant 插件已启用! (v" + getDescription().getVersion() + ")");
    }

    @Override
    public void onDisable() {
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
}

