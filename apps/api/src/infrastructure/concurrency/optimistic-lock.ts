import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/** 两个用户基于同一版本编辑时的时间戳容差（毫秒）：极短时间内先后提交的不算冲突 */
const STALE_VERSION_TOLERANCE_MS = 2000;

export const VERSION_CONFLICT_MESSAGE = '该记录已被他人更新，请刷新后重试';

type VersionedModel = {
  id: string;
  version: number;
  updatedAt: Date;
};

type VersionedDelegate<T> = {
  findUnique(args: { where: { id: string } }): Promise<T | null>;
  updateMany(args: {
    where: { id: string; version: number };
    data: Record<string, unknown>;
  }): Promise<{ count: number }>;
  findUniqueOrThrow(args: { where: { id: string }; include?: unknown }): Promise<T>;
};

/**
 * 乐观锁更新：客户端必须带上自己读到的 version。
 *
 * 目的（PRD 非功能需求）：多用户同时编辑同一记录时避免互相覆盖。
 * 做法：以 `where: { id, version }` 做条件更新，影响行数为 0 说明版本已过期，抛 409。
 *
 * 细节：若期间已有他人更新，但**本次请求提交的内容与当前数据完全一致**（同一个用户重复提交、
 * 或两人提交了同样的值），则视为幂等，直接返回当前数据，不打扰用户。
 */
export async function updateWithVersionCheck<T extends VersionedModel, R>(options: {
  delegate: VersionedDelegate<T>;
  id: string;
  /** 客户端读到的版本号 */
  expectedVersion: number;
  data: Record<string, unknown>;
  include?: unknown;
  /** 用更新后的数据进行持久化之外的后续处理（如读取 include 结果） */
  fetchUpdated: (id: string) => Promise<R>;
  /** 判断提交内容是否与当前数据一致（用于幂等放行） */
  isSameSubmission?: (current: T) => boolean;
}): Promise<R> {
  const result = await options.delegate.updateMany({
    where: { id: options.id, version: options.expectedVersion },
    data: { ...options.data, version: { increment: 1 } },
  });

  if (result.count > 0) return options.fetchUpdated(options.id);

  const current = await options.delegate.findUnique({ where: { id: options.id } });
  if (!current) throw new ConflictException('记录不存在或已被删除');

  // 版本不一致但内容一致 → 幂等放行
  if (options.isSameSubmission?.(current)) return options.fetchUpdated(options.id);

  throw new ConflictException(VERSION_CONFLICT_MESSAGE);
}

/**
 * 读取可编辑记录时校验版本：版本过期且超出容差时间，直接拒绝，避免读到脏数据后再写。
 * 返回 null 表示需要走正常更新流程（版本一致或属于同一轮快速提交）。
 */
export function detectStaleVersion(
  record: VersionedModel,
  expectedVersion: number | undefined,
): { stale: boolean } {
  if (expectedVersion === undefined) return { stale: false };
  if (record.version === expectedVersion) return { stale: false };

  // 版本不一致：若记录刚刚被改过（同一用户在极短时间内重试），放行由条件更新做最终判定
  const recentlyUpdated = Date.now() - record.updatedAt.getTime() < STALE_VERSION_TOLERANCE_MS;
  return { stale: !recentlyUpdated };
}

/** 判断对象是否包含给定键（用于幂等比较） */
export function hasSameValues(
  current: Record<string, unknown>,
  submission: Record<string, unknown>,
  keys: string[],
): boolean {
  return keys.every((key) => {
    if (!(key in submission)) return true;
    const left: unknown = current[key];
    const right: unknown = submission[key];
    if (left instanceof Prisma.Decimal || right instanceof Prisma.Decimal) {
      return Number(left) === Number(right);
    }
    if (left instanceof Date || right instanceof Date) {
      return new Date(String(left)).getTime() === new Date(String(right)).getTime();
    }
    return left === right;
  });
}
