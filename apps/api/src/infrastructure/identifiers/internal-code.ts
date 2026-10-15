import { randomUUID } from 'node:crypto';

/**
 * 生成仅供系统内部使用的稳定编码。
 * 编码不展示给普通用户，也不作为业务编号使用；它只承担数据库唯一关联和流程/权限匹配。
 */
export function generateInternalCode(prefix: string, lowerCase = false): string {
  const suffix = `${Date.now().toString(36)}_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
  const value = `${prefix}_${suffix}`;
  return lowerCase ? value.toLowerCase() : value.toUpperCase();
}
