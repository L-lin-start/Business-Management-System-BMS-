/**
 * 纯日期（YYYY-MM-DD）的时区安全解析与格式化。
 *
 * 背景：`new Date('2026-09-01')` 按 **UTC 午夜** 解析。在 UTC+8 环境下它是本地 08:00，
 * 若再经过 `setHours(0,0,0,0)` 或按本地时区格式化，就会变成 8 月 31 日 —— 日期整整差一天。
 * 日期类字段（签约日、法定截止日、发生日期等）在业务上都是"日历日"而非时间点，
 * 因此统一按**本地当天零点**存取。
 *
 * 用法：
 *   - 写入：`parseCalendarDate('2026-09-01')` → 本地 2026-09-01 00:00
 *   - 读出展示：`formatCalendarDate(date)` → '2026-09-01'（不能用 toISOString）
 */

const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * 解析日期输入为本地零点。
 * - 'YYYY-MM-DD' → 本地当天零点
 * - 其它合法日期串（含时间）→ 原样解析
 * - 空值 → null
 * - 非法值 → 抛错（避免把 Invalid Date 写进库）
 */
export function parseCalendarDate(value: string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;

  const dateOnly = DATE_ONLY_PATTERN.exec(trimmed);
  if (dateOnly) {
    return new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]));
  }

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) throw new Error(`无法解析日期：${trimmed}`);
  return parsed;
}

/** 按本地时区格式化为 YYYY-MM-DD */
export function formatCalendarDate(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** 本地当天零点 */
export function startOfLocalDay(value: Date = new Date()): Date {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

/** 按天偏移 */
export function addCalendarDays(value: Date, days: number): Date {
  const date = new Date(value);
  date.setDate(date.getDate() + days);
  return date;
}
