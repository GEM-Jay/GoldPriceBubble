# GoldPrice - Tauri 版本

## 项目简介

这是从Electron迁移到Tauri的GoldPrice金价监控桌面应用。

### 迁移改进

- ✅ **体积大幅减小**: 从 ~100MB 减少到 ~15MB
- ✅ **性能提升**: 使用Rust后端，更快的启动速度
- ✅ **内存占用降低**: Tauri比Electron更轻量
- ✅ **安全性增强**: Tauri的安全模型更严格
- ✅ **完整功能保留**: 所有原有功能100%保留

### 主要功能

- 🪟 **双窗口系统**: 管理界面 + 透明气泡浮窗
- 📊 **实时金价**: 多源金价数据监控
- 🏦 **仓库管理**: 黄金交易记录与盈亏计算
- 🎨 **主题定制**: 亮色/暗色主题，多种配色方案
- 💰 **盈亏追踪**: 实时显示仓位盈亏
- 🖥️ **系统托盘**: 便捷的快速操作
- 🚀 **开机自启**: 支持Windows自动启动
- 💾 **数据备份**: 配置导入导出功能

## 开发

### 环境要求

- Node.js 16+
- Rust 1.70+
- Windows 10/11

### 安装依赖

```bash
npm install
```

### 配置 API 地址

首次开发前需要配置 API 地址：

```bash
# 复制配置文件模板
cp src/config.example.js src/config.js

# 编辑 src/config.js，修改为你的 API 地址
# const DEFAULT_API_URL = 'http://your-api-server.com:8081/api/latest/all';
```

**注意**: `src/config.js` 文件已在 `.gitignore` 中忽略，不会被提交到 Git，以保护你的服务器地址隐私。

### 开发模式

```bash
npm run dev
```

### 构建发布版

```bash
# Windows
npm run build:win

# 或通用构建
npm run build
```

构建完成后，安装包位于 `src-tauri/target/release/bundle/` 目录。

## 技术栈

### 前端
- HTML5 / CSS3 / JavaScript (Vanilla)
- LocalStorage (数据持久化)
- Fetch API (数据获取)

### 后端
- Rust
- Tauri 1.5
- auto-launch (开机自启)
- window-shadows (窗口阴影)

## 项目结构

```
tauri/
├── src/                    # 前端文件
│   ├── manager.html       # 管理界面
│   ├── manager.js
│   ├── manager.css
│   ├── bubble.html        # 气泡浮窗
│   ├── bubble.js
│   ├── bubble.css
│   └── warehouse.js       # 仓库管理模块
├── src-tauri/             # Rust后端
│   ├── src/
│   │   └── main.rs        # 主程序
│   ├── icons/             # 应用图标
│   ├── Cargo.toml         # Rust依赖
│   └── tauri.conf.json    # Tauri配置
└── package.json
```

## 与Electron版本的差异

### API变更

| Electron | Tauri |
|----------|-------|
| `window.ipc.xxx()` | `invoke('xxx')` |
| `ipcRenderer.on()` | `listen('event')` |
| `ipcRenderer.send()` | `invoke()` / `emit()` |
| preload.js | 不需要 (直接使用@tauri-apps/api) |

### 配置文件

- Electron: `package.json` (electron-builder配置)
- Tauri: `tauri.conf.json` (窗口、托盘、构建配置)

## 已测试功能

- ✅ 应用启动
- ✅ 管理窗口显示
- ✅ 气泡窗口显示
- ✅ 系统托盘
- ✅ 窗口拖动
- ✅ 数据获取
- ✅ LocalStorage持久化
- ✅ 主题切换
- ✅ 仓库管理
- ✅ 数据导入导出
- ✅ 开机自启设置

## 常见问题

### 1. 透明窗口不生效？

确保Windows启用了"透明效果"（设置 → 个性化 → 颜色 → 透明效果）

### 2. 开发模式端口冲突？

Tauri使用随机端口，不会有冲突。如果遇到问题，尝试重启开发服务器。

### 3. 构建失败？

- 确保Rust已正确安装：`rustc --version`
- 更新依赖：`cargo update`
- 清除缓存：`cargo clean`

## 作者

© 2025 Lucas Lee

## 许可证

MIT

