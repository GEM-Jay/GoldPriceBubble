# GoldPrice 更新发布流程

## 一次性准备

1. 生成并妥善保存 updater 私钥。

```powershell
npm run updater:keygen
```

2. 私钥默认保存在：

```text
C:\Users\<你的用户名>\.tauri\goldprice-updater.key
```

3. 构建发布包前，必须设置环境变量：

```powershell
$env:TAURI_PRIVATE_KEY="$HOME/.tauri/goldprice-updater.key"
```

如后续为私钥增加密码，再额外设置：

```powershell
$env:TAURI_KEY_PASSWORD="你的密码"
```

## 发布步骤

1. 更新版本号。
   - 同步修改 [package.json](/D:/Workspaces/GoldPrice/package.json) 与 [src-tauri/tauri.conf.json](/D:/Workspaces/GoldPrice/src-tauri/tauri.conf.json)。

2. 生成正式更新包。

```powershell
npm run build:release:windows:x64
```

3. 构建完成后，发布目录中会产出：
   - 常规安装器：`*.exe`
   - updater 包：`*.zip`
   - updater 签名：`*.zip.sig`

4. 将安装器、updater zip、zip.sig 上传到正式更新源。
   - 当前稳定通道配置为：
   - `https://api.zargo.top/updates/stable/latest.json`

5. 生成并发布 `latest.json`。
   - 结构参考 [updater-latest.example.json](/D:/Workspaces/GoldPrice/docs/updater-latest.example.json)
   - Windows 正式更新建议统一使用 NSIS 对应的 `*.zip`
   - 更新公告直接写入 `notes`，客户端会在更新弹窗中展示。

## 服务端要求

### 1. Tauri updater 元数据

客户端会直接请求：

```text
GET https://api.zargo.top/updates/stable/latest.json
```

服务端返回静态 JSON，至少包含：

- `version`
- `notes`
- `pub_date`
- `platforms.windows-x86_64.url`
- `platforms.windows-x86_64.signature`

## 兼容说明

- 新版客户端已经切到 Tauri 官方 updater。
- 旧版 `/version` 与 `/message` 可以短期保留，用于老版本兼容。
- 新版本客户端不再依赖自定义安装包下载命令和本地待安装文件路径。
- 新版本客户端不再请求独立公告接口，更新公告只读取 `latest.json` 的 `notes`。
