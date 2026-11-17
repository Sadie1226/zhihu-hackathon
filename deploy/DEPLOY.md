# C2 · 本地启动与公网服务器部署

本包提供最小首页、SQLite 引导和 `/api/health`，不实现领养、聊天、出行、搜索或社交功能。
保留 `app/(a)` 至 `app/(e)`；产品视觉由 E 后续接入。

## 当前部署状态

用户已确认暂无云服务器。本次公网部署为 **BLOCKED**，整体为 **PARTIAL**。
本文中的公网地址全部是格式示例，不是已部署地址。systemd 配置已准备，但没有在真实 Linux 服务器加载。
本地验证结果见 `team/2026-11-17/c/1117-c2-公网骨架与部署-v1.md`。

## 本地运行

需要 Node.js 24+ 和 npm，依赖锁定在 package-lock.json。Windows PowerShell 如果阻止 npm.ps1，使用 npm.cmd；不需要降低执行策略。

```bash
node --version
npm install
cp .env.example .env
npm run dev
```

在 Windows 中复制配置可使用 `Copy-Item .env.example .env`。已有 .env 不要覆盖。
C2 不调用知乎，不需要填真实密钥；原有知乎变量继续保留且仅供未来服务端功能使用。
开发地址 `http://localhost:3000/`，健康检查 `http://localhost:3000/api/health`。
开发和生产都监听 `0.0.0.0`；端口由进程环境 PORT 或 `--port` 指定。
Next.js 不从 .env 获取启动端口：需要端口 18080 时，Linux 使用 `PORT=18080 npm run start`，
PowerShell 使用 `$env:PORT='18080'` 后运行 `npm.cmd run start`。
DATABASE_PATH 可以从 .env 加载，相对路径相对于仓库工作目录，默认 `data/app.sqlite`。

```bash
npm run lint
npm run test
npm run build
npm run start
curl --fail http://localhost:3000/
curl --fail http://localhost:3000/api/health
node --env-file-if-exists=.env scripts/c2/check-db.mjs
```

`npm run lint` 使用 ESLint；`npm run test` 包含 C2 数据库/健康检查及现有 C3 自检。
构建执行 TypeScript 检查，`npm run typecheck` 也可独立运行。
生产健康成功体为 `{"ok":true,"service":"zhihu-hackathon","database":"ok"}`。
失败时 HTTP 503，仅返回固定服务名与 unavailable，不返回异常、路径或配置；响应禁止缓存。

## 数据库与版本

- 使用原生 node:sqlite DatabaseSync，无 ORM。数据库只在服务端引用，Next.js 入口受 server-only 保护。
- 每连接开启 foreign_keys，busy_timeout 为 5000ms；请求 WAL，由 SQLite 决定可用日志模式。
- 首次仅对没有用户对象且 application_id/user_version 都为 0 的空 SQLite 库执行 contracts/schema.sql。
- `BEGIN IMMEDIATE` 将空库检查、建表、版本标记和迁移串行化；失败全部回滚。
- 基线为 `PRAGMA user_version=1`，application_id 为 `0x5a484831`，不新增业务表。
- 非空但无版本的旧库、其他应用库、版本比代码新的库、损坏文件均拒绝打开，不删除或自动重建。
- 每个服务进程复用一个成功连接；失败连接不缓存，后续请求可以重试。
- 不自动导入 fixtures，首页不会将 fixture 展示成 live。

后续新增迁移放在 `lib/db/migrations.ts`，从版本 2 按顺序追加，不能修改已经部署的迁移。
只允许经审查的增量 SQL；引导器不从 HTTP 接收 SQL。同一事务内执行 SQL 和推进 user_version。
若未来 contracts/schema.sql 已含新索引，迁移使用 `CREATE INDEX IF NOT EXISTS`，兼容新库与旧库。
**C3 v2 尚未并入本分支，本包没有偷偷应用它的索引或契约。**
无版本的历史库须先备份、核对 schema 和数据，再单独批准接管方案；不要靠手改 user_version 绕过检查。

## 服务器前置条件

1. 一台有公网 IPv4 的 Linux 云主机，支持 systemd，具有持久本地磁盘。
2. 获授权的 SSH 账号及 sudo 权限；不在仓库或聊天中保存密码/私钥。
3. Node.js 24+（建议与本地验收一致的版本）、npm、git、curl、sqlite3 命令行用于运维备份。
4. 至少满足构建需要的内存和磁盘空间，安装与构建阶段可访问 npm registry。
5. 云安全组和主机防火墙都允许 TCP 18080；保留现有 SSH 放行规则。

服务器发行版和供应商未知，因此不自动运行安装命令或替换防火墙策略。
按发行版安装并校验官方 Node.js，确认 `node --version` 和 `command -v node`。
服务模板使用 `/usr/bin/node`；若实际位置不同，应修改 ExecStart 为该绝对路径，不依赖交互式 shell 或 nvm 初始化。

## 构建与发布

推荐将代码与数据库分离：代码 `/opt/zhihu-hackathon/current`，数据库 `/var/lib/zhihu-hackathon/app.sqlite`。
以下以专用服务用户 `zhihu` 为例（先检查是否存在，勿覆盖现有用户）：

```bash
id zhihu || sudo useradd --system --home /var/lib/zhihu-hackathon --shell /usr/sbin/nologin zhihu
sudo install -d -o zhihu -g zhihu -m 0750 /var/lib/zhihu-hackathon
```

用部署账号将已审查提交检出到 `/opt/zhihu-hackathon/current`，服务用户仅需读取代码。
不要上传本机 node_modules、数据库或 .env；在服务器同一 OS/架构重新安装并构建。
C2 验收可明确选择 c2 的提交；正式发布由 a 合并后选择批准的 main/tag，不在服务器合并分支。

```bash
cd /opt/zhihu-hackathon/current
git rev-parse HEAD
node --version
npm ci
npm run lint
npm run test
npm run build
sudo install -d -o zhihu -g zhihu -m 0750 .next/cache
```

构建需要 devDependencies；不要在构建前用 `npm ci --omit=dev`。
保留 contracts/schema.sql 与项目工作目录；本配置使用 next start，不是静态导出。

## 服务端环境

使用 `sudoedit /etc/zhihu-hackathon.env` 创建，仅填写实际配置，不提交该文件：

```dotenv
NODE_ENV=production
PORT=18080
DATABASE_PATH=/var/lib/zhihu-hackathon/app.sqlite
```

以后需要知乎密钥时只在该服务器环境文件填写原有 ZHIHU 变量，不加 NEXT_PUBLIC_ 前缀，不在 next.config.ts 的 env 中导出。

```bash
sudo chown root:root /etc/zhihu-hackathon.env
sudo chmod 600 /etc/zhihu-hackathon.env
sudo install -m 0644 deploy/zhihu-hackathon.service /etc/systemd/system/zhihu-hackathon.service
sudo systemd-analyze verify /etc/systemd/system/zhihu-hackathon.service
sudo systemctl daemon-reload
sudo systemctl enable --now zhihu-hackathon
sudo systemctl status zhihu-hackathon --no-pager
curl --fail http://127.0.0.1:18080/api/health
```

服务 `Restart=always`、5 秒后重启，开机自启；数据库目录独立持久化。
ProtectSystem 限制服务写入范围，只允许状态目录与 Next 缓存目录。不要为了启动成功让进程以 root 运行。

## 防火墙与外网验收

在云控制台安全组放行 TCP 18080，然后检查主机防火墙。
若服务器已采用 UFW，可执行 `sudo ufw allow 18080/tcp`；若采用 firewalld，使用
`sudo firewall-cmd --permanent --add-port=18080/tcp` 和 `sudo firewall-cmd --reload`。
只使用服务器实际启用的防火墙，不同时安装两套，不关闭整个防火墙；启用任何防火墙前先确保 SSH 规则保留。

公网格式：`http://<服务器公网IPv4>:18080/`。
**必须在服务器之外的网络**（如另一台电脑或手机蜂窝网络）实际运行并记录时间、HTTP 状态和健康体：

```bash
curl --fail --connect-timeout 10 --max-time 20 -i http://<公网IPv4>:18080/
curl --fail --connect-timeout 10 --max-time 20 -i http://<公网IPv4>:18080/api/health
```

本机 127.0.0.1、自身公网 IP 回环或 systemctl active 均不能替代外网验收。

## 重启、午夜与恢复

```bash
sudo systemctl restart zhihu-hackathon
sudo systemctl is-active zhihu-hackathon
sudo journalctl -u zhihu-hackathon -n 100 --no-pager
```

重启后再次从外网检查 `/` 和 `/api/health`，并确认已有测试记录仍在。
另安排有服务器维护权限的人执行一次主机重启，验证 enable 后恢复运行；不可把应用重启等同于机器重启。
模拟进程故障可在获准维护窗口执行 `sudo systemctl kill --signal=SIGKILL --kill-whom=main zhihu-hackathon`，
等候恢复后核验外网健康与 journal 的重启记录。该步骤不要在真实用户写入时临时尝试。

每天上海时间 24:00（次日 00:00）从外部监测机器重复检查，保存带 Asia/Shanghai 时间的输出。
自动重启配置不能代替午夜实测；本次暂无服务器，午夜可用性、进程托管和重启恢复均为 NOT RUN。

上线前备份并进行恢复演练。WAL 模式不要只复制正在写入的主数据库文件：

```bash
sudo install -d -o zhihu -g zhihu -m 0750 /var/backups/zhihu-hackathon
sudo -u zhihu sqlite3 /var/lib/zhihu-hackathon/app.sqlite ".backup '/var/backups/zhihu-hackathon/pre-release.sqlite'"
```

备份文件名按日期/提交区分，不覆盖唯一备份。恢复时先停服务、保存当前故障库及 WAL/SHM，
将备份恢复到新的文件名并用 sqlite3 `PRAGMA integrity_check` 验证，然后修改 DATABASE_PATH 指向恢复副本。
校验权限后启动服务，重新做外网检查；不要直接覆盖仍被进程打开的数据库。
代码回滚选取与数据库版本兼容的已审查提交；遇到“数据库版本比代码新”时停止，不能降低 user_version 强行启动。

参考：[Next.js 安装与脚本](https://nextjs.org/docs/app/getting-started/installation)、
[Node.js SQLite](https://nodejs.org/api/sqlite.html)。
