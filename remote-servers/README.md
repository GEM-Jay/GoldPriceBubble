# Remote Services

当前应使用的服务目录：

- `app-control`
  - 应用控制面服务
  - 负责 `/version`、`/message`、`/ping` 与轻量统计
  - `update.json` 只维护最新版本号，不托管安装包下载地址
  - 客户端按 `https://downloads.example.com/GoldPrice_{version}_x64-setup.exe` 规则自行拼接下载链接

- `market-stream`
  - 行情流服务
  - 负责上游行情抓取、`/stream`、`/fields`、K 线生成与 COS 推送

后续开发、部署、查阅请以 `app-control` 和 `market-stream` 为准。
