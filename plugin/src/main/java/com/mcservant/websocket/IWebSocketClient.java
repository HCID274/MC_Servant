package com.mcservant.websocket;

/**
 * WebSocket 客户端抽象接口
 * 
 * <p>设计原则：简单接口，深度功能，依赖抽象而非具体</p>
 * 
 * <p>业务代码依赖此接口，不依赖具体的 OkHttp 实现</p>
 */
public interface IWebSocketClient {

    /**
     * 连接到 WebSocket 服务器
     * 
     * @param url WebSocket 服务器地址 (如 ws://localhost:8765/ws/plugin)
     */
    void connect(String url);

    /**
     * 设置访问 Token（用于 WebSocket 鉴权）
     *
     * @param token 访问 Token
     */
    void setAccessToken(String token);

    /**
     * 断开连接
     */
    void disconnect();

    /**
     * 发送消息
     * 
     * @param message JSON 格式的消息字符串
     * @return true 如果消息已排队发送，false 如果未连接
     */
    boolean send(String message);

    /**
     * 检查是否已连接
     * 
     * @return true 如果 WebSocket 连接已建立
     */
    boolean isConnected();

    /**
     * 设置消息接收回调
     * 
     * @param callback 消息接收时的回调处理器
     */
    void setMessageCallback(MessageCallback callback);

    /**
     * 消息回调接口
     */
    @FunctionalInterface
    interface MessageCallback {
        /**
         * 收到消息时调用
         * 
         * @param message 收到的 JSON 消息
         */
        void onMessage(String message);
    }
}
