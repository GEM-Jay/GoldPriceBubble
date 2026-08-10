# Remote Services

当前应使用的服务目录：

- `app-control`
  - 应用控制面服务
  - 负责 `/message`、`/ping` 与轻量统计
  - `update.json` 与 `/version`、`/api/v2/update` 已废弃，仅保留给历史代码兼容，不参与当前发版
  - 当前客户端发布只使用 Tauri updater 的 `latest.json`

- `market-stream`
  - 行情流服务
  - 负责上游行情抓取、`/stream`、`/fields`、K 线生成与 COS 推送

后续开发、部署、查阅请以 `app-control` 和 `market-stream` 为准。
