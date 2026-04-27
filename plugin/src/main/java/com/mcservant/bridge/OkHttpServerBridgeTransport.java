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
    private final ScheduledExecutorService heartbeatExecutor;

    @Nullable
    private volatile WebSocket socket;

    @Nullable
    private volatile ScheduledFuture<?> heartbeatTask;

    public OkHttpServerBridgeTransport(ServerBridgeConfig config) {
        this.config = Objects.requireNonNull(config, "config 不可为空");
        this.httpClient = new OkHttpClient.Builder()
                .pingInterval(config.heartbeatIntervalSeconds(), TimeUnit.SECONDS)
                .build();
        this.heartbeatExecutor = Executors.newSingleThreadScheduledExecutor(new HeartbeatThreadFactory());
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

        try {
            Request request = new Request.Builder()
                    .url(config.url())
                    .header("Authorization", "Bearer " + config.accessToken())
                    .build();
            socket = httpClient.newWebSocket(request, new BridgeListener());
        } catch (RuntimeException e) {
            state.set(ConnectionState.DISCONNECTED);
            LOGGER.warn("[Bridge] WebSocket 连接启动失败: {}", sanitize(e.getMessage()));
        }
    }

    @Override
    public void disconnect() {
        stopHeartbeat();
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
            failHeartbeat("hello 握手帧发送失败");
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
                failHeartbeat("heartbeat 心跳帧发送失败 sequence=" + sequence);
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

    private void failHeartbeat(String message) {
        stopHeartbeat();
        state.set(ConnectionState.DISCONNECTED);
        WebSocket current = socket;
        if (current != null) {
            current.close(1011, "heartbeat failure");
        }
        LOGGER.warn("[Bridge] {}", sanitize(message));
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
            state.set(ConnectionState.CONNECTED);
            LOGGER.info("[Bridge] WebSocket 已连接 (HTTP {})", response.code());
            if (sendHello(webSocket)) {
                startHeartbeat(webSocket);
            }
        }

        @Override
        public void onMessage(WebSocket webSocket, String text) {
            LOGGER.info("[Bridge] 收到服务端帧 type={}", parseFrameType(text));
        }

        @Override
        public void onClosing(WebSocket webSocket, int code, String reason) {
            stopHeartbeat();
            state.set(ConnectionState.CLOSING);
        }

        @Override
        public void onClosed(WebSocket webSocket, int code, String reason) {
            stopHeartbeat();
            state.set(ConnectionState.DISCONNECTED);
            LOGGER.info("[Bridge] WebSocket 已关闭 (code={}, reason={})", code, sanitize(reason));
        }

        @Override
        public void onFailure(WebSocket webSocket, Throwable t, @Nullable Response response) {
            stopHeartbeat();
            state.set(ConnectionState.DISCONNECTED);
            int code = response == null ? -1 : response.code();
            LOGGER.warn("[Bridge] WebSocket 失败 (HTTP {}): {}", code, sanitize(t.getMessage()));
        }

        private String parseFrameType(String text) {
            try {
                JsonObject frame = JsonParser.parseString(text).getAsJsonObject();
                if (frame.has("type") && frame.get("type").isJsonPrimitive()) {
                    return sanitize(frame.get("type").getAsString());
                }
            } catch (IllegalStateException | JsonSyntaxException ignored) {
                return "unparseable";
            }
            return "unknown";
        }
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
