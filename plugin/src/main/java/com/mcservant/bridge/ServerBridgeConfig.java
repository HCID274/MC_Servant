package com.mcservant.bridge;

import java.util.Objects;

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
 */
public record ServerBridgeConfig(
        boolean enabled,
        String url,
        String accessToken,
        long heartbeatIntervalSeconds
) {

    /** 本地开发占位 URL（不写真实生产地址） */
    public static final String LOCAL_DEV_URL = "ws://127.0.0.1:8765/ws/server-bridge";

    /** 本地开发占位令牌（不是真实密钥；任何部署必须覆盖） */
    public static final String PLACEHOLDER_TOKEN = "REPLACE_WITH_LOCAL_DEV_TOKEN";

    /** 心跳默认 30 秒 */
    public static final long DEFAULT_HEARTBEAT_SECONDS = 30L;

    public ServerBridgeConfig {
        Objects.requireNonNull(url, "url 不可为空");
        Objects.requireNonNull(accessToken, "accessToken 不可为空(占位令牌也算有值)");
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
                DEFAULT_HEARTBEAT_SECONDS
        );
    }
}
