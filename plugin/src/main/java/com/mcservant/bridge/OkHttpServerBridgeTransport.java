package com.mcservant.bridge;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import org.jetbrains.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.Objects;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/**
 * 基于 OkHttp 的桥接传输骨架。
 *
 * <p>T-039 仅交付最小可装配骨架：能创建 OkHttp 客户端、按配置发起 WebSocket 连接、
 * 暴露状态查询和 send / disconnect。真实握手帧、协议握手、心跳应答与重连退避策略
 * 由后续 T-Fabric-Bridge-02 实现。
 *
 * <p>此实现类是 {@link ServerBridgeTransport} 的唯一 OkHttp 落点；业务代码不得
 * 直接 import OkHttp 类型，必须通过接口访问。
 */
public final class OkHttpServerBridgeTransport implements ServerBridgeTransport {

    private static final Logger LOGGER = LoggerFactory.getLogger(OkHttpServerBridgeTransport.class);

    private final ServerBridgeConfig config;
    private final OkHttpClient httpClient;
    private final AtomicReference<ConnectionState> state = new AtomicReference<>(ConnectionState.DISCONNECTED);

    @Nullable
    private volatile WebSocket socket;

    public OkHttpServerBridgeTransport(ServerBridgeConfig config) {
        this.config = Objects.requireNonNull(config, "config 不可为空");
        this.httpClient = new OkHttpClient.Builder()
                .pingInterval(config.heartbeatIntervalSeconds(), TimeUnit.SECONDS)
                .build();
    }

    @Override
    public void connect() {
        if (!config.enabled()) {
            LOGGER.info("[Bridge] 桥接未启用，跳过 connect()");
            return;
        }
        if (!state.compareAndSet(ConnectionState.DISCONNECTED, ConnectionState.CONNECTING)) {
            LOGGER.warn("[Bridge] 当前状态 {}，忽略重复 connect()", state.get());
            return;
        }

        Request request = new Request.Builder()
                .url(config.url())
                .header("Authorization", "Bearer " + config.accessToken())
                .build();

        socket = httpClient.newWebSocket(request, new SkeletonListener());
    }

    @Override
    public void disconnect() {
        ConnectionState prev = state.getAndSet(ConnectionState.CLOSING);
        if (prev == ConnectionState.DISCONNECTED) {
            state.set(ConnectionState.DISCONNECTED);
            return;
        }
        WebSocket current = socket;
        if (current != null) {
            current.close(1000, "client shutdown");
        }
        socket = null;
        state.set(ConnectionState.DISCONNECTED);
    }

    @Override
    public boolean send(String message) {
        if (state.get() != ConnectionState.CONNECTED) {
            return false;
        }
        WebSocket current = socket;
        return current != null && current.send(message);
    }

    @Override
    public ConnectionState state() {
        return state.get();
    }

    private final class SkeletonListener extends WebSocketListener {
        @Override
        public void onOpen(WebSocket webSocket, Response response) {
            state.set(ConnectionState.CONNECTED);
            LOGGER.info("[Bridge] WebSocket 已连接 (HTTP {})", response.code());
        }

        @Override
        public void onClosing(WebSocket webSocket, int code, String reason) {
            state.set(ConnectionState.CLOSING);
        }

        @Override
        public void onClosed(WebSocket webSocket, int code, String reason) {
            state.set(ConnectionState.DISCONNECTED);
            LOGGER.info("[Bridge] WebSocket 已关闭 (code={}, reason={})", code, reason);
        }

        @Override
        public void onFailure(WebSocket webSocket, Throwable t, @Nullable Response response) {
            state.set(ConnectionState.DISCONNECTED);
            LOGGER.warn("[Bridge] WebSocket 失败: {}", t.getMessage());
        }
    }
}
