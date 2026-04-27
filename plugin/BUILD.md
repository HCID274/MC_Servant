# MCServant Fabric mod 构建指南

## 平台 & 工具链

- **目标 MC 版本**：1.20.4
- **Java**：17（Fabric Loom 1.6-SNAPSHOT，当前解析为 1.6.12 + JDK 17 工具链；MC 1.20.4 服务端运行也要求 Java 17）
- **构建工具**：Gradle Wrapper 8.7 + Fabric Loom 1.6-SNAPSHOT（当前解析为 1.6.12）
- **依赖锁定来源**：`gradle.properties`（与 `ts-core/Docs/01_ARCHITECTURE.md` §2.6.1 一致）

## 快速编译

```bash
cd plugin
./gradlew build
```

仓库已提交 Gradle Wrapper（`gradlew` / `gradlew.bat` / `gradle/wrapper/**`），验收与本地复测统一使用：

```bash
cd plugin
./gradlew build
```

## 输出产物

构建成功后，最终 mod jar 位于：

```
plugin/build/libs/mcservant-0.4.0.jar
```

同目录还会产出 `mcservant-0.4.0-sources.jar`（源码包，可选）。

## 部署到 Fabric 服务器

```bash
cp plugin/build/libs/mcservant-0.4.0.jar /path/to/server/mods/
```

重启 Fabric 服务端（不能 `/reload`，Fabric 不支持热重载 mod）。日志应出现：

```
[MCServant] Fabric mod 已加载 — 服务端桥接骨架就绪 (T-039 基线)
```

## 服务器侧前置依赖

`mods/` 目录中必须同时存在：

- `fabric-api-0.97.3+1.20.4.jar`（或更高同 MC 版本兼容版）
- 可选：`fabric-permissions-api-v0-0.3.1.jar`（如需 LuckPerms 集成；不装则自动回退 op 等级）

如缺少 `fabric-api`，Fabric Loader 会因 `fabric.mod.json` 中的 `depends.fabric-api` 拒绝加载本 mod。

## 常见排错

- **`./gradlew` 提示找不到 wrapper jar**：确认 `plugin/gradle/wrapper/gradle-wrapper.jar` 已随仓库同步。
- **`Could not resolve net.fabricmc.fabric-api:fabric-api`**：检查 Maven 镜像 / 网络代理；`build.gradle` 已声明 `https://maven.fabricmc.net/`。
- **运行时 `NoClassDefFoundError: okhttp3/...` / `okio/...` / `kotlin/...`**：确认构建产物为 Loom（Fabric 构建插件） `include`（嵌入） 处理后的 `mcservant-*.jar`，而不是 `dev` jar（开发产物）；OkHttp（网络客户端）、Okio（输入输出库） 与 Kotlin stdlib（Kotlin 标准库） 运行时依赖应同时嵌入。

---

*最后更新：2026-04-27（T-039 Fabric 工程基线落地）*
