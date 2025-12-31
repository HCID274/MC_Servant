# MC_Servant 插件编译指南

## 快速编译

使用 Maven Wrapper（无需系统安装 Maven）：

```bash
cd MC_Servant/plugin
.\mvnw.cmd clean package -DskipTests
```

## 输出文件

编译后 JAR 位于：
```
target/MC_Servant-1.0.0.jar
```

## 部署到服务器

```bash
# PowerShell
Copy-Item ".\target\MC_Servant-1.0.0.jar" "..\..\MC_Server_1.20.6\plugins\" -Force

# 或手动复制到 MC_Server_1.20.6/plugins/
```

## 重载插件

在 MC 服务器控制台：
```
/reload confirm
```

---

*最后更新: 2025-12-31*
