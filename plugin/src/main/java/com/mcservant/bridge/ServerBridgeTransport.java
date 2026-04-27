package com.mcservant.bridge;

/**
 * 服务端桥接传输接口（mod -> TS Core 单核心）。
 *
 * <p>业务代码只能依赖此接口，不得感知 OkHttp / Netty / java.net.http 等具体实现。
 * 这是 01_ARCHITECTURE.md §2.6.1 "Transport 隔离约束" 在 mod 端的对应实现。
 */
public interface ServerBridgeTransport {

    /**
     * 启动连接。实现方应当是非阻塞的（异步发起握手）。
     * 当配置为禁用时，调用应当为 no-op，不抛异常。
     */
    void connect();

    /**
     * 关闭连接并释放底层资源。可重复调用（幂等）。
     */
    void disconnect();

    /**
     * 发送一帧文本消息。
     *
     * @param message 待发送的字符串
     * @return 真正进入底层发送队列返回 true；若当前未连接或发送失败返回 false（不抛异常）
     */
    boolean send(String message);

    /**
     * 当前连接状态查询。仅供日志 / 健康检查使用，不承担互斥语义。
     */
    ConnectionState state();

    /** 桥接连接状态 */
    enum ConnectionState {
        /** 未连接（初始 / 已断开） */
        DISCONNECTED,
        /** 握手中 */
        CONNECTING,
        /** 已连接，可发送 */
        CONNECTED,
        /** 主动关闭中 */
        CLOSING
    }
}
