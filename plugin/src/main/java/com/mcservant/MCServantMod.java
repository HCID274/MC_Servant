package com.mcservant;

import com.mcservant.bridge.OkHttpServerBridgeTransport;
import com.mcservant.bridge.ServerBridgeConfig;
import com.mcservant.bridge.ServerBridgeTransport;
import net.fabricmc.api.DedicatedServerModInitializer;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * MCServant Fabric mod 入口（服务端 only）。
 *
 * <p>本类仅承载 T-039 范围：声明 mod 已加载、装配 ServerBridgeTransport 骨架、
 * 在服务端启动 / 停止时输出可观测日志。真实握手 / 心跳 / `/svs` 命令体系由
 * 后续 T-Fabric-Bridge-02 / 03 任务实现。
 */
public final class MCServantMod implements DedicatedServerModInitializer {

    /** mod 标识，与 fabric.mod.json 一致 */
    public static final String MOD_ID = "mcservant";

    private static final Logger LOGGER = LoggerFactory.getLogger(MOD_ID);

    private static volatile ServerBridgeTransport transport;

    @Override
    public void onInitializeServer() {
        LOGGER.info("[MCServant] Fabric mod 已加载 — 服务端桥接骨架就绪 (T-039 基线)");

        ServerBridgeConfig config = ServerBridgeConfig.localDevDefaults();
        transport = new OkHttpServerBridgeTransport(config);

        ServerLifecycleEvents.SERVER_STARTED.register(server -> {
            if (config.enabled()) {
                LOGGER.info("[MCServant] 桥接已启用 — 目标地址 {}", config.url());
                transport.connect();
            } else {
                LOGGER.info("[MCServant] 桥接默认禁用 — 仅加载骨架，未发起真实连接");
            }
        });

        ServerLifecycleEvents.SERVER_STOPPING.register(server -> {
            LOGGER.info("[MCServant] 服务端关闭中，断开桥接传输");
            transport.disconnect();
        });
    }

    /** 只读访问当前桥接传输实例（在 onInitializeServer 之后非空） */
    public static ServerBridgeTransport transport() {
        return transport;
    }
}
