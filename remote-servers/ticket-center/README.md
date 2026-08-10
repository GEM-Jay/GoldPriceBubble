# Ticket Center

独立工单系统，负责客户端工单提交、附件保存、管理员后台、状态处理与回复。

## 运行

```bash
docker compose up -d --build
```

默认端口：`8082`

重要环境变量：

- `DATABASE_URL`：PostgreSQL 连接串
- `DATA_DIR`：图片和日志附件目录
- `ADMIN_USERNAME`：初始管理员用户名
- `ADMIN_PASSWORD`：初始管理员密码
- `ADMIN_NAME`：管理员展示名

## 客户端接口

- `POST /api/tickets`
- `GET /api/client/tickets?install_id=...`
- `GET /api/client/tickets/{id}/messages?install_id=...`

图片最多 3 张，单张最大 1.5MB；工单内容最多 400 字。

## 管理后台

打开 `/admin/` 登录后处理工单。
