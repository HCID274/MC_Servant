package com.mcservant;

import com.mcservant.bridge.OkHttpServerBridgeTransport;
import com.mcservant.bridge.ServerBridgeConfig;
import com.mcservant.bridge.ServerBridgeTransport;
import net.fabricmc.api.DedicatedServerModInitializer;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.loader.api.FabricLoader;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * MCServant Fabric mod 入口（服务端 only）。
 *
 * <p>本类负责声明 mod 已加载、装配 ServerBridgeTransport、在服务端启动 / 停止时
 * 控制桥接传输生命周期。OkHttp 细节只在传输实现类中出现。
 */
public final class MCServantMod implements DedicatedServerModInitializer {

    /** mod 标识，与 fabric.mod.json 一致 */
    public static final String MOD_ID = "mcservant";

    private static final Logger LOGGER = LoggerFactory.getLogger(MOD_ID);

    private static volatile ServerBridgeTransport transport;

    @Override
    public void onInitializeServer() {
        LOGGER.info("[MCServant] Fabric mod 已加载 — 服务端桥接就绪 (T-040)");

        ServerBridgeConfig config = ServerBridgeConfig.fromRuntimeEnvironment(MOD_ID, resolveModVersion());
        transport = new OkHttpServerBridgeTransport(config);

        ServerLifecycleEvents.SERVER_STARTED.register(server -> {
            if (config.enabled()) {
                LOGGER.info(
                        "[MCServant] 桥接已启用 — 目标地址 {}, tokenConfigured={}, placeholderToken={}",
                        config.url(),
                        !config.accessToken().isBlank(),
                        config.usesPlaceholderToken()
                );
                transport.connect();
            } else {
                LOGGER.info("[MCServant] 桥接默认禁用 — 未发起真实连接");
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

    private static String resolveModVersion() {
        return FabricLoader.getInstance()
                .getModContainer(MOD_ID)
                .map(container -> container.getMetadata().getVersion().getFriendlyString())
                .orElse("unknown");
    }
}
