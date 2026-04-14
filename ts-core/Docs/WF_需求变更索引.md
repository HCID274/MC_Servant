# 需求变更索引

Consultant 每次修改需求文档后在此追加一条。Manager 每次规划任务前先读此文件。

---

（尚无变更记录）

---

## 2026-04-14 — MC 认证真理源确认（EasyAuth + SQLite）

- 来源：用户提供当前 Fabric（服务端核心） 服务器的实际部署信息。
- 已确认事实：
  - 当前离线服认证模组为 EasyAuth（离线服认证模组），不是 AuthMe（认证模组）。
  - 认证存储不是 PostgreSQL（关系型数据库） / `authme schema`（认证模式），而是独立 SQLite（嵌入式数据库） 文件。
  - 配置文件：`/home/hcid274/MC_Fabric_WSL_Server/config/EasyAuth/storage.conf`
  - 库文件：`/home/hcid274/MC_Fabric_WSL_Server/EasyAuth/easyauth.db`
  - 表名：`easyauth`
  - `data` 字段保存 JSON（结构化字符串），其中 `password` 为 bcrypt（哈希） 形式，不能反推明文。
- 影响评估：
  - 当前 `T-010`（本地装配 / 启停骨架） 可继续，不需改握手。
  - `05_DATA_SPEC.md`（数据规格） 中“`authme schema`（认证模式） 只读”的既有假设与现实部署不一致，后续需改写为“外部认证源”表述。
  - 后续涉及 MC（Minecraft） 登录、部署与运行时接入的任务，必须明确“机器人持有自管明文密码并走游戏内登录流程”还是“增加只读认证状态适配器”，不得默认把 EasyAuth（离线服认证模组） 数据迁入 TS Core（TypeScript 单核心） 的 PostgreSQL（关系型数据库） 主业务库。
- 待后续确认：
  - 是否仅把 EasyAuth（离线服认证模组） 视为外部认证源并只做运行时登录适配；
  - 是否需要单独定义一个只读认证适配层，用于查询用户名 / 注册状态 / 最近认证信息；
  - 是否需要在部署文档中记录 EasyAuth（离线服认证模组） 的路径、库结构与运维注意事项。
