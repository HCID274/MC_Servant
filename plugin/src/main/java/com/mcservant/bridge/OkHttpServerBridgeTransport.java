package com.mcservant.bridge;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.JsonSyntaxException;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import org.jetbrains.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

/**
 * 基于 OkHttp 的桥接传输实现。
 *
 * <p>连接打开后立即发送应用层 hello 帧，并定时发送 heartbeat 帧；access token 只放入
 * Authorization header，不进入 JSON 消息体或普通日志。
 *
 * <p>此实现类是 {@link ServerBridgeTransport} 的唯一 OkHttp 落点；业务代码不得
 * 直接 import OkHttp 类型，必须通过接口访问。
 */
public final class OkHttpServerBridgeTransport implements ServerBridgeTransport {

    private static final Logger LOGGER = LoggerFactory.getLogger(OkHttpServerBridgeTransport.class);
    private static final Gson GSON = new Gson();
    private static final String PROTOCOL_VERSION = "server-bridge.v1";

    private final ServerBridgeConfig config;
    private final OkHttpClient httpClient;
    private final AtomicReference<ConnectionState> state = new AtomicReference<>(ConnectionState.DISCONNECTED);
    private final AtomicLong heartbeatSequence = new AtomicLong(0L);
    private final AtomicLong reconnectDelaySeconds;
    private final ScheduledExecutorService heartbeatExecutor;
    private volatile boolean disconnectRequested = false;

    @Nullable
    private volatile WebSocket socket;

    @Nullable
    private volatile ScheduledFuture<?> heartbeatTask;

    @Nullable
    private volatile ScheduledFuture<?> reconnectTask;

    public OkHttpServerBridgeTransport(ServerBridgeConfig config) {
        this.config = Objects.requireNonNull(config, "config 不可为空");
        this.httpClient = new OkHttpClient.Builder()
                .pingInterval(config.heartbeatIntervalSeconds(), TimeUnit.SECONDS)
                .build();
        this.reconnectDelaySeconds = new AtomicLong(config.reconnectInitialDelaySeconds());
        this.heartbeatExecutor = Executors.newSingleThreadScheduledExecutor(new HeartbeatThreadFactory());
    }

    @Override
    public void connect() {
        if (!config.enabled()) {
            LOGGER.info("[Bridge] 桥接未启用，跳过 connect()");
            return;
        }
        ConnectionState currentState = state.get();
        if (currentState == ConnectionState.AUTH_FAILED || currentState == ConnectionState.PROTOCOL_INCOMPATIBLE) {
            LOGGER.warn("[Bridge] 当前状态 {}，忽略 connect()，请修正配置或协议版本后重启服务端", currentState);
            return;
        }
        if (currentState != ConnectionState.DISCONNECTED && currentState != ConnectionState.RECONNECTING) {
            LOGGER.warn("[Bridge] 当前状态 {}，忽略重复 connect()", currentState);
            return;
        }
        if (!state.compareAndSet(currentState, ConnectionState.CONNECTING)) {
            return;
        }

        try {
            disconnectRequested = false;
            Request request = new Request.Builder()
                    .url(config.url())
                    .header("Authorization", "Bearer " + config.accessToken())
                    .build();
            socket = httpClient.newWebSocket(request, new BridgeListener());
        } catch (RuntimeException e) {
            state.set(ConnectionState.DISCONNECTED);
            LOGGER.warn("[Bridge] WebSocket 连接启动失败: {}", sanitize(e.getMessage()));
            scheduleReconnect("connect_start_failed");
        }
    }

    @Override
    public void disconnect() {
        disconnectRequested = true;
        stopHeartbeat();
        cancelReconnect();
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

    @Override
    public boolean sendPlayerMessage(String messageId, String playerUuid, String playerName, String content) {
        Objects.requireNonNull(messageId, "messageId 不可为空");
        Objects.requireNonNull(playerUuid, "playerUuid 不可为空");
        Objects.requireNonNull(playerName, "playerName 不可为空");
        Objects.requireNonNull(content, "content 不可为空");
        if (state.get() != ConnectionState.CONNECTED) {
            return false;
        }
        return send(GSON.toJson(playerMessageFrame(messageId, playerUuid, playerName, content)));
    }

    private Map<String, Object> playerMessageFrame(
            String messageId,
            String playerUuid,
            String playerName,
            String content
    ) {
        Map<String, Object> frame = new LinkedHashMap<>();
        frame.put("type", "player_message");
        frame.put("protocol_version", PROTOCOL_VERSION);
        frame.put("instance_id", config.instanceId());
        frame.put("message_id", messageId);
        frame.put("player_uuid", playerUuid);
        frame.put("player_name", playerName);
        frame.put("content", content);
        frame.put("timestamp", Instant.now().toString());
        return frame;
    }

    private boolean sendHello(WebSocket webSocket) {
        boolean sent = sendProtocolFrame(webSocket, helloFrame());
        if (sent) {
            LOGGER.info("[Bridge] hello 握手帧已发送 (protocol={}, mod={}, version={}, instance={})",
                    PROTOCOL_VERSION,
                    config.modId(),
                    config.modVersion(),
                    config.instanceId()
            );
            return true;
        } else {
            failConnection("hello 握手帧发送失败", true);
            return false;
        }
    }

    private Map<String, Object> helloFrame() {
        Map<String, Object> frame = new LinkedHashMap<>();
        frame.put("type", "hello");
        frame.put("protocol_version", PROTOCOL_VERSION);
        frame.put("mod_id", config.modId());
        frame.put("mod_version", config.modVersion());
        frame.put("connected_at", Instant.now().toString());
        frame.put("instance_id", config.instanceId());
        return frame;
    }

    private Map<String, Object> heartbeatFrame(long sequence) {
        Map<String, Object> frame = new LinkedHashMap<>();
        frame.put("type", "heartbeat");
        frame.put("protocol_version", PROTOCOL_VERSION);
        frame.put("instance_id", config.instanceId());
        frame.put("sequence", sequence);
        frame.put("timestamp", Instant.now().toString());
        frame.put("state", state.get().name());
        return frame;
    }

    private boolean sendProtocolFrame(WebSocket webSocket, Map<String, Object> frame) {
        return webSocket.send(GSON.toJson(frame));
    }

    private void startHeartbeat(WebSocket webSocket) {
        stopHeartbeat();
        heartbeatSequence.set(0L);
        long interval = config.heartbeatIntervalSeconds();
        heartbeatTask = heartbeatExecutor.scheduleAtFixedRate(() -> {
            long sequence = heartbeatSequence.incrementAndGet();
            boolean sent = state.get() == ConnectionState.CONNECTED
                    && sendProtocolFrame(webSocket, heartbeatFrame(sequence));
            if (!sent) {
                failConnection("heartbeat 心跳帧发送失败 sequence=" + sequence, true);
            }
        }, interval, interval, TimeUnit.SECONDS);
        LOGGER.info("[Bridge] 应用层 heartbeat 已启动 (interval={}s)", interval);
    }

    private void stopHeartbeat() {
        ScheduledFuture<?> current = heartbeatTask;
        if (current != null) {
            current.cancel(false);
            heartbeatTask = null;
        }
    }

    private void failConnection(String message, boolean reconnect) {
        stopHeartbeat();
        WebSocket current = socket;
        if (current != null) {
            current.close(1011, "heartbeat failure");
        }
        state.set(ConnectionState.DISCONNECTED);
        LOGGER.warn("[Bridge] {}", sanitize(message));
        if (reconnect) {
            scheduleReconnect(message);
        }
    }

    private void scheduleReconnect(String reason) {
        if (disconnectRequested || !config.enabled()) {
            return;
        }
        ConnectionState currentState = state.get();
        if (currentState == ConnectionState.AUTH_FAILED || currentState == ConnectionState.PROTOCOL_INCOMPATIBLE) {
            return;
        }
        if (reconnectTask != null && !reconnectTask.isDone()) {
            state.set(ConnectionState.RECONNECTING);
            return;
        }

        long delay = reconnectDelaySeconds.get();
        state.set(ConnectionState.RECONNECTING);
        LOGGER.warn("[Bridge] 将在 {} 秒后重连 TS Core（原因: {}）", delay, sanitize(reason));
        reconnectTask = heartbeatExecutor.schedule(() -> {
            reconnectTask = null;
            state.compareAndSet(ConnectionState.RECONNECTING, ConnectionState.DISCONNECTED);
            connect();
        }, delay, TimeUnit.SECONDS);
        reconnectDelaySeconds.set(Math.min(delay * 2L, config.reconnectMaxDelaySeconds()));
    }

    private void cancelReconnect() {
        ScheduledFuture<?> current = reconnectTask;
        if (current != null) {
            current.cancel(false);
            reconnectTask = null;
        }
    }

    private void markAuthenticatedFailure(String message) {
        stopHeartbeat();
        cancelReconnect();
        state.set(ConnectionState.AUTH_FAILED);
        LOGGER.warn("[Bridge] TS Core 拒绝桥接鉴权: {}", sanitize(message));
    }

    private void markProtocolIncompatible(String message) {
        stopHeartbeat();
        cancelReconnect();
        state.set(ConnectionState.PROTOCOL_INCOMPATIBLE);
        LOGGER.warn("[Bridge] TS Core 协议不兼容: {}", sanitize(message));
    }

    private String sanitize(String value) {
        if (value == null || value.isBlank()) {
            return "(无详细信息)";
        }
        return value.replace(config.accessToken(), "[redacted]");
    }

    private final class BridgeListener extends WebSocketListener {
        @Override
        public void onOpen(WebSocket webSocket, Response response) {
            LOGGER.info("[Bridge] WebSocket 已打开 (HTTP {})，等待 hello ack", response.code());
            sendHello(webSocket);
        }

        @Override
        public void onMessage(WebSocket webSocket, String text) {
            ServerFrame frame = parseServerFrame(text);
            LOGGER.info("[Bridge] 收到服务端帧 type={}", frame.type());

            if ("ack".equals(frame.type()) && "hello".equals(frame.ackType())) {
                state.set(ConnectionState.CONNECTED);
                reconnectDelaySeconds.set(config.reconnectInitialDelaySeconds());
                LOGGER.info("[Bridge] hello ack 已确认，桥接进入 CONNECTED");
                startHeartbeat(webSocket);
                return;
            }

            if ("error".equals(frame.type())) {
                if ("protocol_version_mismatch".equals(frame.code())) {
                    markProtocolIncompatible(frame.message());
                    webSocket.close(4001, "protocol_version_mismatch");
                    return;
                }
                if ("unauthorized".equals(frame.code())) {
                    markAuthenticatedFailure(frame.message());
                    webSocket.close(4003, "unauthorized");
                    return;
                }
                LOGGER.warn("[Bridge] TS Core 返回错误帧 code={}, message={}", sanitize(frame.code()), sanitize(frame.message()));
            }
        }

        @Override
        public void onClosing(WebSocket webSocket, int code, String reason) {
            stopHeartbeat();
            if (state.get() != ConnectionState.AUTH_FAILED
                    && state.get() != ConnectionState.PROTOCOL_INCOMPATIBLE) {
                state.set(ConnectionState.CLOSING);
            }
        }

        @Override
        public void onClosed(WebSocket webSocket, int code, String reason) {
            stopHeartbeat();
            ConnectionState currentState = state.get();
            if (currentState == ConnectionState.AUTH_FAILED
                    || currentState == ConnectionState.PROTOCOL_INCOMPATIBLE) {
                LOGGER.info("[Bridge] WebSocket 已关闭 (code={}, reason={})", code, sanitize(reason));
                return;
            }
            if (!disconnectRequested) {
                state.set(ConnectionState.DISCONNECTED);
                scheduleReconnect("closed code=" + code + " reason=" + reason);
            } else {
                state.set(ConnectionState.DISCONNECTED);
            }
            LOGGER.info("[Bridge] WebSocket 已关闭 (code={}, reason={})", code, sanitize(reason));
        }

        @Override
        public void onFailure(WebSocket webSocket, Throwable t, @Nullable Response response) {
            stopHeartbeat();
            int code = response == null ? -1 : response.code();
            if (code == 401) {
                markAuthenticatedFailure("HTTP 401 unauthorized");
                return;
            }
            if (!disconnectRequested) {
                state.set(ConnectionState.DISCONNECTED);
                scheduleReconnect("failure HTTP " + code);
            } else {
                state.set(ConnectionState.DISCONNECTED);
            }
            LOGGER.warn("[Bridge] WebSocket 失败 (HTTP {}): {}", code, sanitize(t.getMessage()));
        }

        private ServerFrame parseServerFrame(String text) {
            try {
                JsonObject frame = JsonParser.parseString(text).getAsJsonObject();
                String type = readString(frame, "type", "unknown");
                String ackType = readString(frame, "ack_type", "");
                String code = readString(frame, "code", "");
                String message = readString(frame, "message", "");
                return new ServerFrame(sanitize(type), sanitize(ackType), sanitize(code), sanitize(message));
            } catch (IllegalStateException | JsonSyntaxException ignored) {
                return new ServerFrame("unparseable", "", "", "");
            }
        }

        private String readString(JsonObject frame, String key, String fallback) {
            if (frame.has(key) && frame.get(key).isJsonPrimitive()) {
                return frame.get(key).getAsString();
            }
            return fallback;
        }
    }

    private record ServerFrame(String type, String ackType, String code, String message) {
    }

    private static final class HeartbeatThreadFactory implements ThreadFactory {
        @Override
        public Thread newThread(Runnable runnable) {
            Thread thread = new Thread(runnable, "mcservant-bridge-heartbeat");
            thread.setDaemon(true);
            return thread;
        }
    }
}
