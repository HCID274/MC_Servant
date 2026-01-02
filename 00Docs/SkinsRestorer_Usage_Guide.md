# SkinsRestorer 使用指南

## 环境

- **代理服务器**：Velocity 3.4.0-SNAPSHOT
- **皮肤插件**：SkinsRestorer 15.9.1
- **权限插件**：LuckPerms-Velocity 5.5.22

---

## 一、权限配置

### 1. 安装 LuckPerms Velocity 版本

由于 SkinsRestorer 安装在 Velocity 代理上，需要在 Velocity 层面管理权限。Paper/Spigot 服务器上的权限插件无法管理 Velocity 插件的权限。

下载地址：https://luckperms.net/download（选择 Velocity 版本）

将 `LuckPerms-Velocity-x.x.x.jar` 放入 `/root/velocity/plugins/` 目录，然后重启 Velocity。

### 2. 添加权限

> ⚠️ **重要**：Velocity 版本的 LuckPerms 命令前缀是 `lpv`，不是 `lp`！

在 **Velocity 控制台** 执行以下命令：

```bash
# 给完整管理员权限（推荐）
lpv user <玩家名> permission set skinsrestorer.admin true

# 或者单独添加权限
lpv user <玩家名> permission set skinsrestorer.command.set.other true
lpv user <玩家名> permission set skinsrestorer.admincommand.createcustom true
```

### 3. 权限节点参考

| 权限节点 | 说明 |
|---------|------|
| `skinsrestorer.admin` | 完整管理员权限（包含所有 /sr 命令）|
| `skinsrestorer.command.set.other` | 允许给其他玩家设置皮肤 |
| `skinsrestorer.admincommand.createcustom` | 允许创建自定义皮肤 |
| `skinsrestorer.player` | 基本玩家权限（默认已启用） |
| `skinsrestorer.bypasscooldown` | 绕过冷却时间 |

---

## 二、创建自定义皮肤

### ⚠️ 重要：只支持 URL 形式

本地 PNG 文件上传**不被直接支持**，必须通过 URL 创建皮肤。

### 操作步骤

1. **上传皮肤图片到 MineSkin**
   
   访问 https://mineskin.org 上传你的皮肤 PNG 文件，获取 URL。

2. **使用命令创建自定义皮肤**
   
   ```bash
   /sr createcustom <皮肤名称> "<URL>" [classic/slim]
   ```
   
   示例：
   ```bash
   /sr createcustom petalu "https://minesk.in/bbd3af8158924c079bf3899388f41eec" slim
   ```

3. **给玩家设置皮肤**
   
   ```bash
   /skin set <皮肤名称> <玩家名>
   ```
   
   示例：
   ```bash
   /skin set petalu MCServant_Bot
   ```

---

## 三、常见问题

### Q: 为什么 `lp` 命令显示 "This command does not exist"？
A: 在 Velocity 控制台需要使用 `lpv` 命令，不是 `lp`。

### Q: 为什么在 Paper 服务器上设置权限无效？
A: SkinsRestorer 安装在 Velocity 代理上，权限需要在 Velocity 层面通过 LuckPerms-Velocity 管理。

### Q: 为什么使用 `file:xxx.png` 提示"正版玩家不存在"？
A: `/sr createcustom` 命令不支持本地文件路径，只支持 URL。请先将皮肤上传到 https://mineskin.org 获取 URL。

---

*记录时间：2025-12-30*
