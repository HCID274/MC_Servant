package com.mcservant.bridge;

import java.util.Objects;
import java.util.Optional;

/**
 * 服务端桥接配置模型。
 *
 * <p>字段对齐 01_ARCHITECTURE.md §2.6.1 锁定选型；默认值仅供本地开发占位，
 * 任何环境部署都必须显式覆盖（特别是 accessToken），禁止把真实密钥写入仓库。
 *
 * @param enabled                     是否启用桥接（false 时 connect() 为 no-op）
 * @param url                         TS Core 单核心 server-bridge WebSocket 地址
 * @param accessToken                 桥接访问令牌（占位令牌仅用于本地开发）
 * @param heartbeatIntervalSeconds    心跳间隔秒数（OkHttp pingInterval 用）
 * @param modId                       mod 标识
 * @param modVersion                  mod 版本
 * @param instanceId                  本地实例标识
 */
public record ServerBridgeConfig(
        boolean enabled,
        String url,
        String accessToken,
        long heartbeatIntervalSeconds,
        String modId,
        String modVersion,
        String instanceId
) {

    /** 本地开发占位 URL（不写真实生产地址） */
    public static final String LOCAL_DEV_URL = "ws://127.0.0.1:8765/ws/server-bridge";

    /** 本地开发占位令牌（不是真实密钥；任何部署必须覆盖） */
    public static final String PLACEHOLDER_TOKEN = "REPLACE_WITH_LOCAL_DEV_TOKEN";

    /** 心跳默认 30 秒 */
    public static final long DEFAULT_HEARTBEAT_SECONDS = 30L;

    /** 默认本地实例标识，部署环境可覆盖 */
    public static final String DEFAULT_INSTANCE_ID = "local-dev";

    private static final String PROP_PREFIX = "mcservant.bridge.";
    private static final String ENV_PREFIX = "MCSERVANT_BRIDGE_";

    public ServerBridgeConfig {
        Objects.requireNonNull(url, "url 不可为空");
        Objects.requireNonNull(accessToken, "accessToken 不可为空(占位令牌也算有值)");
        Objects.requireNonNull(modId, "modId 不可为空");
        Objects.requireNonNull(modVersion, "modVersion 不可为空");
        Objects.requireNonNull(instanceId, "instanceId 不可为空");
        if (heartbeatIntervalSeconds <= 0L) {
            throw new IllegalArgumentException("heartbeatIntervalSeconds 必须为正数");
        }
    }

    /**
     * 本地开发占位默认值：默认 enabled=false，避免未配置时误连。
     */
    public static ServerBridgeConfig localDevDefaults() {
        return new ServerBridgeConfig(
                false,
                LOCAL_DEV_URL,
                PLACEHOLDER_TOKEN,
                DEFAULT_HEARTBEAT_SECONDS,
                "mcservant",
                "dev",
                DEFAULT_INSTANCE_ID
        );
    }

    /**
     * 从 system property / environment variable 读取本地运行时覆盖。
     *
     * <p>system property 优先级高于 environment variable；所有默认值仍保持 enabled=false，
     * 避免开发机或生产服未显式配置时误连外部进程。
     */
    public static ServerBridgeConfig fromRuntimeEnvironment(String modId, String modVersion) {
        ServerBridgeConfig defaults = localDevDefaults();
        return new ServerBridgeConfig(
                parseBoolean(resolve("enabled", "ENABLED").orElse(Boolean.toString(defaults.enabled()))),
                resolve("url", "URL").orElse(defaults.url()),
                resolve("accessToken", "ACCESS_TOKEN").orElse(defaults.accessToken()),
                parsePositiveLong(
                        resolve("heartbeatSeconds", "HEARTBEAT_SECONDS")
                                .or(() -> resolve("heartbeatIntervalSeconds", "HEARTBEAT_INTERVAL_SECONDS"))
                                .orElse(Long.toString(defaults.heartbeatIntervalSeconds()))
                ),
                nonBlank(modId).orElse(defaults.modId()),
                nonBlank(modVersion).orElse(defaults.modVersion()),
                resolve("instanceId", "INSTANCE_ID").orElse(defaults.instanceId())
        );
    }

    /** access token 是否使用了默认占位值。 */
    public boolean usesPlaceholderToken() {
        return PLACEHOLDER_TOKEN.equals(accessToken);
    }

    private static Optional<String> resolve(String propertyName, String environmentName) {
        return nonBlank(System.getProperty(PROP_PREFIX + propertyName))
                .or(() -> nonBlank(System.getenv(ENV_PREFIX + environmentName)));
    }

    private static Optional<String> nonBlank(String value) {
        if (value == null || value.isBlank()) {
            return Optional.empty();
        }
        return Optional.of(value.trim());
    }

    private static boolean parseBoolean(String value) {
        return Boolean.parseBoolean(value.trim());
    }

    private static long parsePositiveLong(String value) {
        long parsed = Long.parseLong(value.trim());
        if (parsed <= 0L) {
            throw new IllegalArgumentException("heartbeat interval 必须为正数");
        }
        return parsed;
    }
}
