# MC_Servant 快速启动指南

## 🚀 启动顺序（重要！）

**必须按以下顺序启动：**

### Step 1: 启动 Minecraft 服务器
```powershell
cd MC_Server_1.20.6
.\start.bat
```
等待看到 `Done (x.xxxs)!` 再进行下一步。

### Step 2: 启动 Python 后端
```powershell
cd MC_Servant
.\start.bat
```
你会看到：
- `Bot XXX connected to xxx:25565` - Bot 连接成功
- `Bot XXX spawned in world` - Bot 进入世界
- `WebSocket server ready` - WebSocket 服务就绪

### Step 3: 进入游戏测试
```
/servant hello
```
Bot 会跳一下并说 "Ciallo~~~~"

---

## 📁 目录结构

```
MC_agent/
├── MC_Server_1.20.6/     # Minecraft 服务器
│   ├── start.bat         # 启动 MC 服务器
│   └── plugins/
│       └── MC_Servant-1.0.0.jar  # Java 插件
│
└── MC_Servant/           # 本项目
    ├── start.bat         # 启动 Python 后端
    ├── backend/          # Python 后端代码
    │   ├── main.py       # FastAPI 入口
    │   ├── config.py     # 配置（MC地址、Bot名称等）
    │   └── bot/          # Mineflayer Bot 实现
    └── plugin/           # Java 插件源码
        └── pom.xml       # Maven 配置
```

---

## ⚙️ 配置说明

编辑 `backend/config.py` 修改以下配置：

```python
# Minecraft 服务器地址
mc_host: str = "mc.hcid274.xyz"  # 改成你的服务器地址
mc_port: int = 25565

# Bot 配置
bot_username: str = "MCServant_Bot"
bot_password: str = "VillagerBot@2025"  # AuthMe 密码
```

---

## 🔧 重新编译插件

如果修改了 Java 代码：

```powershell
cd MC_Servant/plugin
.\mvnw.cmd clean package -DskipTests
```

然后复制 `target/MC_Servant-1.0.0.jar` 到 `MC_Server_1.20.6/plugins/`

---

## ❓ 常见问题

### Q: 显示"后端服务未连接"
A: Java 插件没连上 WebSocket。确保：
1. Python 后端已启动
2. 等待几秒让插件自动重连

### Q: Bot 没有进入服务器
A: 检查 `config.py` 中的服务器地址是否正确，以及 Bot 是否已在服务器白名单/已注册 AuthMe。

### Q: 插件加载失败
A: 检查 `MC_Server_1.20.6/logs/latest.log` 查看具体错误。
