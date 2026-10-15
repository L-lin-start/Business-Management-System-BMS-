/**
 * 合同件数与自动生成项目的规则。
 *
 * 规则（对齐 PRD 4.3 / 第六章）：
 *   - 合同编号由人工填写；合同录入后按「件数」自动生成项目，项目编号为 `合同号-序号`（如 HT-2026-001-1）。
 *   - 项目名称默认为「合同类型 + 项目-序号」，例如软件著作权合同 4 件 → 软著项目-1 ~ 软著项目-4。
 *   - 件数只影响创建合同时的生成结果，之后修改件数不会自动增删已有项目。
 */

export const DEFAULT_ITEM_COUNT = 1;
export const MIN_ITEM_COUNT = 1;
/** 单次同步生成项目的上限，避免误填大数把接口拖死；超出请分批或改为异步任务。 */
export const MAX_ITEM_COUNT = 500;

/** 把任意输入归一化为合法的件数；非法值回退为 1。 */
export function resolveItemCount(value: unknown): number {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed) || parsed < MIN_ITEM_COUNT) return DEFAULT_ITEM_COUNT;
  return Math.min(parsed, MAX_ITEM_COUNT);
}

/** 生成第 sequence 个项目的默认名称。 */
export function buildDefaultProjectName(contractType: string | null | undefined, sequence: number): string {
  const type = (contractType ?? '').trim();
  return type ? `${type}项目-${sequence}` : `项目-${sequence}`;
}
