import { ConfigService } from '@nestjs/config';

/** 生产环境密钥的最小长度。低于此长度直接拒绝启动。 */
const MIN_PRODUCTION_SECRET_LENGTH = 32;

/**
 * 解析并**校验** JWT 密钥。
 *
 * ## 为什么取不到就必须抛错，而不是给一个默认值
 *
 * 密钥决定令牌能不能被伪造。如果兜底成源码里的固定字符串（此前的写法是
 * `?? 'local-development-secret'`），那么任何读过这份仓库的人都能自签一个
 * `isSystemAdmin` 令牌，直接拿到全部权限。
 *
 * 更糟的是：**服务会照常启动，没有任何报错**。这类问题在上线后极难被发现 ——
 * 日志干净、健康检查正常、功能一切可用，只是任何人都能当管理员。
 *
 * 所以这里宁可让服务**启动失败**，也不要静默地不安全。启动即失败是能被立刻
 * 看见的，静默的弱密钥不能。
 *
 * ## 触发场景
 *
 * 1. 生产环境根本没配 `JWT_SECRET`，或配成了空串；
 * 2. `.env` 没被加载 —— 本项目实测发现：`@nestjs/config` 本身按 `process.cwd()`
 *    找 `.env`，但 **Prisma Client 会额外加载 schema 旁的 `apps/api/.env`**
 *    （生成的客户端里写死了 `schemaEnvPath`），所以即使工作目录不对，
 *    `.env` 通常也仍然生效。反过来说，若部署时重新执行了 `prisma generate`、
 *    或 `node_modules` 布局与生成时不同，这个路径可能失效。
 *
 * 因此报错信息只提示"检查配置与 `.env` 是否真的被加载"，不把原因武断地
 * 归到工作目录上。
 */
export function resolveJwtSecret(configService: ConfigService): string {
  const secret = configService.get<string>('JWT_SECRET')?.trim();
  const isProduction = configService.get<string>('NODE_ENV')?.trim() === 'production';

  if (!secret) {
    throw new Error(
      [
        '缺少 JWT_SECRET 环境变量，服务拒绝启动。',
        '',
        '为什么必须失败：JWT 密钥决定令牌能否被伪造。若使用兜底默认值，',
        '任何读过源码的人都能自签一个系统管理员令牌，而服务不会有任何异常表现。',
        '',
        '请检查以下两点：',
        '  1) apps/api/.env 是否配置了 JWT_SECRET（且不是空值）；',
        '  2) 服务启动时该 .env 是否真的被加载 ——',
        '     若启动日志里其它配置也一起变空（如 BMS_DATABASE_ENABLED），',
        '     说明 .env 没读到，需检查部署时的 node_modules 布局与 prisma generate 结果。',
        '',
        '生成一个足够长的随机密钥：',
        '  node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"',
      ].join('\n'),
    );
  }

  if (isProduction && secret.length < MIN_PRODUCTION_SECRET_LENGTH) {
    throw new Error(
      [
        `生产环境的 JWT_SECRET 过短（当前 ${secret.length} 字符，要求至少 ${MIN_PRODUCTION_SECRET_LENGTH} 字符），服务拒绝启动。`,
        '',
        '开发用的短密钥不应带到生产：密钥长度直接决定暴力破解的成本。',
        '请重新生成后再启动：',
        '  node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"',
      ].join('\n'),
    );
  }

  return secret;
}
