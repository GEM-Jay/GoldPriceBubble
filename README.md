# GoldPrice

GoldPrice 是一个基于 Tauri 的 Windows 桌面金价监控客户端，提供实时行情、悬浮气泡、仓库持仓与盈亏管理、走势图、托盘、工单反馈和自动更新能力。

## 功能

- 实时金价与相关市场数据展示
- 管理窗口与气泡窗口联动
- 仓库、交易记录、成本与实时盈亏
- 今日、近 7 日、近 1 月等行情图表
- 气泡样式、字体、主题、盈亏展示配置
- 托盘、开机自启、客户端日志、自动更新

## 技术栈

- 前端：Vite、Vue 3、TDesign Vue Next、ECharts
- 桌面端：Tauri 1.x、Rust
- 服务端：Go、HTTP、SSE、COS/CDN

说明：图表库使用 npm 依赖 `echarts`，不要恢复旧的 `src/echarts.min.js`。

## 目录

```text
.
├── src/                         # 前端页面、样式和业务模块
├── src-tauri/                   # Tauri/Rust 后端与打包配置
├── remote-servers/              # 配套远程服务
├── docs/                        # 发布与更新说明
└── scripts/                     # 版本号等辅助脚本
```

关键文件：

- `src/manager-app.vue`：管理端 Vue 壳
- `src/manager.js`：管理端主控制器
- `src/bubble.js`：气泡窗口渲染与事件处理
- `src/datasource.js`：字段表、显示名、币种、更新相关数据能力
- `src/runtime.js`：Tauri API、日志、配置等运行时封装
- `src/warehouse.js`：仓库与盈亏逻辑
- `src-tauri/src/main.rs`：桌面端窗口、托盘、日志、更新器命令
- `src-tauri/tauri.conf.json`：窗口和更新器配置

## 环境要求

- Windows 10 / 11
- Node.js 16+
- Rust 1.70+
- WebView2 Runtime

## 快速开始

安装依赖：

```bash
npm install
```

复制本地配置：

```powershell
Copy-Item src\config.example.js src\config.js
```

`src/config.js` 需要保持和模板同结构：

```js
export const SERVER_URL = 'https://api.example.com';
export const COS_CDN = 'https://cdn.example.com';
export const TICKET_SERVER_URL = 'https://ticket.example.com';
```

配置说明：

- `SERVER_URL`：主行情服务，客户端会请求 `${SERVER_URL}/fields` 和 `${SERVER_URL}/stream`
- `COS_CDN`：K 线 JSON CDN 地址
- `TICKET_SERVER_URL`：工单服务地址

## 常用命令

```bash
# 仅启动 Vite 前端
npm run frontend:dev

# 启动完整 Tauri 桌面应用
npm run dev

# 构建前端资源
npm run frontend:build

# 构建桌面应用
npm run build

# 构建 Windows x64 目标
npm run build:windows:x64

# 构建发布包
npm run build:release
npm run build:release:windows:x64

# 同步版本号
npm run setver -- 2.3.2

# 生成 updater 签名密钥
npm run updater:keygen
```

Go 服务常用命令：

```bash
cd remote-servers/<service>
go test ./...
go run .
```

Rust 后端测试：

```bash
cd src-tauri
cargo test
```

## 远程服务

`remote-servers/` 当前主要服务：

- `app-control`：Tauri updater 元数据、legacy 版本/消息/心跳和轻量控制接口
- `market-stream`：`/fields`、`/stream`、行情聚合、K 线生成
- `ticket-center`：工单提交与管理

更多说明见 [remote-servers/README.md](remote-servers/README.md)。

## 开发说明

- 前端保持 Vite 原生 ES module 结构
- `manager-app.vue` 负责启动 `manager.js`
- `bubble-app.js` 负责启动 `bubble.js`
- Tauri API 访问应集中在 `runtime.js`
- 客户端业务日志应走 `append_client_log`

关键链路：

- 行情启动：`/fields` -> `/stream` -> manager snapshot -> bubble render
- 气泡配置：manager 保存 localStorage -> `config-update` / `bubble-refresh-now` -> bubble reload
- 图表数据：通过 Tauri `httpFetch` 拉取 CDN K 线数据

## 冒烟测试

当前没有完整前端自动化测试。修改后至少建议执行：

```bash
npm run frontend:build
```

涉及桌面端行为时继续执行：

```bash
npm run dev
```

重点检查：

- 管理窗口启动、导航、主题、窗口控制
- `/fields` 拉取、`/stream` 首帧和重连
- 气泡显示、resize、配置变化、盈亏展示
- 仓库买卖、调仓、实时盈亏
- 图表范围切换、刷新、主题联动
- Tauri updater 更新弹窗、绿色更新提示、下载和安装入口
- 工单提交与客户端日志附带

## 日志与排障

客户端日志默认写入：

```text
%APPDATA%\com.lucas.goldprice\logs\app.log
```

常见排查点：

- 无法运行 `npm run dev`：检查 Rust/Cargo 与 WebView2
- 管理端无数据：检查 `src/config.js`、`${SERVER_URL}/fields`、`${SERVER_URL}/stream`
- 气泡不更新：检查 `prices-snapshot`、`config-update`、`bubble-refresh-now`
- 图表无数据：检查 `${COS_CDN}` 下的 K 线 JSON 是否可访问

## 更新与发布

- 版本建议通过 `npm run setver -- <version>` 统一更新
- 更新器与打包配置位于 `src-tauri/tauri.conf.json`
- 客户端更新链路使用 Tauri 官方 updater
- 稳定通道元数据地址：`https://api.zargo.top/updates/stable/latest.json`
- 更新说明只读取 `latest.json` 的 `notes` 字段，并在更新弹窗中展示
- 新客户端不再请求独立公告接口；`/announcements/latest` 和 `/releases/latest` 已删除
- legacy 接口仅用于老客户端兼容：`/version`、`/message`、`/ping`、`/api/v2/update`、`/api/v2/message`、`/api/v2/heartbeat`

发布产物托管在腾讯云 COS，命名规则固定为：

```text
GoldPrice_{version}_x64-setup.exe
GoldPrice_{version}_x64-setup.nsis.zip
GoldPrice_{version}_x64-setup.nsis.zip.sig
```

每次发版需要上传安装包 exe、updater zip 和 zip.sig，并把 `.zip.sig` 文件全文填入 `latest.json` 的 `platforms.windows-x86_64.signature`。注意这里填的是签名文本，不是 `.sig` 文件 URL。

推荐发布命令：

```powershell
npm run setver -- <version>
$env:TAURI_PRIVATE_KEY="$env:USERPROFILE\.tauri\goldprice-updater.key"
$env:TAURI_KEY_PASSWORD=""
npm run build:release:windows:x64
```

发布说明见 [docs/updater-release.md](docs/updater-release.md)。

## 安全

不要提交：

- `src/config.js`
- 真实服务地址、密钥、签名文件
- 构建产物、安装包、日志
- `node_modules/`、`dist/`、`src-tauri/target/`

## License

MIT
