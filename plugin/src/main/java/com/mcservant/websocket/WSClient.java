package com.mcservant.websocket;

import com.mcservant.MCServant;
import okhttp3.*;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.logging.Logger;

/**
 * OkHttp WebSocket 客户端实现
 * 
 * <p>功能：
 * <ul>
 *   <li>WebSocket 连接管理</li>
 *   <li>心跳保活 (30秒间隔)</li>
 *   <li>自动重连 (最多5次，5秒间隔)</li>
 *   <li>线程安全</li>
 * </ul>
 * </p>
 */
public class WSClient implements IWebSocketClient {

    private static final Logger logger = MCServant.log();
    
    // 配置常量
    private static final int HEARTBEAT_INTERVAL_SECONDS = 30;
    private static final int BASE_RECONNECT_DELAY_SECONDS = 5;
    private static final int MAX_RECONNECT_DELAY_SECONDS = 30;
    private static final int MAX_RECONNECT_ATTEMPTS = -1;  // -1 = 无限重试
    
    // OkHttp 客户端（复用以提高性能）
    private final OkHttpClient httpClient;
    
    // WebSocket 实例
    private WebSocket webSocket;
    
    // 状态
    private final AtomicBoolean connected = new AtomicBoolean(false);
    private final AtomicInteger reconnectAttempts = new AtomicInteger(0);
    private String serverUrl;
    
    // 回调
    private MessageCallback messageCallback;

    public WSClient() {
        this.httpClient = new OkHttpClient.Builder()
            .readTimeout(0, TimeUnit.MILLISECONDS)  // 禁用读超时（WebSocket 长连接）
            .pingInterval(HEARTBEAT_INTERVAL_SECONDS, TimeUnit.SECONDS)  // 自动心跳
            .build();
    }

    @Override
    public void connect(String url) {
        if (connected.get()) {
            logger.warning("WebSocket already connected");
            return;
        }
        
        this.serverUrl = url;
        reconnectAttempts.set(0);
        doConnect();
    }
    
    private void doConnect() {
        Request request = new Request.Builder()
            .url(serverUrl)
            .build();
        
        webSocket = httpClient.newWebSocket(request, new WebSocketListener() {
            @Override
            public void onOpen(@NotNull WebSocket webSocket, @NotNull Response response) {
                connected.set(true);
                reconnectAttempts.set(0);
                logger.info("WebSocket connected to: " + serverUrl);
            }

            @Override
            public void onMessage(@NotNull WebSocket webSocket, @NotNull String text) {
                logger.fine("WebSocket received: " + text);
                if (messageCallback != null) {
                    // 在主线程调用回调
                    MCServant.getInstance().getServer().getScheduler().runTask(
                        MCServant.getInstance(),
                        () -> messageCallback.onMessage(text)
                    );
                }
            }

            @Override
            public void onClosing(@NotNull WebSocket webSocket, int code, @NotNull String reason) {
                logger.info("WebSocket closing: " + code + " - " + reason);
                webSocket.close(1000, null);
            }

            @Override
            public void onClosed(@NotNull WebSocket webSocket, int code, @NotNull String reason) {
                connected.set(false);
                logger.info("WebSocket closed: " + code + " - " + reason);
            }

            @Override
            public void onFailure(@NotNull WebSocket webSocket, @NotNull Throwable t, @Nullable Response response) {
                connected.set(false);
                logger.warning("WebSocket failure: " + t.getMessage());
                
                // 尝试重连
                scheduleReconnect();
            }
        });
    }
    
    private void scheduleReconnect() {
        int attempts = reconnectAttempts.incrementAndGet();
        
        // MAX_RECONNECT_ATTEMPTS = -1 表示无限重试
        if (MAX_RECONNECT_ATTEMPTS > 0 && attempts > MAX_RECONNECT_ATTEMPTS) {
            logger.severe("Max reconnect attempts reached, giving up");
            return;
        }
        
        // 指数退避：5s -> 10s -> 20s -> 30s (max)
        int delay = Math.min(
            BASE_RECONNECT_DELAY_SECONDS * (1 << Math.min(attempts - 1, 3)),  // 2^attempts, 最多 2^3=8 倍
            MAX_RECONNECT_DELAY_SECONDS
        );
        
        logger.info("WebSocket 连接失败，将在 " + delay + " 秒后重试 (第 " + attempts + " 次)");
        
        // 使用 Bukkit 调度器延迟重连
        MCServant.getInstance().getServer().getScheduler().runTaskLaterAsynchronously(
            MCServant.getInstance(),
            this::doConnect,
            delay * 20L  // 转换为 ticks
        );
    }

    @Override
    public void disconnect() {
        if (webSocket != null) {
            webSocket.close(1000, "Plugin disabled");
            webSocket = null;
        }
        connected.set(false);
        logger.info("WebSocket disconnected");
    }

    @Override
    public boolean send(String message) {
        if (!connected.get() || webSocket == null) {
            logger.warning("Cannot send message: WebSocket not connected");
            return false;
        }
        
        boolean sent = webSocket.send(message);
        if (sent) {
            logger.fine("WebSocket sent: " + message);
        } else {
            logger.warning("Failed to send WebSocket message");
        }
        return sent;
    }

    @Override
    public boolean isConnected() {
        return connected.get();
    }

    @Override
    public void setMessageCallback(MessageCallback callback) {
        this.messageCallback = callback;
    }
}
