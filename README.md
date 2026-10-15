# 业务管理系统

这是业务管理系统的本地开发工作区。第一阶段先建立可运行的前后端骨架、统一开发约定和核心业务扩展边界，暂不连接公司阿里云服务器。

## 工作区结构

```text
apps/web       Vue 3 前端
apps/api       NestJS 后端
packages/      前后端共享类型与通用能力
storage/       本地开发附件目录
```

## 本地运行

需要 Node.js 20+ 和 pnpm 9+。

```powershell
pnpm install
pnpm dev:api
pnpm dev:web
```

前端默认地址为 `http://localhost:5173`，后端健康检查为 `http://localhost:3000/api/health`。当前本地环境已配置 PostgreSQL 开发库，启动后可直接使用管理员登录和业务页面。

## 数据库开关

数据库模型位于 `apps/api/prisma/schema.prisma`。本地开发默认不连接数据库；获得本地 PostgreSQL 连接凭据后，复制 `.env.example` 为 `apps/api/.env`，配置 `DATABASE_URL`、`SHADOW_DATABASE_URL` 并将 `BMS_DATABASE_ENABLED` 改为 `true`，再执行：

```powershell
pnpm --filter @bms/api db:validate
pnpm --filter @bms/api db:generate
pnpm --filter @bms/api db:migrate:dev
pnpm --filter @bms/api db:seed
```

不要把真实密码、AccessKey 或生产连接字符串提交到仓库。

## 当前边界

- 不连接生产服务器、生产数据库或公司现有系统。
- 不在仓库中保存真实密码、AccessKey 或数据库连接凭据。
- 生产部署方式将在取得阿里云 Windows 服务器只读环境信息后确认。
