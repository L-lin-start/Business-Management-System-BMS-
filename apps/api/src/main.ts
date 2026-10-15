import 'reflect-metadata';

import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

/** 开发环境下前端 dev server 的地址；生产必须通过 CORS_ORIGINS 显式配置。 */
const DEFAULT_CORS_ORIGINS = 'http://localhost:5173';

/**
 * 解析允许跨域的来源白名单。
 *
 * 此前这里硬编码 `['http://localhost:5173']`，生产域名不在白名单里，
 * 前端所有接口调用都会被浏览器拦掉，而服务端日志看不出任何异常
 * （浏览器根本不会把请求发出去）。
 *
 * 生产推荐做法是**同源部署** —— 由 IIS 把 `/api` 反向代理到本服务
 * （前端所有请求都是相对路径 `/api/...`），此时浏览器的同源策略天然满足，
 * 不需要任何 CORS 配置。只有在前后端确实不同域时才需要设置 CORS_ORIGINS。
 */
function resolveCorsOrigins(): string[] {
  const raw = process.env.CORS_ORIGINS?.trim() || DEFAULT_CORS_ORIGINS;
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function warnIfCorsMisconfigured(origins: string[], isProduction: boolean) {
  if (!isProduction) return;

  if (!process.env.CORS_ORIGINS?.trim()) {
    console.warn(
      '[CORS] NODE_ENV=production 但未设置 CORS_ORIGINS，当前仅允许 http://localhost:5173。\n' +
        '       若采用 IIS 同源反代（推荐），无需处理；\n' +
        '       若前端与后端不同域，必须设置 CORS_ORIGINS 为真实前端地址，否则浏览器会拦掉所有接口请求。',
    );
  }

  // 带 credentials 时通配来源是无效配置：浏览器会直接拒绝响应，且服务端不会报错。
  if (origins.includes('*')) {
    throw new Error(
      'CORS_ORIGINS 不允许使用通配符 "*"：本服务启用了 credentials（携带令牌），' +
        '浏览器会拒绝带凭据的通配来源响应。请逐个列出真实来源，用逗号分隔。',
    );
  }
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  const corsOrigins = resolveCorsOrigins();
  warnIfCorsMisconfigured(corsOrigins, process.env.NODE_ENV === 'production');

  app.enableCors({
    origin: corsOrigins,
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  const port = Number(process.env.API_PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
  console.log(`BMS API is running at http://localhost:${port}`);
}

void bootstrap();
